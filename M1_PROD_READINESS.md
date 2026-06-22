# M1 Prod-Readiness Audit — Command Center (3 Admin Surfaces)

**Issue:** MUR-29  
**Branch:** `dev`  
**Date:** 2026-06-16  
**Auditor:** ClaudeCoder (automated static audit via Paperclip)

---

## Audit Scope

Three admin surfaces under `/admin/*`:

| Surface | Route | Purpose |
|---------|-------|---------|
| Cloud-Claw | `/admin/cloud-claw` | AI trading agent chat w/ Alpaca paper + Obsidian |
| Alpaca Dashboard | `/admin/alpaca` | Paper/live account, positions, P&L |
| Obsidian Browser | `/admin/obsidian` | Vault file tree + note reader |

---

## 1. Route & Architecture Summary

All three surfaces are **server-rendered HTML endpoints** in the Express backend — not Next.js pages.

- **`/backend/routes/adminRoutes.ts`** (2,213 lines) — All three page renders + Alpaca/Obsidian API endpoints
- **`/backend/routes/cloudClawRoutes.ts`** (403 lines) — Cloud-Claw streaming chat API
- **`/backend/utils/adminUi.ts`** — Shared page template/nav renderer

---

## 2. Authentication on `/admin/*`

**Mechanism:** Query-parameter JWT — every admin URL carries `?token=<JWT>`

**Middleware** (`adminRoutes.ts` lines 16–35):
```typescript
const verifyToken = (req, res, next) => {
    const token = req.query.token as string;
    if (!token) return res.redirect('/login');
    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET || "your-secret-key-change-this");
        req.adminUser = { id: decoded.id, email: decoded.email };
        next();
    } catch (err) {
        return res.redirect(loginUrl);
    }
};
router.use(verifyToken);  // Applied globally to all /admin/* routes
```

**Findings:**
- ✅ Auth is enforced globally on all `/admin/*` routes — no public bypass
- ✅ JWT signature is validated before access is granted
- ✅ Unauthenticated requests redirect to `/login`
- ⚠️ **Token is exposed in URL** (browser history, referrer headers, server logs)
- ⚠️ **JWT_SECRET has a hardcoded fallback** (`"your-secret-key-change-this"`) — if the env var is absent in prod, any token signed with that secret is valid
- ⚠️ Token TTL is **1 hour** — reasonable but means a leaked URL is valid for up to an hour
- ⚠️ No RBAC — all authenticated users can access all admin surfaces

---

## 3. Core Flow Verification (Static)

### 3a. Cloud-Claw (`/admin/cloud-claw`)

**Chat API endpoints** (`cloudClawRoutes.ts`):
- `POST /api/cloud-claw/chat` — standard request/response
- `POST /api/cloud-claw/chat/stream` — Server-Sent Events streaming
- `DELETE /api/cloud-claw/chat` — clear history
- `GET /api/cloud-claw/history` — fetch previous messages

**Agent tools exposed to Claude:**
1. `getAccount` — paper account details
2. `getPositions` — open paper positions
3. `getMarketData` — stock quotes
4. `submitOrder` — submit orders to paper API
5. `readNote` — read a vault note by path
6. `searchVault` — full-text search across vault

**Paper-only guard for Cloud-Claw:**  
`cloudClawRoutes.ts` line 85 — hardcoded base URL:
```typescript
const base = 'https://paper-api.alpaca.markets/v2';
```
Cloud-Claw **cannot** reach the live account regardless of which Alpaca keys are loaded — the URL is hardcoded to the paper endpoint. ✅

**Missing env var handling:**
```typescript
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY || '' });
```
Empty string causes silent failure on the first Claude API call (no startup error).

### 3b. Obsidian Browser (`/admin/obsidian`)

**API endpoints:**
- `GET /admin/obsidian/api/tree?token=<JWT>` — full vault file tree
- `GET /admin/obsidian/api/file?token=<JWT>&path=<rel>` — single file content

**Path traversal protection** (`adminRoutes.ts`):
```typescript
function safeVaultRead(vaultPath: string, relativePath: string): string | null {
    const full = path.resolve(vaultPath, relativePath);
    if (!full.startsWith(path.resolve(vaultPath))) return null;  // blocks ../../../
    try { return fs.readFileSync(full, 'utf-8'); } catch { return null; }
}
```

