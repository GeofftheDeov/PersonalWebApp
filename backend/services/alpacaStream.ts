/**
 * Live Alpaca wallets for the admin dashboard.
 *
 * A "wallet" is one Alpaca account the admin can watch:
 *   cloudclaw — the Cloud-Claw agent's paper account (ALPACA_API_KEY/SECRET env)
 *   paper     — the admin's own paper keys from the Profile page vault
 *   live      — the admin's own live keys from the Profile page vault
 *
 * For each wallet somebody is watching, the server holds Alpaca's two
 * websockets — trade_updates on the trading stream, and trade prints for the
 * held symbols on the market-data stream — and keeps one in-memory picture of
 * account + positions + orders. Price prints revalue positions and equity in
 * between REST resyncs; fills trigger an immediate resync. Every browser tab on
 * that wallet shares the one set of upstream connections (Alpaca allows a
 * single market-data connection per key), and the credentials never leave the
 * server. The page receives snapshots over SSE (routes/adminRoutes.ts).
 */
import WebSocket from 'ws';

export type WalletId = 'cloudclaw' | 'paper' | 'live';
export const WALLET_IDS: WalletId[] = ['cloudclaw', 'paper', 'live'];

export interface AlpacaCreds { keyId: string; secret: string; live: boolean }

type LinkState = 'connecting' | 'live' | 'reconnecting' | 'idle' | 'error';

export interface WalletSnapshot {
    wallet: WalletId;
    live: boolean;
    account: Record<string, any> | null;
    positions: Record<string, any>[];
    orders: Record<string, any>[];
    /** Alpaca REST failure (e.g. rejected keys); the last good data is kept. */
    error: string | null;
    streams: {
        trading: { state: LinkState; message?: string };
        data: { state: LinkState; message?: string };
    };
    /** Last REST resync and last live price print (ISO). */
    syncedAt: string | null;
    tickAt: string | null;
}

// ── Endpoints ────────────────────────────────────────────────────────────────
// ALPACA_MOCK_URL points everything at a local stand-in (local testing only):
//   REST  {mock}/paper/v2 | {mock}/live/v2
//   WS    {mock}/paper/stream | {mock}/live/stream | {mock}/data/v2/<feed>
const DATA_FEED = process.env.ALPACA_DATA_FEED || 'iex'; // 'sip' needs a paid data plan

export function restBase(live: boolean): string {
    const mock = process.env.ALPACA_MOCK_URL;
    if (mock) return `${mock}/${live ? 'live' : 'paper'}/v2`;
    return live ? 'https://api.alpaca.markets/v2' : 'https://paper-api.alpaca.markets/v2';
}
function tradingStreamUrl(live: boolean): string {
    const mock = process.env.ALPACA_MOCK_URL;
    if (mock) return `${mock.replace(/^http/, 'ws')}/${live ? 'live' : 'paper'}/stream`;
    return live ? 'wss://api.alpaca.markets/stream' : 'wss://paper-api.alpaca.markets/stream';
}
function dataStreamUrl(): string {
    const mock = process.env.ALPACA_MOCK_URL;
    if (mock) return `${mock.replace(/^http/, 'ws')}/data/v2/${DATA_FEED}`;
    return `wss://stream.data.alpaca.markets/v2/${DATA_FEED}`;
}

export class AlpacaError extends Error {
    constructor(message: string, public status: number) { super(message); }
}

/** One authenticated REST call. Errors carry Alpaca's own message. */
export async function alpacaRest(creds: AlpacaCreds, urlPath: string, init?: RequestInit): Promise<any> {
    let r: globalThis.Response;
    try {
        r = await fetch(`${restBase(creds.live)}${urlPath}`, {
            ...init,
            headers: {
                'APCA-API-KEY-ID': creds.keyId,
                'APCA-API-SECRET-KEY': creds.secret,
                'Content-Type': 'application/json',
            },
            signal: init?.signal ?? AbortSignal.timeout(15_000),
        });
    } catch (err: any) {
        throw new AlpacaError(err?.name === 'TimeoutError' ? 'Alpaca did not answer within 15s' : `Alpaca unreachable: ${err.message}`, 502);
    }
    const text = await r.text();
    if (!r.ok) {
        let msg = text;
        try { msg = JSON.parse(text).message ?? text; } catch { /* plain text */ }
        if (r.status === 401 || r.status === 403) msg = `Alpaca rejected these keys (${msg || r.status})`;
        throw new AlpacaError(msg || `Alpaca error ${r.status}`, r.status);
    }
    return text ? JSON.parse(text) : null;
}

