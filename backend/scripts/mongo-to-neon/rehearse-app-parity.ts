/**
 * App-level parity for the #49 rehearsal: does the RELEASE build, reading the
 * migrated Postgres, show every person the same thing the JULY build showed
 * them from Mongo?
 *
 * Two servers, same fixture:
 *   OLD  the July build (4ca0afec) on the Mongo the dump was taken from
 *   NEW  the release build (this branch) on the Postgres the dump was loaded into
 *
 * For each persona it logs in on both with the SAME password — the #49
 * acceptance test is that people keep their existing passwords — then calls the
 * read endpoints a person actually uses and compares the JSON, after rewriting
 * every ObjectId in OLD's response to the uuid the migration gave it.
 *
 *   OLD_URL=http://127.0.0.1:5102 NEW_URL=http://127.0.0.1:5101 \
 *     npx tsx scripts/mongo-to-neon/rehearse-app-parity.ts scripts/mongo-to-neon/fixture-dump/personal_web_app
 *
 * A difference is not automatically a migration bug: 26 commits of fixes sit
 * between the two builds. Every difference is printed so it can be attributed.
 */
import { idFor, readDump } from "../mongo-to-neon.js";

const OLD = process.env.OLD_URL ?? "http://127.0.0.1:5102";
const NEW = process.env.NEW_URL ?? "http://127.0.0.1:5101";
const dir = process.argv[2];
if (!dir) { console.error("usage: rehearse-app-parity.ts <dump dir>"); process.exit(2); }
const dump = readDump(dir);

const hexOf = (doc: any) => doc._id.toHexString();
const person = (email: string) => {
    for (const c of ["users", "accounts", "contacts", "leads"]) {
        const d = (dump[c] ?? []).find((x) => (x.email ?? "").toLowerCase() === email.toLowerCase());
        if (d) return { coll: c, hex: hexOf(d) };
    }
    throw new Error(`no person ${email}`);
};
const campaignHex = hexOf(dump.campaigns[0]);
const sessionHex = hexOf(dump.sessions[0]);
// The DM partner who no longer exists: Morgan's Lead, deleted by the conversion.
const deletedLeadHex = (() => {
    const known = new Set(["users", "accounts", "contacts", "leads"].flatMap((c) => (dump[c] ?? []).map(hexOf)));
    for (const m of dump.messages) {
        for (const p of String(m.dmKey ?? "").split(":")) if (p && !known.has(p)) return p;
    }
    throw new Error("fixture has no dangling DM partner");
})();

// Rewrite only hex that the dump uses as an ObjectId somewhere (an _id or a
// reference, including references to deleted documents). A 24-hex STRING that
// is not an id — notification meta can carry one — must come back unchanged.
const objectIdHex = new Set<string>();
const walk = (x: any) => {
    if (x?._bsontype === "ObjectId") { objectIdHex.add(x.toHexString()); return; }
    if (Array.isArray(x)) x.forEach(walk);
    else if (x && typeof x === "object" && !(x instanceof Date)) Object.values(x).forEach(walk);
};
Object.values(dump).forEach((docs) => docs.forEach(walk));
const toNew = (s: string) => s.replace(/\b[0-9a-f]{24}\b/g, (h) => (objectIdHex.has(h) ? idFor(h) : h));

