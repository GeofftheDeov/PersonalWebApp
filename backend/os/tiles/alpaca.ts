import { ok, unavailable, type TileSource } from "../overview.js";
import { ago, centralTime, esc, money, signedMoney, signedPct } from "../format.js";

/**
 * The Alpaca tile: the Cloud-Claw paper wallet's equity and day P&L, from the
 * latest alpaca_snapshots row (server.ts captures one every 5 minutes via
 * snapshotAlpacaNow).
 *
 * It never calls Alpaca and doesn't read the live multi-wallet stream: opening
 * a wallet calls Alpaca, and the overview's request path mustn't.
 */

export const ALPACA_WALLET = "Cloud-Claw paper";
/** A snapshot older than this is flagged stale: the 5-minute loop or the keys have broken. */
export const ALPACA_STALE_AFTER_MS = 15 * 60_000;

export interface AlpacaTileData {
    wallet: string;
    /** The snapshot's time (ISO). */
    asOf: string;
    ageMs: number;
    stale: boolean;
    equity: number;
    lastEquity: number;
    dayPl: number;
    /** day_pl / last_equity, in percent; null when last_equity is 0. */
    dayPlPct: number | null;
}

export const alpacaTile: TileSource<AlpacaTileData> = {
    id: "alpaca",
    title: `Alpaca · ${ALPACA_WALLET}`,
    href: "/admin/alpaca",

    async build({ now, db }) {
        const { rows: [s] } = await db.query(
            `SELECT ts, equity, last_equity, day_pl FROM alpaca_snapshots ORDER BY ts DESC LIMIT 1`);
        if (!s) {
            return unavailable("no snapshots yet. The server records one every 5 minutes once "
                + "ALPACA_API_KEY and ALPACA_SECRET_KEY (the Cloud-Claw paper keys) are set.");
        }
        const ts = new Date(s.ts);
        const ageMs = now.getTime() - ts.getTime();
        const equity = Number(s.equity), lastEquity = Number(s.last_equity), dayPl = Number(s.day_pl);
        return ok({
            wallet: ALPACA_WALLET,
            asOf: ts.toISOString(),
            ageMs,
            stale: ageMs > ALPACA_STALE_AFTER_MS,
            equity,
            lastEquity,
            dayPl,
            dayPlPct: lastEquity ? (dayPl / lastEquity) * 100 : null,
        });
    },

    render(t, { now }) {
        const dir = t.dayPl > 0 ? "up" : t.dayPl < 0 ? "down" : "flat";
        const glyph = dir === "up" ? "▲" : dir === "down" ? "▼" : "■";
        return `
            <div class="stat-label">Equity</div>
            <div class="stat-value">${esc(money(t.equity))}</div>
            <div class="stat-delta">
                <span class="dir dir-${dir}" aria-hidden="true">${glyph}</span>
                ${esc(signedMoney(t.dayPl))} (${esc(signedPct(t.dayPlPct))}) <span class="muted">today</span>
            </div>
            <div class="stat-meta">as of ${esc(centralTime(new Date(t.asOf), now))} · ${esc(ago(t.ageMs))}${
                t.stale ? ` · <span class="warn">no snapshot for over ${ALPACA_STALE_AFTER_MS / 60_000} min</span>` : ""}</div>`;
    },
};