// ── One watched wallet ───────────────────────────────────────────────────────

const RESYNC_MS = 20_000;           // authoritative REST refresh while watched
const ERROR_RETRY_MS = 60_000;      // after a failed REST sync (e.g. bad keys)
const EMIT_EVERY_MS = 500;          // coalesce bursts of price prints
const IDLE_CLOSE_MS = 30_000;       // keep upstream open across page reloads
const num = (v: unknown) => { const n = parseFloat(String(v)); return Number.isFinite(n) ? n : NaN; };

class WalletStream {
    private listeners = new Set<(s: WalletSnapshot) => void>();
    private snap: WalletSnapshot;
    private tradingWs: WebSocket | null = null;
    private dataWs: WebSocket | null = null;
    private dataSymbols = new Set<string>();
    private dataAuthed = false;
    private resyncTimer: NodeJS.Timeout | null = null;
    private emitTimer: NodeJS.Timeout | null = null;
    private idleTimer: NodeJS.Timeout | null = null;
    private tradingRetry = 0;
    private dataRetry = 0;
    private syncing: Promise<void> | null = null;
    private stopped = true;

    constructor(readonly hubKey: string, readonly wallet: WalletId, private creds: AlpacaCreds, private onDispose: () => void) {
        this.snap = {
            wallet, live: creds.live, account: null, positions: [], orders: [], error: null,
            streams: { trading: { state: 'connecting' }, data: { state: 'idle' } },
            syncedAt: null, tickAt: null,
        };
    }

