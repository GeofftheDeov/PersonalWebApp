/**
 * Letters attachments (#104, spec #58): images and PDFs on thread messages.
 *
 *   POST /api/threads/:threadKey/attachments { name, contentType, size, width?, height? }
 *        → a presigned PUT and a key under the thread's prefix, recorded as
 *          issued to this sender for this thread
 *   POST /api/threads/:threadKey/messages { body?, attachments: [key] }
 *   GET  /api/threads/:threadKey/messages → attachments with short-lived URLs
 *   live `message.created` frames carry the same, URLs minted per frame
 *
 * Real routers and the real live channel over HTTP and WebSocket; S3 is the
 * recording fake from testing/fakeIntegrations.ts, so every presign is seen.
 *
 * Run against a throwaway database loaded from db/schema.sql (it refuses to run
 * against anything but localhost). It deletes every row it creates.
 *   DATABASE_URL=postgresql://postgres@127.0.0.1:5433/pwatest npx tsx scripts/test-attachments.ts
 */
import "./use-test-jwt-secret.js";
import express from "express";
import http from "http";
import type { AddressInfo } from "net";
import WebSocket from "ws";
import pool from "../db/index.js";
import { signJwt } from "../utils/jwt.js";
import { UploadsNotConfiguredError } from "../utils/integrations.js";
import { createFakeIntegrations } from "../testing/fakeIntegrations.js";
import { attachLiveChannel, LIVE_PATH, PROTOCOL_VERSION } from "../live/liveChannel.js";

if (!/(\/\/|@)(127\.0\.0\.1|localhost)[:/]/.test(process.env.DATABASE_URL ?? "")) {
  console.error("\n  Refusing to run: DATABASE_URL must be a local throwaway database.\n");
  process.exit(2);
}

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
const created = { accounts: [] as string[], campaigns: [] as string[] };

async function account(handle: string, appRole: "user" | "admin" = "user"): Promise<Person> {
  const { rows } = await pool.query(
    `INSERT INTO accounts (id, handle, name, email, app_role) VALUES (gen_random_uuid(), $1, $2, $3, $4) RETURNING id, email`,
    [`t104-${handle}-${RUN}`, `${handle} name`, `t104.${handle}.${RUN}@example.test`, appRole]);
  created.accounts.push(rows[0].id);
  return { id: rows[0].id, email: rows[0].email };
}

async function campaign(title: string): Promise<string> {
  const { rows } = await pool.query(
    `INSERT INTO campaigns (title, status) VALUES ($1, 'In Progress') RETURNING id`, [`t104 ${title} ${RUN}`]);
  created.campaigns.push(rows[0].id);
  return rows[0].id;
}

async function member(campaignId: string, person: Person, status = "Active") {
  await pool.query(`INSERT INTO campaign_members (campaign_id, person_id, status) VALUES ($1, $2, $3)`,
    [campaignId, person.id, status]);
}

async function befriend(a: Person, b: Person) {
  await pool.query(`UPDATE accounts SET friends = array_append(friends, $2) WHERE id = $1`, [a.id, b.id]);
  await pool.query(`UPDATE accounts SET friends = array_append(friends, $2) WHERE id = $1`, [b.id, a.id]);
}

async function cleanup() {
  const { accounts, campaigns } = created;
  if (!accounts.length && !campaigns.length) return;
  await pool.query(`DELETE FROM message_attachment_uploads WHERE sender_id = ANY($1::text[])`, [accounts]);
  await pool.query(`DELETE FROM messages WHERE campaign_id = ANY($1::uuid[]) OR sender_id = ANY($2::text[])`,
    [campaigns, accounts]);
  await pool.query(`DELETE FROM notifications WHERE user_id = ANY($1::uuid[])`, [accounts]);
  await pool.query(`DELETE FROM campaigns WHERE id = ANY($1::uuid[])`, [campaigns]);
  await pool.query(`DELETE FROM accounts WHERE id = ANY($1::uuid[])`, [accounts]);
}

