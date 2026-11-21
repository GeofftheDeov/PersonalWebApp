/**
 * The Letters wiring both sites share (#211, spec #69): which thread a
 * campaign or a friend's DM is, and sending an attachment (#104), which goes
 * up in two steps: ask the API where, then PUT the file straight to storage.
 *
 * A stand-in fetch plays the API and the storage bucket.
 *
 *   cd packages/shared && npm test
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createApiClient } from "@gtd/shared/api";
import {
  ATTACHMENT_MAX_BYTES, MAX_ATTACHMENTS_PER_MESSAGE, attachmentProblem, createLetters, formatBytes,
} from "@gtd/shared/letters";
import type { SessionClient, SessionState } from "@gtd/shared/session";

const sessionAs = (state: SessionState) =>
  ({ getState: () => state, subscribe: () => () => {} }) as unknown as SessionClient;

const me = (id: string): SessionState => ({
  status: "signedIn",
  user: { id, email: null, name: id, handle: id, profilePicture: null } as never,
  capabilities: { appRole: null, paperclip: false } as never,
});
const nobody: SessionState = { status: "signedOut", user: null, capabilities: null };

type Call = { url: string; method: string; headers: Record<string, string>; body: unknown };

/** The API at /api/threads/…/attachments, and a bucket at https://bucket.t211.test. */
function fakeBackend({ apiStatus = 200, bucketStatus = 200 } = {}) {
  const calls: Call[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    const headers = Object.fromEntries(new Headers(init.headers).entries());
    calls.push({ url, method: init.method ?? "GET", headers, body: init.body });
    if (url.startsWith("https://bucket.t211.test/")) return new Response(null, { status: bucketStatus });
    if (apiStatus !== 200) {
      return new Response(JSON.stringify({ error: "Attachments are switched off" }), { status: apiStatus, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify({
      url: "https://bucket.t211.test/up?sig=1", method: "PUT", headers: { "content-type": "image/png" }, key: "att/t211.png",
    }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { calls, fetchImpl };
}

function lettersWith(fetchImpl: typeof fetch, state: SessionState = me("acc-1")) {
  const api = createApiClient({ fetch: fetchImpl });
  // The bucket PUT is a plain fetch: the presigned URL is its own credential.
  return createLetters({ api, session: sessionAs(state), fetch: fetchImpl });
}

const png = (bytes = 3, name = "map.png") => new File([new Uint8Array(bytes)], name, { type: "image/png" });

test("a campaign's thread is its Table Talk; a friend's is the DM between the two of you", () => {
  const letters = lettersWith(fakeBackend().fetchImpl, me("acc-2"));
  assert.equal(letters.threadKeyFor("campaign", "camp-9"), "campaign:camp-9");
  // The same key from either side, whichever id is "mine".
  assert.equal(letters.threadKeyFor("dm", "acc-1"), "dm:acc-1:acc-2");
  assert.equal(lettersWith(fakeBackend().fetchImpl, me("acc-1")).threadKeyFor("dm", "acc-2"), "dm:acc-1:acc-2");
});

test("signed out, there's no DM to name", () => {
  const letters = lettersWith(fakeBackend().fetchImpl, nobody);
  assert.equal(letters.threadKeyFor("dm", "acc-1"), null);
  assert.equal(letters.threadKeyFor("campaign", "camp-9"), "campaign:camp-9");
});

test("an attachment asks the API where to go, then goes straight to storage", async () => {
  const { calls, fetchImpl } = fakeBackend();
  const key = await lettersWith(fetchImpl).uploadAttachment("campaign:camp-9", png(3));
  assert.equal(key, "att/t211.png");
  assert.equal(calls.length, 2);
  const [ask, put] = calls;
  assert.equal(ask.url, "/api/threads/campaign%3Acamp-9/attachments");
  assert.equal(ask.method, "POST");
  assert.equal(ask.headers["x-requested-with"], "gtd", "the API call carries the CSRF header");
  assert.deepEqual(JSON.parse(String(ask.body)), { name: "map.png", contentType: "image/png", size: 3 });
  assert.equal(put.url, "https://bucket.t211.test/up?sig=1");
  assert.equal(put.method, "PUT");
  assert.equal(put.headers["content-type"], "image/png");
  assert.equal(put.headers["x-requested-with"], undefined, "storage gets only what the API said to send");
});

test("a file that can't be attached is refused before anything is sent", async () => {
  const { calls, fetchImpl } = fakeBackend();
  const exe = new File([new Uint8Array(3)], "run.exe", { type: "application/x-msdownload" });
  await assert.rejects(lettersWith(fetchImpl).uploadAttachment("campaign:camp-9", exe), /run\.exe: attach a JPEG/);
  assert.equal(calls.length, 0);
});

test("the API's refusal, or storage's, comes back as a message fit to show", async () => {
  await assert.rejects(
    lettersWith(fakeBackend({ apiStatus: 503 }).fetchImpl).uploadAttachment("campaign:camp-9", png()),
    { message: "Attachments are switched off" },
  );
  await assert.rejects(
    lettersWith(fakeBackend({ bucketStatus: 403 }).fetchImpl).uploadAttachment("campaign:camp-9", png()),
    { message: "Couldn't upload map.png (storage answered 403)" },
  );
});

test("the limits shown when a file is picked match the server's", () => {
  assert.equal(MAX_ATTACHMENTS_PER_MESSAGE, 10);
  assert.equal(attachmentProblem(png(ATTACHMENT_MAX_BYTES + 1, "big.png")), "big.png is over 10 MB.");
  assert.equal(attachmentProblem(png(0, "empty.png")), "empty.png is empty.");
  assert.equal(attachmentProblem(new File(["%PDF"], "rules.pdf", { type: "application/pdf" })), null);
  assert.equal(formatBytes(2048), "2 KB");
});