async function call(base: string, method: string, path: string, token?: string, body?: any) {
    const res = await fetch(base + path, {
        method,
        headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
        body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json: any = text;
    try { json = JSON.parse(text); } catch { /* keep text */ }
    return { status: res.status, json };
}

/**
 * Differences that are representation, not data, and are filtered so the real
 * ones are visible:
 *   - Mongoose omits an unset field; the release model layer returns it as null.
 *   - the release model layer adds `id` alongside `_id`.
 *   - Mongoose `__v`, and the `_id`s it gives ready-check response subdocuments
 *     (dropped by the migration: nothing references them).
 */
const VOLATILE = [/\.token$/, /\.__v$/, /readyCheck\.responses\[\d+\]\._id$/];

function diff(a: any, b: any, path = "$", out: string[] = []): string[] {
    if (VOLATILE.some((r) => r.test(path))) return out;
    if (Array.isArray(a) && Array.isArray(b)) {
        if (a.length !== b.length) out.push(`${path}: length ${a.length} vs ${b.length}`);
        for (let i = 0; i < Math.min(a.length, b.length); i++) diff(a[i], b[i], `${path}[${i}]`, out);
        return out;
    }
    if (a && b && typeof a === "object" && typeof b === "object") {
        for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
            if (k === "id" && !(k in a) && b.id === (b._id ?? a._id)) continue;
            if (!(k in a) && b[k] === null) continue;
            if (!(k in b) && a[k] === null) continue;
            if (!(k in a)) { if (!VOLATILE.some((r) => r.test(`${path}.${k}`))) out.push(`${path}.${k}: only NEW = ${JSON.stringify(b[k])?.slice(0, 120)}`); continue; }
            if (!(k in b)) { if (!VOLATILE.some((r) => r.test(`${path}.${k}`))) out.push(`${path}.${k}: only OLD = ${JSON.stringify(a[k])?.slice(0, 120)}`); continue; }
            diff(a[k], b[k], `${path}.${k}`, out);
        }
        return out;
    }
    // Numbers that came back from numeric(14,2) and dates that round-trip
    // through timestamptz are compared by value, not by spelling.
    if (typeof a === "string" && typeof b === "string" && !isNaN(Date.parse(a)) && /\d{4}-\d\d-\d\dT/.test(a)
        && Date.parse(a) === Date.parse(b)) return out;
    if (a !== b) out.push(`${path}: OLD ${JSON.stringify(a)?.slice(0, 120)} | NEW ${JSON.stringify(b)?.slice(0, 120)}`);
    return out;
}

const personas = [
    { label: "admin (User, mixed-case stored email)", email: "geoff.admin@example.test", password: "Admin-Pass-1!", expect: 200 },
    { label: "user2 (User; same email also on a Lead)", email: "sam@example.test", password: "second user pw", expect: 200 },
    { label: "lead (non-ASCII password)", email: "lena@example.test", password: "lead-pässwörd-ü", expect: 200 },
    { label: "contact", email: "casey@example.test", password: "contact-pw-42", expect: 200 },
    { label: "account (converted from a deleted Lead)", email: "morgan@example.test", password: "was-a-lead-first", expect: 200 },
    { label: "legacy user (raw doc, no createdAt)", email: "legacy.larry@example.test", password: "legacy-pw", expect: 200 },
    { label: "business account, no password", email: "hello@dragondice.test", password: "anything", expect: 403 },
    { label: "wrong password", email: "lena@example.test", password: "not-it", expect: 401 },
];

let failures = 0;
let differences = 0;
for (const p of personas) {
    const [o, n] = await Promise.all([
        call(OLD, "POST", "/api/users/login", undefined, { email: p.email, password: p.password }),
        call(NEW, "POST", "/api/users/login", undefined, { email: p.email, password: p.password }),
    ]);
    // Both builds must give the EXPECTED answer, not merely the same one: two
    // 500s agree with each other and prove nothing.
    const ok = o.status === p.expect && n.status === p.expect;
    if (!ok) failures++;
    console.log(`\n${ok ? "PASS" : "FAIL"}  login ${p.label}: OLD ${o.status} NEW ${n.status} (want ${p.expect})`);
    if (o.status !== 200 || n.status !== 200) continue;

    const me = person(p.email);
    const oldId = String(o.json.user?.id);
    const newId = String(n.json.user?.id);
    if (idFor(oldId) !== newId) { failures++; console.log(`FAIL  id: OLD ${oldId} -> expected ${idFor(oldId)}, NEW ${newId}`); }
    const loginDiff = diff(JSON.parse(toNew(JSON.stringify(o.json))), n.json);
    if (loginDiff.length) { differences += loginDiff.length; console.log("  login body differs:\n    " + loginDiff.join("\n    ")); }

    const partners: Record<string, string> = {
        "geoff.admin@example.test": person("lena@example.test").hex,
        "lena@example.test": person("geoff.admin@example.test").hex,
        "sam@example.test": deletedLeadHex,
    };
    const paths = [
        "/api/users/profile", "/api/friends/list", "/api/friends/requests", "/api/notifications",
        "/api/campaigns", `/api/campaigns/${campaignHex}`, `/api/campaigns/${campaignHex}/members`,
        `/api/campaigns/${campaignHex}/sessions`, `/api/messages/campaign/${campaignHex}`,
        "/api/campaign-invites/mine", "/api/users/profile/sessions", `/api/users/players/${me.hex}`,
        "/api/tabletop/characters", `/api/tabletop/sessions/${sessionHex}`, "/api/tasks", "/api/events",
        "/api/api-keys", "/api/cloud-claw/history",
        ...(partners[p.email] ? [`/api/messages/dm/${partners[p.email]}`] : []),
    ];
    for (const path of paths) {
        const [a, b] = await Promise.all([call(OLD, "GET", path, o.json.token), call(NEW, "GET", toNew(path), n.json.token)]);
        const d = a.status !== b.status ? [`status OLD ${a.status} NEW ${b.status}`]
            : diff(JSON.parse(toNew(JSON.stringify(a.json))), b.json);
        if (d.length) differences += d.length;
        console.log(`  ${d.length ? "DIFF" : "same"}  GET ${path}${d.length ? "\n      " + d.slice(0, 12).join("\n      ") + (d.length > 12 ? `\n      … ${d.length - 12} more` : "") : ""}`);
    }
}
console.log(`\n${failures} login/id failure(s), ${differences} response difference(s)`);
process.exit(failures ? 1 : 0);
