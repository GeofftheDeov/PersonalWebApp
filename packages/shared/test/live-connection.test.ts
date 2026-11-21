/**
 * The tab's one live-channel socket (#211, spec #69), and how it follows the
 * session (#210): it authenticates with the session cookie, reconnects once
 * someone signs in, reconnects when the signed-in person changes, and closes
 * on sign-out so the server can't keep it open as them.
 *
 * A stand-in session client drives the states; a stand-in LiveClient records
 * what was asked of it. The real LiveClient against the real server is the
 * backend's test-live-* suites.
 *
 *   cd packages/shared && npm test
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createLiveConnection, type LiveClient, type LiveClientOptions } from "@gtd/shared/realtime";
import type { SessionClient, SessionState } from "@gtd/shared/session";

function fakeSession(initial: SessionState) {
  let state = initial;
  const listeners = new Set<() => void>();
  const session = {
    getState: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  } as unknown as SessionClient;
  const set = (next: SessionState) => { state = next; for (const l of [...listeners]) l(); };
  return { session, set };
}

const signedIn = (id: string): SessionState => ({
  status: "signedIn",
  user: { id, email: `${id}@example.test`, name: id, handle: id, profilePicture: null } as never,
  capabilities: { appRole: null, paperclip: false } as never,
});
const signedOut: SessionState = { status: "signedOut", user: null, capabilities: null };
const loading: SessionState = { status: "loading", user: null, capabilities: null };

function recordingClient() {
  const made: { options: LiveClientOptions; calls: string[] }[] = [];
  const createClient = (options: LiveClientOptions) => {
    const calls: string[] = [];
    made.push({ options, calls });
    return { resume: () => calls.push("resume"), close: () => calls.push("close") } as unknown as LiveClient;
  };
  return { made, createClient };
}

test("one client per connection, made only when first asked for", () => {
  const { session } = fakeSession(loading);
  const { made, createClient } = recordingClient();
  const live = createLiveConnection({ session, url: () => "ws://t211.test/api/live", createClient });
  assert.equal(made.length, 0, "nothing connects until a component asks");
  const first = live.liveClient();
  assert.equal(live.liveClient(), first);
  assert.equal(made.length, 1);
});

test("the session cookie authenticates it: no token, cookieAuth on, same-origin /api/live by default URL", () => {
  const { session } = fakeSession(loading);
  const { made, createClient } = recordingClient();
  createLiveConnection({ session, url: () => "wss://t211.test/api/live", createClient }).liveClient();
  const { options } = made[0];
  assert.equal(options.getToken(), null);
  assert.equal(options.cookieAuth, true);
  assert.equal(typeof options.url === "function" ? options.url() : options.url, "wss://t211.test/api/live");
});

test("signing in resumes it, signing out closes it", () => {
  const { session, set } = fakeSession(loading);
  const { made, createClient } = recordingClient();
  createLiveConnection({ session, url: () => "ws://t211.test/api/live", createClient }).liveClient();
  const { calls } = made[0];
  set(signedIn("acc-1"));
  assert.deepEqual(calls, ["resume"]);
  set(signedOut);
  assert.deepEqual(calls, ["resume", "close"]);
  set(signedIn("acc-1"));
  assert.deepEqual(calls, ["resume", "close", "resume"]);
});

test("a socket first made while someone is signed in is theirs: the next person gets a fresh one", () => {
  // The usual case: the session is known before the dock or Table Talk first
  // asks for the client, so no change notification names the first person.
  const { session, set } = fakeSession(signedIn("acc-1"));
  const { made, createClient } = recordingClient();
  createLiveConnection({ session, url: () => "ws://t211.test/api/live", createClient }).liveClient();
  const { calls } = made[0];
  set(signedIn("acc-2"));
  assert.deepEqual(calls, ["close", "resume"]);
});

test("someone else signing in without a sign-out first gets a fresh socket", () => {
  const { session, set } = fakeSession(signedIn("acc-1"));
  const { made, createClient } = recordingClient();
  createLiveConnection({ session, url: () => "ws://t211.test/api/live", createClient }).liveClient();
  const { calls } = made[0];
  set(signedIn("acc-1")); // a refresh of the same person changes nothing on the socket
  assert.deepEqual(calls, ["resume"]);
  set(signedIn("acc-2"));
  assert.deepEqual(calls, ["resume", "close", "resume"]);
});
