# Live channel protocol, v1

One WebSocket per signed-in person. It carries live events for every thread that person can see. The web app uses it now. The VTT, Electron and React Native clients will use it later, so keep it small, and change the version when it changes in a way old clients can't ignore.

- Server: `backend/live/liveChannel.ts`
- Web client: `frontend/src/lib/realtime/liveClient.ts`, wrapped by the `useLiveThread` hook (threads), `useTyping` (typing) and `useThreads` (the thread list)
- Tests: `backend/scripts/test-live-channel.ts` (campaigns, auth, heartbeat, client), `backend/scripts/test-live-dms.ts` (DMs), `backend/scripts/test-live-typing.ts` (typing), `backend/scripts/test-live-list.ts` (`thread.updated`, `thread.read`), `backend/scripts/test-live-two-tasks.ts` (every frame across two backend processes), `backend/scripts/test-live-redis-recovery.ts` (Redis outages), `backend/scripts/test-live-access.ts` (access changes, token expiry)

## Connecting

```
GET /api/live    (WebSocket upgrade)
```

The endpoint sits on the backend's HTTP server, under `/api`, so browsers reach it same-origin through the frontend's `/api` rewrite: `wss://<frontend host>/api/live`.

Every frame is one JSON object with a `type` string, sent as a text message. A frame larger than 16 KB from the client closes the socket (1009).

## Auth

The client's first frame carries its JWT:

```json
{ "type": "auth", "v": 1, "token": "<jwt>" }
```

