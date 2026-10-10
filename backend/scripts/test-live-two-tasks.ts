/**
 * The live channel across two backend tasks (#106, spec #58 story 37: "live
 * delivery works when prod runs more than one backend task").
 *
 * Starts two real backend processes ("task A" and "task B"), each wired the
 * way server.ts wires one: the message and thread routers, the live channel
 * through `startLiveChannel` on the process's own bus, and that bus started.
 * The two share nothing but Redis and Postgres, which is how two ECS tasks
 * look. Clients connect to one task or the other, and every check is about a
 * frame crossing from one process to the other:
 *   - a campaign message sent through task A reaches the members on task B,
 *     and one sent through task B reaches task A, each exactly once, and
 *     never an outsider;
 *   - `thread.updated` reaches members on the other task with their own
 *     unread count;
 *   - a read on task A sends `thread.read` to the reader's other device on
 *     task B, and to nobody else;
 *   - typing on a socket on task A reaches the thread's members on task B,
 *     but not the typist's own device there;
 *   - a friend DM sent through task A reaches the other one of the pair on
 *     task B, and DM typing crosses back;
 *   - each task's log names the people whose sockets it holds, and the task
 *     (what the dev check reads from CloudWatch);
 *   - access follows membership across tasks (#105): someone who leaves
 *     through task A stops getting the campaign's messages, thread.updated
 *     and typing on task B, on the same socket; and a socket whose token
 *     expires is closed (4001) by its task while the person's other sockets,
 *     on either task, carry on.
 *
 * Needs a throwaway database loaded from db/schema.sql and a local Redis (it
 * refuses anything but localhost for either). It deletes every row it creates.
 *   REDIS_URL=redis://127.0.0.1:6379 EVENT_BUS_NAMESPACE=t106 \
 *   DATABASE_URL=postgresql://postgres@127.0.0.1:5433/pwatest npx tsx scripts/test-live-two-tasks.ts
 */
import "./use-test-jwt-secret.js";
import { spawn, type ChildProcess } from "child_process";
import { fileURLToPath } from "url";
import WebSocket from "ws";

const TASK_FLAG = "--t106-task";

if (!/(\/\/|@)(127\.0\.0\.1|localhost)[:/]/.test(process.env.DATABASE_URL ?? "")) {
  console.error("\n  Refusing to run: DATABASE_URL must be a local throwaway database.\n");
  process.exit(2);
}
if (!/\/\/(127\.0\.0\.1|localhost)[:/]/.test(process.env.REDIS_URL ?? "")) {
  console.error("\n  Refusing to run: REDIS_URL must be set to a local Redis (two tasks share nothing else).\n");
  process.exit(2);
}

/* ------------------------------------------------------------------ */
/* Task mode: one backend process, wired like server.ts               */
/* ------------------------------------------------------------------ */

async function runTask() {
  const express = (await import("express")).default;
  const http = await import("http");
  const { default: messageRoutes } = await import("../routes/messageRoutes.js");
  const { default: threadRoutes } = await import("../routes/threadRoutes.js");
  const { default: campaignMemberRoutes } = await import("../routes/campaignMemberRoutes.js");
  const { startEventBus, stopEventBus } = await import("../events/index.js");
  const { startLiveChannel } = await import("../live/startLiveChannel.js");
  const app = express();
  app.use(express.json());
  app.use("/api/messages", messageRoutes);
  app.use("/api/threads", threadRoutes);
  app.use("/api/campaign-members", campaignMemberRoutes);
  await startEventBus();
  const server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const live = startLiveChannel(server);
  await live.ready;
  const { port } = server.address() as { port: number };
  console.log(`T106-TASK-READY ${port}`);
  const stop = async () => {
    await live.close();
    await stopEventBus();
    server.close();
    process.exit(0);
  };
  process.on("disconnect", stop); // the test went away
  process.on("message", (m) => { if (m === "stop") void stop(); });
}

/* ------------------------------------------------------------------ */
/* Test mode                                                           */
/* ------------------------------------------------------------------ */