**Findings:**
- ✅ Path traversal is blocked server-side
- ✅ Returns `503` if `OBSIDIAN_VAULT_PATH` is not set
- ✅ Read-only access (no write operations)
- ✅ Excludes `.git`, `private`, `node_modules` from tree listing
- ⚠️ Excluded directories (e.g. `private/`) are only excluded from `buildVaultTree()`, not from `safeVaultRead()` — a direct `?path=private/secret.md` call will succeed if the path resolves within the vault
- ⚠️ No user isolation — all admin users share the same vault view

### 3c. Alpaca Dashboard (`/admin/alpaca`)

**Features:**
- Paper trading account stats (equity, buying power, day P&L, cash)
- KPI trend charts (1D / 1W / 1M)
- Open positions + order history
- Profile switch: PAPER ↔ PERSONAL (live)
- "Apply to Personal" modal — mirrors paper positions to live account

---

## 4. "Apply to Personal" Live-Trade Action

**⚠️ CRITICAL — This action is NOT disabled at the server level.**

**Route:** `POST /admin/alpaca/api/apply-to-personal` (`adminRoutes.ts` lines 1068–1113)

**What it does:** Takes a submitted list of `{ symbol, notional }` pairs and executes real market buy orders on the user's live Alpaca account.

**Backend implementation (abridged):**
```typescript
router.post('/alpaca/api/apply-to-personal', async (req: any, res) => {
    const { orders } = req.body;
    // ... validation ...
    const keys = await getDecryptedKeys(userId, 'alpaca_live');
    if (!keys) return res.status(400).json({ error: 'No personal Alpaca keys found.' });

    const base = 'https://api.alpaca.markets/v2';  // ⚠️ LIVE endpoint
    for (const o of orders) {
        await fetch(`${base}/orders`, {
            method: 'POST',
            headers: { 'APCA-API-KEY-ID': keys.keyId, 'APCA-API-SECRET-KEY': keys.secret },
            body: JSON.stringify({ symbol: o.symbol, notional: o.notional, side: 'buy',
                                   type: 'market', time_in_force: 'day' }),
        });
    }
});
```