- `v` is the protocol version the client speaks. A version the server doesn't speak closes the socket with **4002**.
- A token in the query string (`/api/live?token=<jwt>`) also works, but use the first frame where possible: URLs end up in logs.
- A missing, malformed, expired or wrong-secret token, or one whose subject isn't an account, closes the socket with **4001**. So does a first frame that isn't an auth frame, and a connection that sends nothing for 10 seconds.
- A socket doesn't outlive its token: when the token's `exp` passes, the server closes the socket with **4001** (#105). Reconnect with a fresh token.
- The 10 seconds cover the whole handshake. If the server is still checking a token when they run out (a slow database), it closes with **1011** instead, and the client should retry.

When auth succeeds, the server answers:

```json
{ "type": "ready", "v": 1, "threads": ["campaign:<id>", "dm:<a>:<b>"] }
```

`threads` lists the thread keys this socket will receive events for: every campaign the person belongs to, whatever its status, plus one DM thread per friend. Admins get no extra campaigns. A thread missing from `threads` gets no live events on this socket, so clients should show it as not live (the web client's `threadStatus` reports `unavailable`).

### Access changes on an open socket (#105)

The set isn't fixed at connect. When the person joins or leaves a campaign (accepting an invite, joining by link, being added or removed by the GM, leaving), a campaign of theirs is deleted, or they become or stop being friends with someone, the server sends **another `ready`** on the same socket, with the whole new `threads` list. Nothing else changes: same connection, no reconnect, `v` as before.

- Losing access takes effect as soon as the server hears of the change: nothing published after it (a message, typing, `thread.updated`) reaches that socket for that thread, even before the new `ready` arrives. After unfriending, sending a DM to the former friend is refused with 403.
- Gaining access takes effect when the new `ready` arrives. Events from before it aren't replayed, so refetch a thread that just became available, and the thread list. (The web client calls `onReconnect` for exactly those: the newly available threads and the person-level subscribers. `LiveClient.onThreads` reports every new set.)
- Clients tell the two kinds of `ready` apart by whether one already arrived on this connection.

Thread keys are `campaign:<campaign id>` and `dm:<id>:<id>`, with the two account ids sorted.

## Server → client frames

| type | fields | meaning |
|---|---|---|
| `ready` | `v`, `threads` | Auth succeeded. Events start flowing. Sent again on the same socket when the person's threads change (see Access changes). |
| `message.created` | `thread`, `message` | A message was posted to a thread you can see. |
| `typing` | `thread`, `personId`, `name`, `expiresInMs` | Someone else is writing in a thread you can see (see Typing). |
| `thread.updated` | `thread`, `lastActivityAt`, `unreadCount` | A thread's last activity and your unread count in it changed (a new message). |
| `thread.read` | `thread`, `lastReadAt`, `lastReadMessageId`, `unreadCount` | You read a thread, on this or another device. |
| `ping` | none | Heartbeat. Answer with `pong`. |

`message` is:

```json
{ "id": "<uuid>", "sender": { "id": "<account id or \"system\">", "name": "..." },
  "body": "markdown", "createdAt": "<ISO>", "eventId": "<uuid, optional>" }
```

Campaign threads and DM threads carry the same frame. A DM reaches only its pair: every socket of each of the two people, the sender's own included, so a message sent from a phone also shows on the sender's laptop. `eventId` only appears on campaign messages. Automated posts, such as the ready check, arrive the same way, with `sender.id` set to `"system"`. Sender email addresses are never sent.

This channel is the only live path: the old per-thread SSE streams (`/api/messages/campaign/:id/stream`, `/api/messages/dm/:userId/stream`) were removed with #99.

### The thread list: `thread.updated` and `thread.read` (#102)

These keep a thread list (unread markers, newest-first order) current without polling. Neither carries message text.

```json
{ "type": "thread.updated", "thread": "campaign:<id>", "lastActivityAt": "<ISO>", "unreadCount": 3 }
{ "type": "thread.read", "thread": "campaign:<id>", "lastReadAt": "<ISO>", "lastReadMessageId": "<uuid>", "unreadCount": 0 }
```

- **`thread.updated`** follows every `message.created`, to every socket subscribed to the thread, the sender's own included. `lastActivityAt` is the new message's `createdAt`. `unreadCount` is worked out per person: the messages after that person's read position that someone else sent, so the sender's count doesn't go up. It can arrive for a thread a list doesn't show (a first DM, a completed campaign the socket is still subscribed to); clients refetch the list or ignore it.
- **`thread.read`** goes to every socket of the person who read, and to nobody else, when a mark-read (`POST /api/threads/:threadKey/read`) moves their read position forward. A mark-read that doesn't move it (a device that is behind) sends nothing. `lastReadAt` is the read message's `createdAt`; `unreadCount` is what's left unread after the position. Your read position is never sent to other people.
- If a `thread.read` and a `thread.updated` for the same thread cross, a client can trust the read when `lastReadAt` is at or after the update's `lastActivityAt` (the web client does: the count stays 0).
- Both are live-only, like everything here. After a reconnect, refetch the list (`GET /api/threads`).

Clients must ignore frame types they don't know. Later versions of the server will add frames (spec #58) without changing `v`.

## Client → server frames

| type | fields | meaning |
|---|---|---|
| `auth` | `v`, `token` | The first frame only. |
| `pong` | none | Answer to `ping`. |
| `typing` | `thread` | You are writing in this thread (see Typing). |

The server ignores types it doesn't know. When a frame names a thread, the server drops it if the person can't access that thread.

## Typing

Added with #103. While someone types in a thread, their client sends

```json
{ "type": "typing", "thread": "campaign:<id>" }
```

at most once every **3 seconds**, and only while the draft has text. Sending a message resets that, so the first keystroke of the next message announces at once. The server:

- drops the frame silently (the socket stays open) if the thread key is missing or malformed, if it isn't one of the threads this socket's `ready` listed, or if the person can no longer access the thread (the same `canAccessThread` check the REST endpoints use). So an admin reading a campaign they aren't a member of can't type in it;
- drops frames for one thread on one socket that arrive less than 250 ms after the last one it accepted, before any access check (flood control; a well-behaved client never comes that close);
- otherwise publishes it on the event bus's ephemeral path (`letters.typing`, Pub/Sub only), so it reaches the thread on every backend task. It is never written to the database or to a Redis stream.

Every socket subscribed to the thread then gets

```json
{ "type": "typing", "thread": "campaign:<id>", "personId": "<account id>", "name": "Theo", "expiresInMs": 5000 }
```

except the typist's own sockets, on any device: nobody sees themselves typing. A DM's `typing` reaches only the other one of the pair. `name` is the person's display name, never an email address.

Clients show "Theo is writing…" and take it down `expiresInMs` (5 seconds) after that person's last `typing` frame, or as soon as a `message.created` from that person arrives on the thread. Nothing is replayed: a socket that connects mid-burst sees the indicator at the typist's next frame. The web client's logic is in `frontend/src/lib/realtime/typing.ts` (`TypingTracker`), wrapped by the `useTyping` hook.

## Heartbeat

The server sends `ping` every 25 seconds. A socket that has sent nothing since the previous ping is terminated without a close frame, so the client sees 1006. Any frame counts as an answer, but clients should send `pong`.

Clients should also give up on a socket that has received nothing for about 60 seconds, since browsers can take minutes to notice a dead connection. The ALB idle timeout must stay above the ping interval (#106 sets it above 60 seconds).

## More than one backend task

Every frame works across backend tasks: each task subscribes to the event bus's broadcast path (Redis Pub/Sub), so a message, read or typing frame from a socket on one task reaches sockets on every task. In memory (no `REDIS_URL`) there is only ever one process.

The channel takes upgrades only once those subscriptions are in place. If Redis is unreachable when a task boots, the task keeps retrying (backoff up to 30 s) and `/api/live` refuses upgrades until it succeeds; clients just keep reconnecting. If Redis drops later, the subscriptions come back by themselves when it does. Events published while they were down are not delivered (there is no replay), and open sockets are not told.

Each task logs `[live] socket open: person <id>, <n> threads, task <host>/<pid>` when a socket is ready, and `[live] socket closed: person <id>, code <code>, after <s>s, task <host>/<pid>` when it closes.

## Close codes

| code | meaning | client should |
|---|---|---|
| 1000 | Client closed normally. | Nothing. |
| 1001 | Server shutting down (deploy). | Reconnect. |
| 1006 | Connection lost, or dropped for missing pings. | Reconnect. |
| 1011 | Server error while setting up the socket. | Reconnect. |
| 4001 | Unauthorized: bad, expired or missing token, or the token expired while the socket was open. | Stop. Get a fresh token (sign in again) before retrying. |
| 4002 | Unsupported protocol version. | Stop. The client is too old or too new. |

## Reconnecting

Reconnect with exponential backoff and full jitter. The web client waits a random time between 0 and `min(30 s, 0.5 s × 2^attempt)`, and resets the attempt count on `ready`.

**The server doesn't replay missed events.** After a reconnect, refetch what's on screen: the open thread's latest page and the thread list. The web client calls every subscriber's `onReconnect` (thread subscribers and person-level ones, `LiveClient.subscribePerson`) when the first `ready` on a later connection arrives.

## Versioning

`v` changes only for changes old clients can't ignore: renamed or removed frames or fields, or changed meanings. Adding a frame type or an optional field doesn't change it.
