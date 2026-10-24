// #169 verification — run with: npx tsx backend/utils/alpacaSnapshot.test.ts
// Proves a malformed Alpaca response is rejected instead of storing NaN.
import assert from 'node:assert/strict';
import { buildAlpacaSnapshot } from './alpacaSnapshot.js';

let passed = 0;
function check(name: string, fn: () => void) {
    fn();
    passed++;
    console.log(`  ok - ${name}`);
}

const acct = { equity: '1050.25', last_equity: '1000', cash: '200.5', buying_power: '400' };
const pos = { symbol: 'AAPL', qty: '2', market_value: '450.10', unrealized_pl: '-3.2', current_price: '225.05' };

function hasNaN(v: unknown): boolean {
    return JSON.stringify(v, (_k, x) => (typeof x === 'number' && !Number.isFinite(x) ? '__NaN__' : x)).includes('__NaN__');
}

check('a well-formed response parses to numbers, with day_pl from equity', () => {
    const r = buildAlpacaSnapshot(acct, [pos]);
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.deepEqual(r.row, {
        equity: 1050.25, last_equity: 1000, cash: 200.5, buying_power: 400, day_pl: 50.25,
        positions: [{ symbol: 'AAPL', qty: 2, market_value: 450.1, unrealized_pl: -3.2, current_price: 225.05 }],
    });
});

check('no positions is a valid snapshot', () => {
    const r = buildAlpacaSnapshot(acct, []);
    assert.equal(r.ok, true);
    if (r.ok) assert.deepEqual(r.row.positions, []);
});

check('numeric (not string) values are accepted', () => {
    const r = buildAlpacaSnapshot({ equity: 10, last_equity: 9, cash: 1, buying_power: 2 }, []);
    assert.equal(r.ok, true);
});

check('each missing or bad account field rejects the snapshot', () => {
    for (const f of ['equity', 'last_equity', 'cash', 'buying_power']) {
        for (const bad of [undefined, null, '', ' ', 'abc', '12abc', 'NaN', 'Infinity', {}]) {
            const r = buildAlpacaSnapshot({ ...acct, [f]: bad }, [pos]);
            assert.equal(r.ok, false, `${f}=${JSON.stringify(bad)}`);
            if (!r.ok) assert.match(r.reason, new RegExp(`account\\.${f}`));
        }
    }
});

check('a bad position field rejects the whole snapshot, not just the position', () => {
    for (const f of ['qty', 'market_value', 'unrealized_pl', 'current_price']) {
        const r = buildAlpacaSnapshot(acct, [pos, { ...pos, symbol: 'MSFT', [f]: undefined }]);
        assert.equal(r.ok, false, f);
        if (!r.ok) assert.match(r.reason, new RegExp(`MSFT\\.${f}`));
    }
});

check('a position with no symbol rejects the snapshot', () => {
    assert.equal(buildAlpacaSnapshot(acct, [{ ...pos, symbol: undefined }]).ok, false);
});

check('non-object account or non-array positions are rejected', () => {
    assert.equal(buildAlpacaSnapshot(null, []).ok, false);
    assert.equal(buildAlpacaSnapshot('oops', []).ok, false);
    assert.equal(buildAlpacaSnapshot(acct, { message: 'forbidden' }).ok, false);
    assert.equal(buildAlpacaSnapshot(acct, null).ok, false);
});

check('an accepted snapshot never contains NaN or Infinity', () => {
    const r = buildAlpacaSnapshot(acct, [pos, { ...pos, symbol: 'MSFT' }]);
    assert.equal(r.ok, true);
    assert.equal(hasNaN(r), false);
});

console.log(`\n${passed} checks passed`);
