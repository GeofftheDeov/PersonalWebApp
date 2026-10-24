// Turns Alpaca's /account and /positions responses into an alpaca_snapshots row.
//
// Alpaca returns numbers as strings. A missing or non-numeric field parses to
// NaN, and a NaN written to alpaca_snapshots breaks the dashboard charts and
// the overview tile (#169). So a snapshot is all-or-nothing: if any value the
// row needs doesn't parse to a finite number, the whole snapshot is rejected
// and the loop simply tries again on its next tick. Dropping just the bad
// position would make the stored total look like a sudden loss.

import type { IAlpacaPosition } from '../models/AlpacaSnapshot.js';

export interface AlpacaSnapshotRow {
    equity: number;
    last_equity: number;
    cash: number;
    buying_power: number;
    day_pl: number;
    positions: IAlpacaPosition[];
}

export type AlpacaSnapshotResult =
    | { ok: true; row: AlpacaSnapshotRow }
    | { ok: false; reason: string };

const ACCOUNT_FIELDS = ['equity', 'last_equity', 'cash', 'buying_power'] as const;
const POSITION_FIELDS = ['qty', 'market_value', 'unrealized_pl', 'current_price'] as const;

// Number.parseFloat accepts "12abc"; Number() rejects it and also takes numbers as-is.
function toFinite(v: unknown): number | null {
    if (typeof v === 'number') return Number.isFinite(v) ? v : null;
    if (typeof v !== 'string' || v.trim() === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
}

export function buildAlpacaSnapshot(acct: any, positions: unknown): AlpacaSnapshotResult {
    if (!acct || typeof acct !== 'object') return { ok: false, reason: 'account response is not an object' };
    if (!Array.isArray(positions)) return { ok: false, reason: 'positions response is not an array' };

    const account = {} as Record<(typeof ACCOUNT_FIELDS)[number], number>;
    for (const f of ACCOUNT_FIELDS) {
        const n = toFinite(acct[f]);
        if (n === null) return { ok: false, reason: `account.${f} is not a number (${JSON.stringify(acct[f])})` };
        account[f] = n;
    }

    const rows: IAlpacaPosition[] = [];
    for (const p of positions as any[]) {
        const symbol = p?.symbol;
        if (typeof symbol !== 'string' || symbol === '') {
            return { ok: false, reason: 'a position has no symbol' };
        }
        const row = { symbol } as IAlpacaPosition;
        for (const f of POSITION_FIELDS) {
            const n = toFinite(p[f]);
            if (n === null) return { ok: false, reason: `position ${symbol}.${f} is not a number (${JSON.stringify(p[f])})` };
            row[f] = n;
        }
        rows.push(row);
    }

    return {
        ok: true,
        row: { ...account, day_pl: account.equity - account.last_equity, positions: rows },
    };
}