    subscribe(fn: (s: WalletSnapshot) => void): () => void {
        this.listeners.add(fn);
        if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null; }
        if (this.stopped) this.start();
        fn(this.snapshot());
        return () => {
            this.listeners.delete(fn);
            if (!this.listeners.size && !this.idleTimer) {
                this.idleTimer = setTimeout(() => this.stop(), IDLE_CLOSE_MS);
            }
        };
    }

    snapshot(): WalletSnapshot { return JSON.parse(JSON.stringify(this.snap)); }

    private start() {
        this.stopped = false;
        void this.resync();
        this.openTrading();
    }

    private stop() {
        this.stopped = true;
        if (this.resyncTimer) clearTimeout(this.resyncTimer);
        if (this.emitTimer) clearTimeout(this.emitTimer);
        this.resyncTimer = this.emitTimer = this.idleTimer = null;
        this.tradingWs?.removeAllListeners(); this.tradingWs?.terminate(); this.tradingWs = null;
        this.dataWs?.removeAllListeners(); this.dataWs?.terminate(); this.dataWs = null;
        this.onDispose();
    }

    private emitSoon() {
        if (this.emitTimer || this.stopped) return;
        this.emitTimer = setTimeout(() => {
            this.emitTimer = null;
            const s = this.snapshot();
            for (const fn of this.listeners) { try { fn(s); } catch { /* a dead SSE socket */ } }
        }, EMIT_EVERY_MS);
    }

    // ── REST: the source of truth ──────────────────────────────────────────
    resync(): Promise<void> {
        if (this.syncing) return this.syncing;
        this.syncing = (async () => {
            let nextIn = RESYNC_MS;
            try {
                const [account, positions, orders] = await Promise.all([
                    alpacaRest(this.creds, '/account'),
                    alpacaRest(this.creds, '/positions'),
                    alpacaRest(this.creds, '/orders?limit=25&status=all&direction=desc'),
                ]);
                this.snap.account = account;
                this.snap.positions = Array.isArray(positions) ? positions : [];
                this.snap.orders = Array.isArray(orders) ? orders : [];
                this.snap.error = null;
                this.snap.syncedAt = new Date().toISOString();
                this.syncDataSubscriptions();
            } catch (err: any) {
                this.snap.error = err.message;
                nextIn = ERROR_RETRY_MS;
            } finally {
                this.syncing = null;
                this.emitSoon();
                if (!this.stopped) {
                    if (this.resyncTimer) clearTimeout(this.resyncTimer);
                    this.resyncTimer = setTimeout(() => void this.resync(), nextIn);
                }
            }
        })();
        return this.syncing;
    }

    // ── Trading stream: order fills and cancels ────────────────────────────
    private openTrading() {
        if (this.stopped) return;
        this.snap.streams.trading = { state: this.tradingRetry ? 'reconnecting' : 'connecting' };
        const ws = new WebSocket(tradingStreamUrl(this.creds.live));
        this.tradingWs = ws;
        ws.on('open', () => ws.send(JSON.stringify({ action: 'auth', key: this.creds.keyId, secret: this.creds.secret })));
        ws.on('message', (raw) => {
            let msg: any;
            try { msg = JSON.parse(raw.toString()); } catch { return; }
            if (msg.stream === 'authorization') {
                if (msg.data?.status === 'authorized') {
                    ws.send(JSON.stringify({ action: 'listen', data: { streams: ['trade_updates'] } }));
                } else {
                    this.snap.streams.trading = { state: 'error', message: 'Alpaca rejected these keys on the trading stream' };
                    this.tradingRetry = 99; // do not hammer with bad keys; retried at the slow cadence
                    ws.close();
                    this.emitSoon();
                }
            } else if (msg.stream === 'listening') {
                this.tradingRetry = 0;
                this.snap.streams.trading = { state: 'live' };
                this.emitSoon();
            } else if (msg.stream === 'trade_updates') {
                this.onTradeUpdate(msg.data);
            }
        });
        ws.on('error', (err) => {
            if (this.snap.streams.trading.state !== 'error') this.snap.streams.trading = { state: 'reconnecting', message: err.message };
        });
        ws.on('close', () => {
            if (this.stopped || this.tradingWs !== ws) return;
            this.tradingWs = null;
            this.tradingRetry++;
            const delay = Math.min(60_000, 1000 * 2 ** Math.min(this.tradingRetry, 6));
            if (this.snap.streams.trading.state !== 'error') this.snap.streams.trading = { state: 'reconnecting' };
            this.emitSoon();
            setTimeout(() => this.openTrading(), delay);
        });
    }

    private onTradeUpdate(data: any) {
        const order = data?.order;
        if (order?.id) {
            const i = this.snap.orders.findIndex((o) => o.id === order.id);
            if (i === -1) this.snap.orders.unshift(order); else this.snap.orders[i] = order;
            this.snap.orders = this.snap.orders.slice(0, 25);
            this.emitSoon();
        }
        // A fill changes cash, quantities and possibly the held symbols.
        if (['fill', 'partial_fill', 'canceled', 'expired', 'replaced'].includes(data?.event)) void this.resync();
    }

    // ── Market-data stream: live prices for held symbols ───────────────────
    private wantedSymbols(): string[] {
        return this.snap.positions
            .filter((p) => (p.asset_class ?? 'us_equity') === 'us_equity')
            .map((p) => String(p.symbol));
    }

    private syncDataSubscriptions() {
        const want = new Set(this.wantedSymbols());
        if (!want.size) {
            if (this.dataWs) { this.dataWs.removeAllListeners(); this.dataWs.terminate(); this.dataWs = null; }
            this.dataSymbols.clear();
            this.snap.streams.data = { state: 'idle', message: 'No stock positions to stream' };
            return;
        }
        if (!this.dataWs) { this.openData(); return; }
        if (!this.dataAuthed) return; // subscribes on auth
        const add = [...want].filter((s) => !this.dataSymbols.has(s));
        const drop = [...this.dataSymbols].filter((s) => !want.has(s));
        if (add.length) this.dataWs.send(JSON.stringify({ action: 'subscribe', trades: add }));
        if (drop.length) this.dataWs.send(JSON.stringify({ action: 'unsubscribe', trades: drop }));
    }

    private openData() {
        if (this.stopped) return;
        this.dataAuthed = false;
        this.dataSymbols.clear();
        this.snap.streams.data = { state: this.dataRetry ? 'reconnecting' : 'connecting' };
        const ws = new WebSocket(dataStreamUrl());
        this.dataWs = ws;
        ws.on('message', (raw) => {
            let msgs: any;
            try { msgs = JSON.parse(raw.toString()); } catch { return; }
            for (const m of Array.isArray(msgs) ? msgs : [msgs]) {
                if (m.T === 'success' && m.msg === 'connected') {
                    ws.send(JSON.stringify({ action: 'auth', key: this.creds.keyId, secret: this.creds.secret }));
                } else if (m.T === 'success' && m.msg === 'authenticated') {
                    this.dataAuthed = true;
                    this.dataRetry = 0;
                    const syms = this.wantedSymbols();
                    if (syms.length) ws.send(JSON.stringify({ action: 'subscribe', trades: syms }));
                } else if (m.T === 'subscription') {
                    this.dataSymbols = new Set(m.trades ?? []);
                    this.snap.streams.data = { state: 'live', message: `${this.dataSymbols.size} symbol(s), ${DATA_FEED.toUpperCase()} feed` };
                    this.emitSoon();
                } else if (m.T === 't') {
                    this.onPrint(String(m.S), num(m.p), m.t);
                } else if (m.T === 'error') {
                    // 402 auth failed, 406 connection limit (another client on this key), 409 plan limits…
                    this.snap.streams.data = { state: 'error', message: `Market data: ${m.msg} (${m.code})` };
                    if (m.code === 402 || m.code === 406 || m.code === 409) this.dataRetry = 99;
                    this.emitSoon();
                }
            }
        });
        ws.on('error', (err) => {
            if (this.snap.streams.data.state !== 'error') this.snap.streams.data = { state: 'reconnecting', message: err.message };
        });
        ws.on('close', () => {
            if (this.stopped || this.dataWs !== ws) return;
            this.dataWs = null;
            this.dataAuthed = false;
            this.dataRetry++;
            if (this.snap.streams.data.state !== 'error') this.snap.streams.data = { state: 'reconnecting' };
            this.emitSoon();
            const delay = Math.min(60_000, 1000 * 2 ** Math.min(this.dataRetry, 6));
            setTimeout(() => { if (!this.dataWs && this.wantedSymbols().length) this.openData(); }, delay);
        });
    }

    /** Revalue one position, then equity, from a trade print. */
    private onPrint(symbol: string, price: number, at?: string) {
        if (!Number.isFinite(price)) return;
        const p = this.snap.positions.find((x) => x.symbol === symbol);
        if (!p) return;
        const qty = num(p.qty);
        const avg = num(p.avg_entry_price);
        const lastday = num(p.lastday_price);
        const signedQty = p.side === 'short' && qty > 0 ? -qty : qty;
        p.current_price = String(price);
        p.market_value = String(signedQty * price);
        if (Number.isFinite(avg)) {
            const cost = signedQty * avg;
            p.unrealized_pl = String(signedQty * price - cost);
            p.unrealized_plpc = String(cost ? (signedQty * price - cost) / Math.abs(cost) : 0);
        }
        if (Number.isFinite(lastday) && lastday) {
            p.change_today = String((price - lastday) / lastday);
            p.unrealized_intraday_pl = String(signedQty * (price - lastday));
        }
        const acct = this.snap.account;
        if (acct) {
            // Alpaca's equity = cash + long market value + short market value.
            const cash = num(acct.cash);
            const mv = this.snap.positions.reduce((sum, x) => sum + (Number.isFinite(num(x.market_value)) ? num(x.market_value) : 0), 0);
            if (Number.isFinite(cash)) acct.equity = String(cash + mv);
            const longMv = this.snap.positions.filter((x) => num(x.market_value) > 0).reduce((s, x) => s + num(x.market_value), 0);
            acct.long_market_value = String(longMv);
            acct.short_market_value = String(mv - longMv);
        }
        this.snap.tickAt = at ?? new Date().toISOString();
        this.emitSoon();
    }
}

// ── Hub ──────────────────────────────────────────────────────────────────────

const streams = new Map<string, WalletStream>();

/**
 * Watch a wallet. `hubKey` must change when the credentials do (callers fold
 * the key id into it), so a key rotated on the Profile page starts a fresh
 * connection instead of reusing one authenticated with the old keys.
 */
export function watchWallet(hubKey: string, wallet: WalletId, creds: AlpacaCreds, fn: (s: WalletSnapshot) => void): () => void {
    let s = streams.get(hubKey);
    if (!s) {
        s = new WalletStream(hubKey, wallet, creds, () => streams.delete(hubKey));
        streams.set(hubKey, s);
    }
    return s.subscribe(fn);
}

/** Force a REST resync for anyone watching (e.g. after orders were placed). */
export function resyncWallet(hubKey: string): void {
    void streams.get(hubKey)?.resync();
}