type Frame = { type: string; [k: string]: any };
function client(url: string, first: unknown) {
  const ws = new WebSocket(url);
  const frames: Frame[] = [];
  ws.on("error", () => { /* surfaces as close */ });
  ws.on("open", () => ws.send(JSON.stringify(first)));
  ws.on("message", (data) => {
    let frame: Frame;
    try { frame = JSON.parse(String(data)); } catch { return; }
    frames.push(frame);
    if (frame.type === "ping") ws.send(JSON.stringify({ type: "pong" }));
  });
  return {
    ws, frames,
    ready: () => until(() => frames.some((f) => f.type === "ready")),
    messages: () => frames.filter((f) => f.type === "message.created"),
  };
}

const MB = 1024 * 1024;

async function main() {
  const fake = createFakeIntegrations();
  const uninstall = fake.install();

  const { default: threadRoutes } = await import("../routes/threadRoutes.js");
  const app = express();
  app.use(express.json());
  app.use("/api/threads", threadRoutes);
  const server = http.createServer(app);
  const live = await attachLiveChannel(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as AddressInfo).port;
  const base = `http://127.0.0.1:${port}`;
  const wsUrl = `ws://127.0.0.1:${port}${LIVE_PATH}`;

  const call = async (method: string, path: string, who: Person, body?: unknown) => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { "content-type": "application/json", authorization: `Bearer ${signJwt({ id: who.id, email: who.email })}` },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json: any = null;
    try { json = JSON.parse(text); } catch { /* not json */ }
    return { status: res.status, json };
  };
  const enc = encodeURIComponent;
  const upload = (who: Person, key: string, body: unknown) => call("POST", `/api/threads/${enc(key)}/attachments`, who, body);
  const send = (who: Person, key: string, body: unknown) => call("POST", `/api/threads/${enc(key)}/messages`, who, body);
  const history = (who: Person, key: string) => call("GET", `/api/threads/${enc(key)}/messages`, who);

  const sockets: ReturnType<typeof client>[] = [];
  try {
    const gm = await account("gm");
    const player = await account("player");
    const friend = await account("friend");
    const stranger = await account("stranger");
    const admin = await account("admin", "admin");

    const camp = await campaign("Tomb of Annihilation");
    await member(camp, gm, "Game Master");
    await member(camp, player);
    const other = await campaign("Other table");
    await member(other, player);
    await befriend(player, friend);

    const campKey = `campaign:${camp}`;
    const otherKey = `campaign:${other}`;
    const dmKey = `dm:${[player.id, friend.id].sort().join(":")}`;

    /* -------------------------------------------------------------- */
    console.log("\nUpload URLs\n");

    fake.clear();
    const tooBig = await upload(player, campKey, { name: "huge.png", contentType: "image/png", size: 10 * MB + 1 });
    check("a file over 10 MB is refused with a clear error",
      tooBig.status === 400 && /10 MB/.test(tooBig.json?.error ?? ""), JSON.stringify(tooBig));
    const exactly10 = await upload(player, campKey, { name: "big.png", contentType: "image/png", size: 10 * MB });
    check("exactly 10 MB is accepted", exactly10.status === 201, JSON.stringify(exactly10));

    const svg = await upload(player, campKey, { name: "x.svg", contentType: "image/svg+xml", size: 100 });
    check("an unsupported type (SVG) is refused with a clear error",
      svg.status === 400 && /JPEG, PNG, WebP or GIF image, or a PDF/.test(svg.json?.error ?? ""), JSON.stringify(svg));
    const noSize = await upload(player, campKey, { name: "a.png", contentType: "image/png" });
    check("a request without a size is refused", noSize.status === 400, JSON.stringify(noSize));

    const outsider = await upload(stranger, campKey, { name: "a.png", contentType: "image/png", size: 100 });
    check("a non-member gets 403", outsider.status === 403, JSON.stringify(outsider));
    const adminOutsider = await upload(admin, campKey, { name: "a.png", contentType: "image/png", size: 100 });
    // The Threads module's one check: admins can read and send in any thread over REST, so they can attach too.
    check("an admin who isn't a member follows the send rule (allowed)", adminOutsider.status === 201, JSON.stringify(adminOutsider));
    const badKey = await upload(player, "campaign:not-a-uuid", { name: "a.png", contentType: "image/png", size: 100 });
    check("a malformed thread key is a 400", badKey.status === 400, JSON.stringify(badKey));

    const presigns = fake.calls("uploads.presignPut");
    check("only the accepted requests reached S3", presigns.length === 2, `${presigns.length} presign calls`);

    fake.clear();
    const map = await upload(player, campKey, {
      name: "C:\\maps\\Chult\u0007 map.png", contentType: "IMAGE/PNG", size: 2 * MB, width: 1600, height: 1200,
    });
    const mapKey: string = map.json?.key ?? "";
    check("an accepted request returns a presigned PUT, its headers and the 10 MB limit",
      map.status === 201 && map.json?.method === "PUT" && /^https:\/\/fake-uploads\.test\//.test(map.json?.url)
        && map.json?.headers?.["Content-Type"] === "image/png" && map.json?.maxBytes === 10 * MB, JSON.stringify(map.json));
    check("the key is namespaced by thread and minted by the server",
      new RegExp(`^message-attachments/campaign/${camp}/[0-9a-f-]{36}\\.png$`).test(mapKey), mapKey);
    const [put] = fake.calls("uploads.presignPut");
    check("the presign signs the exact type and size",
      put?.args[0].contentType === "image/png" && put?.args[0].contentLength === 2 * MB && put?.args[0].key === mapKey,
      JSON.stringify(put?.args));
    const { rows: [issued] } = await pool.query(`SELECT * FROM message_attachment_uploads WHERE key = $1`, [mapKey]);
    check("the key is recorded as issued to this sender for this thread, with a clean name",
      issued?.sender_id === player.id && issued?.thread_key === campKey && issued?.name === "Chult map.png"
        && issued?.width === 1600 && issued?.height === 1200, JSON.stringify(issued));

    const pdf = await upload(player, campKey, { name: "handout.pdf", contentType: "application/pdf", size: 300_000, width: 9, height: 9 });
    const pdfKey: string = pdf.json?.key ?? "";
    const { rows: [pdfRow] } = await pool.query(`SELECT width, height FROM message_attachment_uploads WHERE key = $1`, [pdfKey]);
    check("a PDF is accepted and never stores image dimensions",
      pdf.status === 201 && pdfKey.endsWith(".pdf") && pdfRow?.width === null && pdfRow?.height === null, JSON.stringify(pdfRow));

    const dmUpload = await upload(player, dmKey, { name: "dice.gif", contentType: "image/gif", size: 5000 });
    check("DM uploads are namespaced by the pair",
      new RegExp(`^message-attachments/dm/${[player.id, friend.id].sort().join("/")}/[0-9a-f-]{36}\\.gif$`).test(dmUpload.json?.key ?? ""),
      JSON.stringify(dmUpload.json));

    fake.fail("uploads.presignPut", new UploadsNotConfiguredError());
    const off = await upload(player, campKey, { name: "a.png", contentType: "image/png", size: 100 });
    check("with uploads switched off the answer is a clear 503", off.status === 503 && /set up/.test(off.json?.error ?? ""),
      JSON.stringify(off));

    /* -------------------------------------------------------------- */
    console.log("\nSending\n");

    const gmSocket = client(wsUrl, { type: "auth", v: PROTOCOL_VERSION, token: signJwt({ id: gm.id, email: gm.email }) });
    const strangerSocket = client(wsUrl, { type: "auth", v: PROTOCOL_VERSION, token: signJwt({ id: stranger.id, email: stranger.email }) });
    const adminSocket = client(wsUrl, { type: "auth", v: PROTOCOL_VERSION, token: signJwt({ id: admin.id, email: admin.email }) });
    sockets.push(gmSocket, strangerSocket, adminSocket);
    await Promise.all(sockets.map((s) => s.ready()));

    const empty = await send(player, campKey, { body: "   " });
    check("a message with neither a body nor an attachment is refused", empty.status === 400, JSON.stringify(empty));
    const emptyList = await send(player, campKey, { body: "", attachments: [] });
    check("an empty attachment list doesn't count as an attachment", emptyList.status === 400, JSON.stringify(emptyList));

    fake.clear();
    const only = await send(player, campKey, { attachments: [mapKey], clientId: `t104-only-${RUN}` });
    const sentMsg = only.json?.message;
    check("a message with only an attachment sends (201)", only.status === 201, JSON.stringify(only));
    check("it comes back with the attachment's metadata and a read URL",
      sentMsg?.body === "" && sentMsg?.attachments?.length === 1 && sentMsg.attachments[0].key === mapKey
        && sentMsg.attachments[0].name === "Chult map.png" && sentMsg.attachments[0].size === 2 * MB
        && sentMsg.attachments[0].contentType === "image/png" && sentMsg.attachments[0].width === 1600
        && typeof sentMsg.attachments[0].url === "string" && typeof sentMsg.attachments[0].expiresAt === "string",
      JSON.stringify(sentMsg));
    const reads = fake.calls("uploads.readUrl");
    check("read URLs are private presigned GETs that expire within the hour",
      reads.length >= 1 && reads.every((c) => c.args[0].private === true && (c.args[0].expiresInSeconds ?? 0) <= 3600),
      JSON.stringify(reads.map((c) => c.args[0])));

    const liveOk = await until(() => gmSocket.messages().some((f) => f.message?.id === sentMsg?.id));
    const liveFrame = gmSocket.messages().find((f) => f.message?.id === sentMsg?.id);
    check("a live member gets the message with the attachment and its URL, no reload",
      liveOk && liveFrame?.message?.attachments?.[0]?.key === mapKey
        && /^https:\/\/fake-uploads\.test\//.test(liveFrame?.message?.attachments?.[0]?.url ?? ""), JSON.stringify(liveFrame));
    await sleep(200);
    check("a non-member's socket gets nothing", !strangerSocket.messages().length, JSON.stringify(strangerSocket.messages()));
    check("a non-member admin's socket gets nothing", !adminSocket.messages().length, JSON.stringify(adminSocket.messages()));
    const { rows: [bell] } = await pool.query(
      `SELECT body FROM notifications WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1`, [gm.id]);
    check("the bell names the attachment for a message without text",
      typeof bell?.body === "string" && bell.body.includes("Sent Chult map.png"), JSON.stringify(bell));

    const both = await send(player, campKey, { body: "Map and handout for Saturday", attachments: [pdfKey, mapKey] });
    check("a body and two attachments send, in the order given",
      both.status === 201 && both.json?.message?.attachments?.map((a: any) => a.key).join() === [pdfKey, mapKey].join(),
      JSON.stringify(both.json));

    const otherThreadKey = (await upload(player, otherKey, { name: "o.png", contentType: "image/png", size: 10 })).json?.key;
    const wrongThread = await send(player, campKey, { body: "x", attachments: [otherThreadKey] });
    check("a key issued for another thread is refused", wrongThread.status === 400 && /uploaded by you for this thread/.test(wrongThread.json?.error ?? ""),
      JSON.stringify(wrongThread));
    const gmsKey = (await upload(gm, campKey, { name: "g.png", contentType: "image/png", size: 10 })).json?.key;
    const wrongSender = await send(player, campKey, { body: "x", attachments: [gmsKey] });
    check("a key issued to another sender (same thread) is refused", wrongSender.status === 400, JSON.stringify(wrongSender));
    const madeUp = await send(player, campKey, { body: "x", attachments: [`message-attachments/campaign/${camp}/made-up.png`] });
    check("a key that was never issued is refused", madeUp.status === 400, JSON.stringify(madeUp));
    const notList = await send(player, campKey, { body: "x", attachments: mapKey });
    check("attachments that aren't a list are refused", notList.status === 400, JSON.stringify(notList));
    const eleven = await send(player, campKey, { body: "x", attachments: Array.from({ length: 11 }, (_, i) => `k${i}`) });
    check("more than 10 attachments are refused", eleven.status === 400 && /10 attachments/.test(eleven.json?.error ?? ""),
      JSON.stringify(eleven));
    const { rows: [{ n: refusedStored }] } = await pool.query(
      `SELECT count(*)::int AS n FROM messages WHERE campaign_id = $1 AND body = 'x'`, [camp]);
    check("no refused send was stored", refusedStored === 0, `${refusedStored} stored`);

    const resend = await send(player, campKey, { attachments: [mapKey], clientId: `t104-only-${RUN}` });
    check("a resend with the same clientId returns the stored message (200) with its attachment",
      resend.status === 200 && resend.json?.message?.id === sentMsg?.id && resend.json?.message?.attachments?.length === 1,
      JSON.stringify(resend));

    const dmSend = await send(player, dmKey, { attachments: [dmUpload.json?.key] });
    check("a DM can carry an attachment", dmSend.status === 201 && dmSend.json?.message?.attachments?.[0]?.contentType === "image/gif",
      JSON.stringify(dmSend));

    /* -------------------------------------------------------------- */
    console.log("\nHistory\n");

    fake.clear();
    const gmHistory = await history(gm, campKey);
    const withAtt = (gmHistory.json?.messages ?? []).filter((m: any) => m.attachments?.length);
    check("history returns the attachment metadata with a working URL for members",
      gmHistory.status === 200 && withAtt.length === 2
        && withAtt.every((m: any) => m.attachments.every((a: any) => typeof a.url === "string" && a.expiresAt && a.name)),
      JSON.stringify(withAtt));
    check("each history read mints fresh private URLs",
      fake.calls("uploads.readUrl").length === 3 && fake.calls("uploads.readUrl").every((c) => c.args[0].private === true),
      `${fake.calls("uploads.readUrl").length} reads`);
    const pdfAtt = withAtt.flatMap((m: any) => m.attachments).find((a: any) => a.key === pdfKey);
    const pdfRead = fake.calls("uploads.readUrl").find((c) => c.args[0].key === pdfKey);
    check("a PDF opens inline under its own name",
      pdfAtt?.width === undefined && /^inline; filename="handout\.pdf"/.test(pdfRead?.args[0].contentDisposition ?? ""),
      JSON.stringify(pdfRead?.args[0]));

    fake.clear();
    const strangerHistory = await history(stranger, campKey);
    check("a non-member can't read the history, so gets no URL",
      strangerHistory.status === 403 && !JSON.stringify(strangerHistory.json).includes("fake-uploads"), JSON.stringify(strangerHistory));
    check("no read URL was minted for them", fake.calls("uploads.readUrl").length === 0,
      `${fake.calls("uploads.readUrl").length} reads`);

    fake.fail("uploads.readUrl", new UploadsNotConfiguredError(), { times: Infinity });
    const offHistory = await history(gm, campKey);
    const offAtt = (offHistory.json?.messages ?? []).find((m: any) => m.attachments?.length)?.attachments?.[0];
    check("with uploads switched off, history still loads; the URL is null",
      offHistory.status === 200 && offAtt && offAtt.url === null, JSON.stringify(offAtt));
    fake.reset();

    /* -------------------------------------------------------------- */
    console.log("\nThe real S3 signer (offline: signing needs no network)\n");

    const saved = { ...process.env };
    Object.assign(process.env, {
      UPLOADS_BUCKET: "t104-bucket", UPLOADS_REGION: "us-east-2", UPLOADS_CDN_URL: "https://dcdn.cloudfront.net",
      AWS_ACCESS_KEY_ID: "AKIAT104EXAMPLE", AWS_SECRET_ACCESS_KEY: "t104-secret",
    });
    try {
      const { realIntegrations } = await import("../utils/integrations.js");
      const banner = await realIntegrations.uploads.readUrl({ key: "campaign-banners/x/y.png" });
      const att = await realIntegrations.uploads.readUrl({
        key: mapKey, private: true, expiresInSeconds: 3600, contentDisposition: 'inline; filename="map.png"',
      });
      check("banners still read through CloudFront", banner.url.startsWith("https://dcdn.cloudfront.net/") && banner.expiresAt === null,
        banner.url);
      check("attachments skip CloudFront for a presigned GET that expires",
        att.url.includes("t104-bucket") && att.url.includes("X-Amz-Signature=") && att.url.includes("X-Amz-Expires=3600")
          && att.url.includes("response-content-disposition=") && att.expiresAt instanceof Date, att.url);
    } finally {
      for (const k of ["UPLOADS_BUCKET", "UPLOADS_REGION", "UPLOADS_CDN_URL", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"]) {
        if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
      }
    }
  } finally {
    for (const s of sockets) s.ws.close();
    await live.close();
    await new Promise<void>((r) => server.close(() => r()));
    uninstall();
    await cleanup().catch((err) => console.error("cleanup failed:", err));
    await pool.end();
  }

  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
}

main().catch(async (err) => {
  console.error(err);
  await cleanup().catch(() => {});
  process.exit(1);
});
