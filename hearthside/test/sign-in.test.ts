/**
 * Where Hearthside's signing-in pages send people (#219, spec #69): the return
 * URL login honours (a path on this site, nothing else), the links between
 * the pages that carry it along, and the return a signup keeps across the
 * email round trip, so that whoever signed up from an invite comes back to it
 * once their email is verified.
 *
 *   cd hearthside && npm test
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { RETURN_AFTER_SIGNUP_KEY, rememberReturn, returnTarget, takeReturn, withReturn } from "../src/lib/signIn";

test("login returns to the redirect when it's a path on this site, else to the Hearth", () => {
  assert.equal(returnTarget("?redirect=%2Fcampaigns%3Fx%3D1%23notice-board"), "/campaigns?x=1#notice-board");
  assert.equal(returnTarget("?redirect=/sessions/s1"), "/sessions/s1");
  assert.equal(returnTarget(""), "/");
  for (const away of ["https://evil.example/", "//evil.example", "/\\evil.example", "javascript:alert(1)", "campaigns"]) {
    assert.equal(returnTarget(`?redirect=${encodeURIComponent(away)}`), "/", away);
  }
});

test("a return to a signing-in page goes to the Hearth instead, so nobody signs in to be sent back to sign in", () => {
  for (const page of ["/login", "/login?redirect=%2F", "/signup", "/check-email", "/verify-email?token=x", "/forgot-password", "/reset-password?token=x"]) {
    assert.equal(returnTarget(`?redirect=${encodeURIComponent(page)}`), "/", page);
  }
});

test("links between the pages carry the return along, and leave it off when it's the Hearth", () => {
  assert.equal(withReturn("/signup", "/join/c1"), "/signup?redirect=%2Fjoin%2Fc1");
  assert.equal(withReturn("/login", "/"), "/login");
  assert.equal(withReturn("/login", "https://evil.example/"), "/login");
});

/** A stand-in for localStorage. */
function memoryStorage() {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, String(v)),
    removeItem: (k: string) => void m.delete(k),
    raw: m,
  };
}

test("a signup's return is kept until the email is verified, then taken once", () => {
  const s = memoryStorage();
  rememberReturn(s, "/join/c1", 1_000);
  assert.equal(takeReturn(s, 2_000), "/join/c1");
  assert.equal(takeReturn(s, 3_000), "/", "taken once");
});

test("the kept return lasts the day the verify link does, and is never anything but a path on this site", () => {
  const s = memoryStorage();
  rememberReturn(s, "/join/c1", 0);
  assert.equal(takeReturn(s, 25 * 60 * 60 * 1000), "/");

  rememberReturn(s, "/", 0);
  assert.equal(s.raw.has(RETURN_AFTER_SIGNUP_KEY), false, "the Hearth is the default: nothing to keep");

  s.setItem(RETURN_AFTER_SIGNUP_KEY, JSON.stringify({ path: "//evil.example", at: 0 }));
  assert.equal(takeReturn(s, 1), "/");
  s.setItem(RETURN_AFTER_SIGNUP_KEY, "not json");
  assert.equal(takeReturn(s, 1), "/");
});

test("no storage (private mode, a server render) is no return, not a crash", () => {
  const broken = { getItem: () => { throw new Error("denied"); }, setItem: () => { throw new Error("denied"); }, removeItem: () => {} };
  assert.doesNotThrow(() => rememberReturn(broken, "/join/c1"));
  assert.equal(takeReturn(broken), "/");
  assert.equal(takeReturn(null), "/");
});