**Existing guards (what's there):**
1. Valid JWT required (verifyToken middleware) ✅
2. User must have previously stored `alpaca_live` keys in the vault ✅
3. Orders array cannot be empty ✅
4. Frontend modal with explicit "THIS WILL PLACE REAL ORDERS" warning ✅

**Missing guards (what's NOT there):**
- ❌ No `ALLOW_LIVE_TRADING` / `TRADING_MODE` environment variable — no server-side kill switch
- ❌ No max-notional-per-order or daily spending limit
- ❌ No rate limiting on this endpoint
- ❌ No audit log of executed orders (no MongoDB write, no structured log)
- ❌ No additional auth factor (2FA / OTP)

**M1 Guardrail status:** The "live trading stays paper-only" guardrail from MUR-28 is **enforced by the absence of stored `alpaca_live` keys only**. If those keys are ever added to the vault, the endpoint immediately accepts real orders. A server-side flag is needed before prod.

---

## 5. Environment Variables Audit

| Variable | Used By | Required | Fallback | Risk |
|----------|---------|----------|---------|------|
| `JWT_SECRET` | All admin auth | **YES** | `"your-secret-key-change-this"` | 🔴 HIGH — hardcoded fallback is a security hole |
| `VAULT_ENCRYPTION_KEY` | API key vault encrypt/decrypt | **YES** | None (throws at runtime) | 🔴 HIGH — crash if missing |
| `ANTHROPIC_API_KEY` | Cloud-Claw chat | YES | `''` (empty string) | 🟡 MEDIUM — silent failure |
| `ALPACA_API_KEY` | Paper dashboard, Cloud-Claw | YES | `''` (empty string) | 🟡 MEDIUM — API calls fail |
| `ALPACA_SECRET_KEY` | Paper dashboard, Cloud-Claw | YES | `''` (empty string) | 🟡 MEDIUM — API calls fail |
| `OBSIDIAN_VAULT_PATH` | Obsidian browser, Cloud-Claw | YES | `''` (empty string) | 🟢 LOW — returns 503 cleanly |
| `MONGO_URI` | All database ops | YES | `mongodb://localhost:27017/...` | 🟢 LOW — reasonable dev default |
| `FRONTEND_URL` | Redirects, email links | NO | `http://localhost:3000` | 🟢 LOW — reasonable dev default |

**Missing prod env var: `ALLOW_LIVE_TRADING`** — should be added and defaulted to `false`.

---

## 6. Security Architecture (Vault Encryption)

AES-256-GCM with random IV per encryption (`/backend/utils/encryption.ts`):
- ✅ Industry-standard cipher + auth tag (tamper-evident)
- ✅ Random 12-byte IV per encryption
- ✅ Throws at startup if `VAULT_ENCRYPTION_KEY` is wrong length
- ⚠️ Key is shared across all users — no per-user key derivation
- ⚠️ No key rotation mechanism documented

---

## 7. Prod-Hardening Gap List

### MUST FIX before `dev → main` merge

| # | Gap | File / Line | Fix |
|---|-----|------------|-----|
| 1 | **No server-side live-trade kill switch** | `adminRoutes.ts:1068` | Add `ALLOW_LIVE_TRADING` env var; default `false`; check before executing orders |
| 2 | **JWT_SECRET hardcoded fallback** | `adminRoutes.ts:26`, `userRoutes.ts:180` | Throw at server startup if `JWT_SECRET` is missing or equals the default |
| 3 | **VAULT_ENCRYPTION_KEY not validated at startup** | `encryption.ts` | Add startup check; fail fast rather than crashing mid-request |
| 4 | **No audit log for live trades** | `adminRoutes.ts:1068` | Log user ID, timestamp, symbol, notional, order ID to MongoDB `TradeAuditLog` |
| 5 | **No transaction limit checks** | `adminRoutes.ts:1095` | Validate max notional per order and daily total before submitting |

### SHOULD FIX before public release

| # | Gap | File / Line | Fix |
|---|-----|------------|-----|
| 6 | **JWT token in URL query param** | All admin routes | Move to `Authorization: Bearer` header or secure `HttpOnly` session cookie |
| 7 | **Obsidian excluded dirs not enforced in read** | `adminRoutes.ts:safeVaultRead` | Check path against `VAULT_EXCLUDED` in `safeVaultRead()`, not just in tree build |
| 8 | **No rate limiting on trade endpoints** | `adminRoutes.ts` | Add `express-rate-limit` to `/admin/alpaca/api/*` endpoints |
| 9 | **ANTHROPIC_API_KEY not validated at startup** | `cloudClawRoutes.ts` | Validate presence at startup; return 503 on chat if missing |
| 10 | **No RBAC** | `adminRoutes.ts:35` | Add `role` field to JWT; restrict admin surfaces to `operator` role |
| 11 | **No 2FA/OTP for live trade confirmation** | `adminRoutes.ts:1068` | Require TOTP before accepting live-trade requests |
| 12 | **Per-user vault key derivation missing** | `encryption.ts` | Derive per-user encryption keys via PBKDF2 + user-specific salt |

---

## 8. Summary

| Surface | Loads | Core Flow | Auth Gated | Paper-Only | Prod Blockers |
|---------|-------|-----------|-----------|-----------|--------------|
| Cloud-Claw | ✅ | Chat + streaming API exists | ✅ | ✅ Hardcoded paper URL | ANTHROPIC_API_KEY startup validation |
| Alpaca Dashboard | ✅ | Paper account + positions exist | ✅ | ⚠️ Live trade button exists | No kill switch (Gap #1) |
| Obsidian Browser | ✅ | Tree + file read exist | ✅ | N/A | Minor: excluded-dir bypass (Gap #7) |

**Go/No-Go verdict:** ❌ **NOT ready for prod merge** until Gap #1 (live-trade kill switch) and Gap #2 (JWT_SECRET hardening) are fixed. All other gaps are medium/low and can be tracked as follow-up.

---

## 9. Recommended Immediate Fixes

### Fix #1 — Add `ALLOW_LIVE_TRADING` kill switch (30 min)

In `adminRoutes.ts` at the top of the `apply-to-personal` handler:

```typescript
if (process.env.ALLOW_LIVE_TRADING !== 'true') {
    return res.status(403).json({
        error: 'Live trading is disabled. Set ALLOW_LIVE_TRADING=true to enable.',
    });
}
```

Add `ALLOW_LIVE_TRADING=false` to `.env.example` and ECS task definition with default `false`.

### Fix #2 — Fail fast on missing JWT_SECRET (15 min)

In server startup (e.g. `server.ts` or `app.ts`):

```typescript
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET || JWT_SECRET === 'your-secret-key-change-this') {
    throw new Error('JWT_SECRET must be set to a secure random string in production');
}
```

### Fix #3 — Validate VAULT_ENCRYPTION_KEY at startup (10 min)

Expose a `validateEncryptionKey()` function from `encryption.ts` and call it at startup so the server fails before accepting any requests rather than mid-operation.

---

*This document was produced by static code analysis. Runtime/browser verification required before final merge sign-off.*