let pass = 0, fail = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : `\n          ${detail}`}`);
  ok ? pass++ : fail++;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, ms = 5_000) {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await sleep(20);
  return cond();
}

const RUN = Math.random().toString(36).slice(2, 8);

type Person = { id: string; email: string };
type Frame = { type: string; [k: string]: any };
/** A raw protocol client that authenticates with the first frame and records every frame. */
type Client = {
  ws: WebSocket;
  frames: Frame[];
  readonly closeCode: number | null;
  ready(): Promise<boolean>;
  /** The threads the latest `ready` listed. */
  threads(): string[];
  of(type: string, thread?: string): Frame[];
  typing(thread: string): void;
};

/** One backend task: a child process, its port and everything it logged. */
type Task = { name: string; port: number; log: string[]; child: ChildProcess; base: string; wsUrl: string };

function startTask(name: string): Promise<Task> {
  const child = spawn(process.execPath, [...process.execArgv, fileURLToPath(import.meta.url), TASK_FLAG], {
    env: process.env,
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  const log: string[] = [];
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`task ${name} did not start:\n${log.join("\n")}`)), 30_000);
    const onLine = (line: string) => {
      log.push(line);
      const ready = /^T106-TASK-READY (\d+)$/.exec(line);
      if (ready) {
        clearTimeout(timer);
        const port = Number(ready[1]);
        resolve({ name, port, log, child, base: `http://127.0.0.1:${port}`, wsUrl: `ws://127.0.0.1:${port}/api/live` });
      }
    };
    for (const stream of [child.stdout!, child.stderr!]) {
      let buffered = "";
      stream.on("data", (chunk) => {
        buffered += String(chunk);
        const lines = buffered.split(/\r?\n/);
        buffered = lines.pop()!;
        lines.forEach(onLine);
      });
    }
    child.on("exit", (code) => { clearTimeout(timer); reject(new Error(`task ${name} exited (${code}):\n${log.join("\n")}`)); });
  });
}

