/**
 * Your Quests in the rail (#221, spec #69): which of the player's quests the
 * rail shows, how their due time reads, and ticking one off through the
 * existing quests API (GET /api/quests/mine, POST /api/quests/:id/done).
 *
 *   cd hearthside && npm test
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { ApiError } from "@gtd/shared/api";
import { createQuestStore, questWhen, railQuests, type Quest } from "../src/lib/quests";

const NOW = new Date("2026-11-10T18:00:00Z");
const HOUR = 3_600_000;
const at = (ms: number) => new Date(NOW.getTime() + ms).toISOString();

function quest(id: string, over: Partial<Quest> = {}, session: Partial<Quest["session"]> = {}): Quest {
  return {
    id, sessionId: `s-${id}`, kind: "custom", title: `Quest ${id}`, notes: null,
    assignee: { id: "me", name: "Me" }, dueAt: at(24 * HOUR), status: "open",
    reminderOffsets: [], remindersSent: [], createdBy: "gm", createdAt: at(-HOUR), completedAt: null,
    ...over,
    session: {
      id: `s-${id}`, title: "Night", date: at(24 * HOUR), endDate: null, status: "scheduled",
      campaign: { id: "c1", title: "The Sunken Lantern" }, ...session,
    },
  };
}

test("the rail shows open and done quests for sessions being planned or still to come", () => {
  const shown = railQuests([
    quest("open"),
    quest("done", { status: "done", completedAt: at(-HOUR) }),
    quest("planning", { dueAt: null }, { status: "planning", date: null }),
    quest("cancelled", { status: "cancelled" }),
    quest("session-completed", {}, { status: "completed" }),
    quest("session-cancelled", {}, { status: "cancelled" }),
    quest("long-past", { dueAt: at(-48 * HOUR) }, { date: at(-48 * HOUR) }),
  ], NOW);
  assert.deepEqual(shown.map((q) => q.id), ["open", "done", "planning"]);
});

test("a session stays on the rail until it has ended (its end, or four hours after its start)", () => {
  const started = (id: string, ago: number, endDate: string | null = null) =>
    quest(id, {}, { date: at(-ago), endDate });
  const shown = railQuests([
    started("3h ago", 3 * HOUR),
    started("5h ago", 5 * HOUR),
    started("5h ago, ends in 1h", 5 * HOUR, at(HOUR)),
    started("2h ago, ended 1h ago", 2 * HOUR, at(-HOUR)),
  ], NOW);
  assert.deepEqual(shown.map((q) => q.id), ["3h ago", "5h ago, ends in 1h"]);
});

test("a quest with no time yet says why", () => {
  assert.equal(questWhen(quest("p", { dueAt: null }, { status: "planning", date: null }), NOW), "When the night is set");
  assert.equal(questWhen(quest("n", { dueAt: null }, { date: null }), NOW), "No set time");
});

test("a quest's time is its due time, else its session's start, with the weekday when it's this week", () => {
  const soon = questWhen(quest("a", { dueAt: at(26 * HOUR) }), NOW);
  const weekday = new Date(at(26 * HOUR)).toLocaleDateString(undefined, { weekday: "short" });
  assert.ok(soon.startsWith(weekday), soon);
  assert.match(soon, /\d/);

  const fallback = questWhen(quest("b", { dueAt: null }, { date: at(26 * HOUR) }), NOW);
  assert.equal(fallback, soon);

  const later = questWhen(quest("c", { dueAt: at(20 * 24 * HOUR) }), NOW);
  const month = new Date(at(20 * 24 * HOUR)).toLocaleDateString(undefined, { month: "short" });
  assert.ok(later.includes(month), later);
});

/** A stand-in for the app's API client, answering from a table of handlers. */
function fakeApi(handlers: Record<string, (body?: unknown) => unknown>) {
  const calls: string[] = [];
  const call = async (method: string, path: string, body?: unknown) => {
    calls.push(`${method} ${path}`);
    const handler = handlers[`${method} ${path}`];
    if (!handler) throw new ApiError(`no route ${method} ${path}`, 404, { error: "Not found" });
    return handler(body);
  };
  return {
    calls,
    api: {
      get: (path: string) => call("GET", path),
      post: (path: string, body?: unknown) => call("POST", path, body),
    } as any,
  };
}

test("the store loads every quest of yours, keeps the rail's, and ticks one off for good", async () => {
  let stored = [quest("q1"), quest("q2"), quest("old", {}, { status: "completed" })];
  const { api, calls } = fakeApi({
    "GET /api/quests/mine?scope=all": () => ({ quests: stored }),
    "POST /api/quests/q1/done": () => {
      stored = stored.map((q) => (q.id === "q1" ? { ...q, status: "done", completedAt: at(0) } : q));
      return stored[0];
    },
  });
  const store = createQuestStore({ api, now: () => NOW });
  const seen: string[] = [];
  store.subscribe(() => seen.push(store.getState().status));

  await store.load();
  assert.deepEqual(store.getState().quests.map((q) => [q.id, q.status]), [["q1", "open"], ["q2", "open"]]);
  assert.equal(store.getState().status, "ready");
  assert.deepEqual(seen, ["loading", "ready"]);

  const ticking = store.complete("q1");
  // Ticked at once, before the server answers.
  assert.equal(store.getState().quests[0].status, "done");
  assert.ok(store.getState().ticking.has("q1"));
  await ticking;
  assert.ok(!store.getState().ticking.has("q1"));
  assert.equal(store.getState().quests[0].completedAt, at(0));

  // A reload (a fresh store, as after a page reload) still shows it done.
  const reloaded = createQuestStore({ api, now: () => NOW });
  await reloaded.load();
  assert.deepEqual(reloaded.getState().quests.map((q) => [q.id, q.status]), [["q1", "done"], ["q2", "open"]]);
  assert.deepEqual(calls, ["GET /api/quests/mine?scope=all", "POST /api/quests/q1/done", "GET /api/quests/mine?scope=all"]);
});

test("a tick the server refuses is undone, with the server's reason", async () => {
  const { api } = fakeApi({
    "GET /api/quests/mine?scope=all": () => ({ quests: [quest("q1")] }),
    "POST /api/quests/q1/done": () => { throw new ApiError("Conflict", 409, { error: "This quest was cancelled." }); },
  });
  const store = createQuestStore({ api, now: () => NOW });
  await store.load();
  await store.complete("q1");
  assert.equal(store.getState().quests[0].status, "open");
  assert.equal(store.getState().error, "This quest was cancelled.");
  assert.ok(!store.getState().ticking.has("q1"));
});

test("a load that started before a tick can't bring the old state back", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  let first = true;
  const { api } = fakeApi({
    "GET /api/quests/mine?scope=all": async () => {
      if (first) { first = false; return { quests: [quest("q1")] }; }
      await gate;
      return { quests: [quest("q1")] }; // a snapshot from before the tick
    },
    "POST /api/quests/q1/done": () => ({ ...quest("q1"), status: "done" }),
  });
  const store = createQuestStore({ api, now: () => NOW });
  await store.load();
  const stale = store.load();
  await store.complete("q1");
  release();
  await stale;
  assert.equal(store.getState().quests[0].status, "done");
});

test("a failed load says so, and signing out empties the rail", async () => {
  const { api } = fakeApi({});
  const store = createQuestStore({ api, now: () => NOW });
  await store.load();
  assert.equal(store.getState().status, "error");
  assert.ok(store.getState().error);
  store.reset();
  assert.deepEqual(store.getState().quests, []);
  assert.equal(store.getState().status, "idle");
});
