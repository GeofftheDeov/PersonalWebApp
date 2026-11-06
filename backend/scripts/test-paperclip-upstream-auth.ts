/**
 * Test: Paperclip refusing our API key is not the user's session ending
 * (GitHub #210, spec #69).
 *
 * The browser treats any 401 from /api as "the session ended" and sends the
 * person to log in (frontend/src/lib/api.ts). The /api/paperclip routes relay
 * pcFetch's status, so when Paperclip rejected PAPERCLIP_API_KEY with a 401, a
 * signed-in admin was logged out on every Paperclip page, and again after
 * logging back in. pcFetch now reports an upstream 401 or 403 as a 502: our
 * credential to an upstream failed, which is a gateway problem.
 *
 * Checked against a stand-in Paperclip:
 *   - upstream 401 and 403 come back as 502, still naming the key;
 *   - other upstream refusals (404, 409) keep their status;
 *   - a success passes its data through.
 *
 * Needs no database, but runs like the other suites:
 *   DATABASE_URL=postgresql://postgres@127.0.0.1:5433/pwatest npx tsx scripts/test-paperclip-upstream-auth.ts
 */
import "./use-test-jwt-secret.js";
import http from "http";
import type { AddressInfo } from "net";

let pass = 0, fail = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : `\n          ${detail}`}`);
  ok ? pass++ : fail++;
}

async function main() {
  const upstream = http.createServer((req, res) => {
    const status = Number((req.url ?? "").split("/").pop()) || 200;
    res.writeHead(status, { "content-type": "application/json", connection: "close" });
    res.end(JSON.stringify(status === 200 ? { ok: true } : { error: `upstream said ${status}` }));
  });
  await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
  // Read at import, so set before loading the client.
  process.env.PAPERCLIP_BASE_URL = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
  process.env.PAPERCLIP_API_KEY = "t210-key";
  const { pcFetch } = await import("../services/paperclipClient.js");

  try {
    for (const code of [401, 403]) {
      const r = await pcFetch(`/api/status/${code}`);
      check(`an upstream ${code} comes back as a 502, naming the key`,
        r.status === 502 && /PAPERCLIP_API_KEY/.test(r.error ?? ""), JSON.stringify(r));
    }
    for (const code of [404, 409]) {
      const r = await pcFetch(`/api/status/${code}`);
      check(`an upstream ${code} keeps its status`, r.status === code && r.error === `upstream said ${code}`, JSON.stringify(r));
    }
    const ok = await pcFetch<{ ok: boolean }>("/api/status/200");
    check("a success passes its data through", ok.status === 200 && ok.data?.ok === true, JSON.stringify(ok));
  } finally {
    // Closed before exiting: exiting mid-close trips a libuv assertion on Windows.
    upstream.closeAllConnections();
    await new Promise<void>((r) => upstream.close(() => r()));
  }

  console.log(`\n  ${pass} passed, ${fail} failed\n`);
  process.exitCode = fail ? 1 : 0;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
