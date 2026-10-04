# Live channel protocol, v1

One WebSocket per signed-in person. It carries live events for every thread that person can see. The web app uses it now. The VTT, Electron and React Native clients will use it later, so keep it small, and change the version when it changes in a way old clients can't ignore.

- Server: `backend/live/liveChannel.ts`
- Web client: `frontend/src/lib/realtime/liveClient.ts`, wrapped by the `useLiveThread` hook
- Tests: `backend/scripts/test-live-channel.ts`

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

When auth succeeds, the server answers:

```json
{ "type": "ready", "v": 1, "threads": ["campaign:<id>", "dm:<a>:<b>"] }
```

`threads` lists the thread keys this socket will receive events for: every campaign the person belongs to, whatever its status, plus one DM thread per friend. The server works this out once, when the socket connects.

Thread keys are `campaign:<campaign id>` and `dm:<id>:<id>`, with the two account ids sorted.

## Server → client frames

| type | fields | meaning |
|---|---|---|
| `ready` | `v`, `threads` | Auth succeeded. Events start flowing. |
| `message.created` | `thread`, `message` | A message was posted to a thread you can see. |
| `ping` | none | Heartbeat. Answer with `pong`. |

`message` is:

```json
{ "id": "<uuid>", "sender": { "id": "<account id or \"system\">", "name": "..." },
  "body": "markdown", "createdAt": "<ISO>", "eventId": "<uuid, optional>" }
```

Automated posts, such as the ready check, arrive the same way, with `sender.id` set to `"system"`. Sender email addresses are never sent.

Clients must ignore frame types they don't know. Later versions of the server will add frames such as `typing`, `thread.read` and `thread.updated` (spec #58) without changing `v`.

## Client → server frames

| type | fields | meaning |
|---|---|---|
| `auth` | `v`, `token` | The first frame only. |
| `pong` | none | Answer to `ping`. |

The server ignores types it doesn't know. When later frames name a thread (for example `typing`), the server drops any frame for a thread the person can't access.

## Heartbeat

The server sends `ping` every 25 seconds. A socket that has sent nothing since the previous ping is terminated without a close frame, so the client sees 1006. Any frame counts as an answer, but clients should send `pong`.

Clients should also give up on a socket that has received nothing for about 60 seconds, since browsers can take minutes to notice a dead connection. The ALB idle timeout must stay above the ping interval (#106 sets it above 60 seconds).

## Close codes

| code | meaning | client should |
|---|---|---|
| 1000 | Client closed normally. | Nothing. |
| 1001 | Server shutting down (deploy). | Reconnect. |
| 1006 | Connection lost, or dropped for missing pings. | Reconnect. |
| 1011 | Server error while setting up the socket. | Reconnect. |
| 4001 | Unauthorized: bad, expired or missing token. | Stop. Get a fresh token (sign in again) before retrying. |
| 4002 | Unsupported protocol version. | Stop. The client is too old or too new. |

## Reconnecting

Reconnect with exponential backoff and full jitter. The web client waits a random time between 0 and `min(30 s, 0.5 s × 2^attempt)`, and resets the attempt count on `ready`.

**The server doesn't replay missed events.** After a reconnect, refetch what's on screen: the open thread's latest page (and, from #102, the thread list). The web client calls every subscriber's `onReconnect` when a later `ready` arrives.

## Versioning

`v` changes only for changes old clients can't ignore: renamed or removed frames or fields, or changed meanings. Adding a frame type or an optional field doesn't change it.