async function main() {
  const { default: pool } = await import("../db/index.js");
  const { signJwt } = await import("../utils/jwt.js");
  const { PROTOCOL_VERSION } = await import("../live/liveChannel.js");
  const { campaignThreadKey, dmThreadKey } = await import("../services/threads.js");

  const created = { accounts: [] as string[], campaigns: [] as string[] };
  const account = async (handle: string): Promise<Person> => {
    const { rows } = await pool.query(
      `INSERT INTO accounts (id, handle, name, email) VALUES (gen_random_uuid(), $1, $2, $3) RETURNING id, email`,
      [`t106-${handle}-${RUN}`, `${handle} name`, `t106.${handle}.${RUN}@example.test`]);
    created.accounts.push(rows[0].id);
    return { id: rows[0].id, email: rows[0].email };
  };
  const campaign = async (title: string) => {
    const { rows } = await pool.query(
      `INSERT INTO campaigns (title, status) VALUES ($1, 'In Progress') RETURNING id`, [`t106 ${title} ${RUN}`]);
    created.campaigns.push(rows[0].id);
    return rows[0].id as string;
  };
  const member = (campaignId: string, p: Person) => pool.query(
    `INSERT INTO campaign_members (campaign_id, person_id, status) VALUES ($1, $2, 'Active')`, [campaignId, p.id]);
  const befriend = async (a: Person, b: Person) => {
    await pool.query(`UPDATE accounts SET friends = array_append(friends, $2) WHERE id = $1`, [a.id, b.id]);
    await pool.query(`UPDATE accounts SET friends = array_append(friends, $2) WHERE id = $1`, [b.id, a.id]);
  };
  const cleanup = async () => {
    const { accounts, campaigns } = created;
    if (!accounts.length && !campaigns.length) return;
    await pool.query(`DELETE FROM thread_reads WHERE person_id = ANY($1::uuid[])`, [accounts]);
    await pool.query(`DELETE FROM messages WHERE campaign_id = ANY($1::uuid[]) OR sender_id = ANY($2::text[])`,
      [campaigns, accounts]);
    await pool.query(`DELETE FROM notifications WHERE user_id = ANY($1::uuid[])`, [accounts]);
    await pool.query(`DELETE FROM campaigns WHERE id = ANY($1::uuid[])`, [campaigns]);
    await pool.query(`DELETE FROM accounts WHERE id = ANY($1::uuid[])`, [accounts]);
  };
  const tokenFor = (p: Person, expiresIn?: number) =>
    signJwt({ id: p.id, email: p.email }, expiresIn ? { expiresIn } : undefined);

  const opened: Client[] = [];
  function client(task: Task, who: Person, token = tokenFor(who)): Client {
    const ws = new WebSocket(task.wsUrl);
    const frames: Frame[] = [];
    let closeCode: number | null = null;
    ws.on("error", () => { /* surfaces as close */ });
    ws.on("close", (code) => { closeCode = code; });
    ws.on("open", () => ws.send(JSON.stringify({ type: "auth", v: PROTOCOL_VERSION, token })));
    ws.on("message", (data) => {
      let frame: Frame;
      try { frame = JSON.parse(String(data)); } catch { return; }
      frames.push(frame);
      if (frame.type === "ping") ws.send(JSON.stringify({ type: "pong" }));
    });
    const c: Client = {
      ws, frames,
      get closeCode() { return closeCode; },
      ready: () => until(() => frames.some((f) => f.type === "ready")),
      threads: () => frames.filter((f) => f.type === "ready").at(-1)?.threads ?? [],
      of: (type: string, thread?: string) => frames.filter((f) => f.type === type && (!thread || f.thread === thread)),
      typing: (thread: string) => ws.send(JSON.stringify({ type: "typing", thread })),
    };
    opened.push(c);
    return c;
  }
  const post = async (task: Task, path: string, who: Person, body: unknown, want = 201) => {
    const res = await fetch(`${task.base}${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${tokenFor(who)}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (res.status !== want) throw new Error(`POST ${path} on task ${task.name} → ${res.status} ${await res.text()}`);
    return await res.json() as any;
  };
  const sendTo = async (task: Task, thread: string, who: Person, body: string): Promise<{ id: string }> =>
    (await post(task, `/api/threads/${encodeURIComponent(thread)}/messages`, who, { body })).message;
  const got = (c: Client, messageId: string) =>
    c.of("message.created").filter((f) => f.message?.id === messageId).length;

  const tasks: Task[] = [];
  try {
    console.log(`\n  two backend processes on one Redis (namespace ${process.env.EVENT_BUS_NAMESPACE || "none"})`);
    const [A, B] = await Promise.all([startTask("A"), startTask("B")]);
    tasks.push(A, B);
    check("the two tasks are separate processes", A.child.pid !== B.child.pid && A.port !== B.port);

    const alice = await account("alice");
    const bob = await account("bob");
    const mara = await account("mara");
    const outsider = await account("outsider");
    const table = await campaign("Storm King's Thunder");
    for (const p of [alice, bob, mara]) await member(table, p);
    await befriend(alice, bob);
    const thread = campaignThreadKey(table);
    const dm = dmThreadKey(alice.id, bob.id);

    // alice's laptop on A, her phone on B; bob and mara on B; outsiders on both.
    const aliceLaptop = client(A, alice);
    const alicePhone = client(B, alice);
    const bobSocket = client(B, bob);
    const maraSocket = client(B, mara);
    const outsiderA = client(A, outsider);
    const outsiderB = client(B, outsider);
    const bobOnA = client(A, bob); // so a message sent through B has someone on A to reach besides alice
    check("every socket gets ready", (await Promise.all(opened.map((c) => c.ready()))).every(Boolean));

    console.log("\nmessage.created crosses tasks\n");

    const fromA = await sendTo(A, thread, alice, `from A ${RUN}`);
    check("a campaign message sent through task A reaches bob and mara on task B",
      await until(() => got(bobSocket, fromA.id) === 1 && got(maraSocket, fromA.id) === 1),
      `bob ${JSON.stringify(bobSocket.frames)} | mara ${JSON.stringify(maraSocket.frames)}`);
    check("...and the sender's own phone on task B", await until(() => got(alicePhone, fromA.id) === 1),
      JSON.stringify(alicePhone.frames));
    const fromB = await sendTo(B, thread, bob, `from B ${RUN}`);
    check("one sent through task B reaches alice and bob's other socket on task A",
      await until(() => got(aliceLaptop, fromB.id) === 1 && got(bobOnA, fromB.id) === 1),
      JSON.stringify(aliceLaptop.frames));
    await sleep(400);
    check("each socket got each message exactly once",
      [aliceLaptop, alicePhone, bobSocket, bobOnA, maraSocket].every((c) => got(c, fromA.id) === 1 && got(c, fromB.id) === 1),
      [aliceLaptop, alicePhone, bobSocket, bobOnA, maraSocket].map((c) => `${got(c, fromA.id)}/${got(c, fromB.id)}`).join(" "));
    check("outsiders on either task got nothing",
      outsiderA.of("message.created").length === 0 && outsiderB.of("message.created").length === 0);

    console.log("\nthread.updated and thread.read cross tasks\n");

    const updated = (c: Client) => c.of("thread.updated", thread);
    check("thread.updated reaches mara on task B for both messages, with her own unread count",
      await until(() => updated(maraSocket).length === 2) && updated(maraSocket).map((f) => f.unreadCount).join() === "1,2",
      JSON.stringify(updated(maraSocket)));
    check("alice's laptop on task A gets it for bob's message, with her count at 1 (her own isn't unread)",
      await until(() => updated(aliceLaptop).some((f) => f.unreadCount === 1)), JSON.stringify(updated(aliceLaptop)));
    check("...exactly one per message per socket",
      updated(aliceLaptop).length === 2 && updated(alicePhone).length === 2 && updated(bobSocket).length === 2,
      [aliceLaptop, alicePhone, bobSocket].map((c) => updated(c).length).join(","));

    await post(A, `/api/threads/${encodeURIComponent(thread)}/read`, alice, { messageId: fromB.id }, 200);
    const reads = (c: Client) => c.of("thread.read", thread);
    check("alice reading through task A sends thread.read to her phone on task B",
      await until(() => reads(alicePhone).length === 1), JSON.stringify(alicePhone.frames));
    check("...with the read position and unread count 0",
      reads(alicePhone)[0]?.lastReadMessageId === fromB.id && reads(alicePhone)[0]?.unreadCount === 0,
      JSON.stringify(reads(alicePhone)[0]));
    check("...and to her laptop on task A", await until(() => reads(aliceLaptop).length === 1));
    await sleep(300);
    check("nobody else gets alice's read", [bobSocket, bobOnA, maraSocket, outsiderA, outsiderB]
      .every((c) => c.of("thread.read").length === 0));

    console.log("\ntyping crosses tasks\n");

    aliceLaptop.typing(thread);
    const typing = (c: Client, t = thread) => c.of("typing", t);
    check("alice typing on task A reaches bob and mara on task B",
      await until(() => typing(bobSocket).length === 1 && typing(maraSocket).length === 1),
      `bob ${JSON.stringify(typing(bobSocket))} mara ${JSON.stringify(typing(maraSocket))}`);
    check("...naming alice", typing(maraSocket)[0]?.personId === alice.id, JSON.stringify(typing(maraSocket)[0]));
    await sleep(400);
    check("alice's own phone on task B never sees her typing", typing(alicePhone).length === 0,
      JSON.stringify(typing(alicePhone)));
    check("outsiders on either task never see it", typing(outsiderA).length === 0 && typing(outsiderB).length === 0);

    console.log("\nfriend DMs cross tasks\n");

    const dmFromA = await sendTo(A, dm, alice, `dm from A ${RUN}`);
    check("a DM sent through task A reaches bob on task B",
      await until(() => got(bobSocket, dmFromA.id) === 1), JSON.stringify(bobSocket.of("message.created")));
    await sleep(300);
    check("...and not mara, who shares a campaign with them but isn't in the DM",
      maraSocket.of("message.created", dm).length === 0);
    bobSocket.typing(dm);
    check("bob typing in the DM on task B reaches alice on task A",
      await until(() => typing(aliceLaptop, dm).length === 1), JSON.stringify(aliceLaptop.of("typing")));
    await sleep(300);
    check("...and not mara", typing(maraSocket, dm).length === 0);

    console.log("\nthe logs say which task holds each socket\n");

    const opens = (task: Task, p: Person) =>
      task.log.filter((l) => l.startsWith("[live] socket open:") && l.includes(`person ${p.id}`));
    check("task A logs alice's laptop, bob's second socket and an outsider, and nothing else",
      opens(A, alice).length === 1 && opens(A, bob).length === 1 && opens(A, outsider).length === 1
        && opens(A, mara).length === 0,
      A.log.filter((l) => l.startsWith("[live]")).join("\n          "));
    check("task B logs alice's phone, bob, mara and an outsider",
      [alice, bob, mara, outsider].every((p) => opens(B, p).length === 1),
      B.log.filter((l) => l.startsWith("[live]")).join("\n          "));
    const taskOf = (line: string | undefined) => line?.match(/task (\S+)$/)?.[1];
    check("each line names its task, and the two tasks' names differ",
      !!taskOf(opens(A, alice)[0]) && !!taskOf(opens(B, alice)[0]) && taskOf(opens(A, alice)[0]) !== taskOf(opens(B, alice)[0]),
      `${opens(A, alice)[0]} | ${opens(B, alice)[0]}`);
    outsiderA.ws.close();
    check("a socket closing is logged by its task, with how long it was open",
      await until(() => A.log.some((l) => /^\[live\] socket closed: person \S+, code \d+, after \d+s, task \S+$/.test(l)
        && l.includes(outsider.id))),
      A.log.filter((l) => l.startsWith("[live]")).join("\n          "));

    // Cross-ticket (integration, spec #58): #105's access changes and token
    // expiry on #106's two tasks.
    console.log("\naccess changes and token expiry cross tasks\n");

    const { rows: [maraMembership] } = await pool.query(
      `SELECT id FROM campaign_members WHERE campaign_id = $1 AND person_id = $2`, [table, mara.id]);
    const leave = await fetch(`${A.base}/api/campaign-members/${maraMembership.id}`,
      { method: "DELETE", headers: { authorization: `Bearer ${tokenFor(mara)}` } });
    check("mara leaves the campaign through task A", leave.ok, `status ${leave.status}`);
    check("...and her socket on task B gets a fresh ready without it, on the same connection",
      await until(() => !maraSocket.threads().includes(thread)) && maraSocket.ws.readyState === WebSocket.OPEN,
      JSON.stringify(maraSocket.threads()));
    const maraBefore = { updated: maraSocket.of("thread.updated", thread).length, typing: maraSocket.of("typing", thread).length };
    const bobTypingBefore = typing(bobSocket).length;
    const afterLeave = await sendTo(A, thread, alice, `after mara left ${RUN}`);
    await sleep(300); // past the server's typing guard since alice's last frame
    aliceLaptop.typing(thread);
    check("a message and typing through task A after she left still reach bob on task B",
      await until(() => got(bobSocket, afterLeave.id) === 1 && typing(bobSocket).length === bobTypingBefore + 1),
      `${got(bobSocket, afterLeave.id)} / ${typing(bobSocket).length}`);
    await sleep(400);
    check("...but not mara: no message.created, thread.updated or typing",
      got(maraSocket, afterLeave.id) === 0
        && maraSocket.of("thread.updated", thread).length === maraBefore.updated
        && maraSocket.of("typing", thread).length === maraBefore.typing,
      JSON.stringify(maraSocket.frames.slice(-5)));

    const shortLived = client(B, alice, tokenFor(alice, 2));
    check("alice opens a third socket on task B with a token about to expire", await shortLived.ready());
    check("...task B closes it with 4001 when the token expires",
      await until(() => shortLived.closeCode === 4001, 5_000), `close code ${shortLived.closeCode}`);
    const afterExpiry = await sendTo(B, thread, bob, `after expiry ${RUN}`);
    check("...while her other sockets, on both tasks, stay open and keep getting messages",
      await until(() => got(aliceLaptop, afterExpiry.id) === 1 && got(alicePhone, afterExpiry.id) === 1)
        && aliceLaptop.ws.readyState === WebSocket.OPEN && alicePhone.ws.readyState === WebSocket.OPEN);
  } finally {
    for (const c of opened) c.ws.terminate();
    for (const t of tasks) {
      const exited = new Promise((r) => t.child.once("exit", r));
      t.child.send("stop");
      await Promise.race([exited, sleep(5_000)]);
      if (t.child.exitCode === null) t.child.kill();
    }
    await cleanup().catch((err: any) => console.error("cleanup failed:", err.message));
    await pool.end();
  }

  console.log(`\n  ${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
}

if (process.argv.includes(TASK_FLAG)) {
  runTask().catch((err) => { console.error(err); process.exit(1); });
} else {
  main().catch((err) => { console.error(err); process.exit(1); });
}
