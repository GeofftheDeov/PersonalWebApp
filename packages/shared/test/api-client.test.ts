/**
 * The shared API client (#209, spec #69), checked on the wire: a real HTTP
 * server records what each call sends, and the test reads it back.
 *
 * What matters is what the backend sees. A cookie-authenticated write passes
 * the backend's CSRF check only with `X-Requested-With: gtd`
 * (backend/utils/sessionCookie.ts, CSRF_HEADER and CSRF_VALUE), so every
 * request must carry it, whatever the caller passes.
 *
 *   cd packages/shared && npm test
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { ApiError, CSRF_HEADER, CSRF_VALUE, createApiClient } from "@gtd/shared/api";

interface Seen {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}

let server: http.Server;
let origin = "";
const seen: Seen[] = [];

/** Each path answers in its own way; everything else echoes `{ ok: true }`. */
function respond(req: http.IncomingMessage, res: http.ServerResponse) {
  if (req.url === "/api/empty") { res.statusCode = 204; return res.end(); }
  if (req.url === "/api/refused") {
    res.statusCode = 403;
    res.setHeader("content-type", "application/json");
    return res.end(JSON.stringify({ error: "Forbidden: missing CSRF header" }));
  }
  if (req.url === "/api/broken") { res.statusCode = 502; return res.end("Bad gateway"); }
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ ok: true, path: req.url }));
}

before(async () => {
  server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      seen.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers, body });
      respond(req, res);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => new Promise<void>((r) => server.close(() => r())));

const last = () => seen[seen.length - 1];

test("the CSRF header is the one the backend checks", () => {
  assert.equal(CSRF_HEADER.toLowerCase(), "x-requested-with");
  assert.equal(CSRF_VALUE, "gtd");
});

test("every method sends X-Requested-With: gtd", async () => {
  const api = createApiClient({ baseUrl: origin });
  await api.get("/api/things");
  await api.post("/api/things", { a: 1 });
  await api.put("/api/things/1", { a: 2 });
  await api.patch("/api/things/1", { a: 3 });
  await api.delete("/api/things/1");
  await api.request("/api/things", { method: "OPTIONS" });
  const calls = seen.slice(-6);
  assert.deepEqual(calls.map((c) => c.method), ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]);
  for (const c of calls) assert.equal(c.headers["x-requested-with"], "gtd", `${c.method} ${c.url}`);
});

test("a caller's own X-Requested-With can't replace it", async () => {
  const api = createApiClient({ baseUrl: origin });
  await api.post("/api/things", {}, { headers: { "X-Requested-With": "XMLHttpRequest" } });
  assert.equal(last().headers["x-requested-with"], "gtd");
  await api.post("/api/things", {}, { headers: [["x-requested-with", "nope"]] });
  assert.equal(last().headers["x-requested-with"], "gtd");
});

test("it asks the browser to carry the session cookie on same-origin calls", async () => {
  const inits: RequestInit[] = [];
  const api = createApiClient({
    baseUrl: origin,
    fetch: (input, init) => { inits.push(init ?? {}); return fetch(input, init); },
  });
  await api.get("/api/things");
  await api.post("/api/things", { a: 1 });
  assert.deepEqual(inits.map((i) => i.credentials), ["same-origin", "same-origin"]);
});

test("a plain object body goes as JSON, and the JSON reply comes back", async () => {
  const api = createApiClient({ baseUrl: origin });
  const reply = await api.post<{ ok: boolean; path: string }>("/api/things", { offsets: [30, 60] });
  assert.deepEqual(reply, { ok: true, path: "/api/things" });
  assert.match(String(last().headers["content-type"]), /^application\/json/);
  assert.deepEqual(JSON.parse(last().body), { offsets: [30, 60] });
});

test("a GET sends no body and no content type", async () => {
  const api = createApiClient({ baseUrl: origin });
  await api.get("/api/things");
  assert.equal(last().body, "");
  assert.equal(last().headers["content-type"], undefined);
});

test("FormData goes through untouched, as multipart", async () => {
  const api = createApiClient({ baseUrl: origin });
  const form = new FormData();
  form.append("note", "hello");
  await api.post("/api/upload", form);
  assert.match(String(last().headers["content-type"]), /^multipart\/form-data; boundary=/);
  assert.match(last().body, /name="note"\r\n\r\nhello/);
  assert.equal(last().headers["x-requested-with"], "gtd");
});

test("an empty reply resolves to undefined", async () => {
  const api = createApiClient({ baseUrl: origin });
  assert.equal(await api.post("/api/empty"), undefined);
});

test("a refusal throws an ApiError with the server's message and status", async () => {
  const api = createApiClient({ baseUrl: origin });
  await assert.rejects(api.post("/api/refused", {}), (err: unknown) => {
    assert.ok(err instanceof ApiError);
    assert.equal(err.message, "Forbidden: missing CSRF header");
    assert.equal(err.status, 403);
    assert.deepEqual(err.body, { error: "Forbidden: missing CSRF header" });
    return true;
  });
});

test("a reply that isn't JSON throws 'Request failed (status)'", async () => {
  const api = createApiClient({ baseUrl: origin });
  await assert.rejects(api.get("/api/broken"), (err: unknown) => {
    assert.ok(err instanceof ApiError);
    assert.equal(err.message, "Request failed (502)");
    assert.equal(err.status, 502);
    return true;
  });
});

test("a token from getToken goes as a bearer header; none, none", async () => {
  let token: string | null = "abc.def.ghi";
  const api = createApiClient({ baseUrl: origin, getToken: () => token });
  await api.get("/api/things");
  assert.equal(last().headers.authorization, "Bearer abc.def.ghi");
  token = null;
  await api.get("/api/things");
  assert.equal(last().headers.authorization, undefined);
  assert.equal(last().headers["x-requested-with"], "gtd");
});

test("a per-call token wins over getToken, and null sends none", async () => {
  const api = createApiClient({ baseUrl: origin, getToken: () => "stored" });
  await api.get("/api/things", { token: "given" });
  assert.equal(last().headers.authorization, "Bearer given");
  await api.get("/api/things", { token: null });
  assert.equal(last().headers.authorization, undefined);
});

test("paths join the base URL, and the default base is the page's own origin", async () => {
  const urls: string[] = [];
  const api = createApiClient({
    fetch: async (input) => { urls.push(String(input)); return new Response(null, { status: 204 }); },
  });
  await api.get("/api/users/me");
  assert.deepEqual(urls, ["/api/users/me"]);
});

test("a 401 reaches onUnauthorized (the session's expiry hook), then still throws", async () => {
  const reached: ApiError[] = [];
  const api = createApiClient({
    onUnauthorized: (err) => { reached.push(err); },
    fetch: async () => new Response(JSON.stringify({ error: "Unauthorized: Invalid token" }), { status: 401 }),
  });
  await assert.rejects(api.get("/api/things"), (err: unknown) => err instanceof ApiError && err.status === 401);
  assert.equal(reached.length, 1);
  assert.equal(reached[0].message, "Unauthorized: Invalid token");
});

test("other refusals don't reach onUnauthorized", async () => {
  let calls = 0;
  const api = createApiClient({ baseUrl: origin, onUnauthorized: () => { calls++; } });
  await assert.rejects(api.post("/api/refused", {}));
  await assert.rejects(api.get("/api/broken"));
  assert.equal(calls, 0);
});
