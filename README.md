# realtime-editor

A collaborative code editor: share a room link, edit the same file together in
real time, pick a language, and run the code from the browser. Built for pair
programming, interviews, and teaching.

- **Live editing** — every keystroke syncs to everyone in the room (CodeMirror + Socket.IO)
- **Persistent rooms** — a room keeps its code and language between sessions (Neon Postgres)
- **Code execution** — run C++, Java, JavaScript, or Python via Judge0, with a per-room run history
- **Host controls** — the first person in is the host and can lock the room; after that, new joiners wait in a lobby until admitted
- **Degrades gracefully** — runs without a database (persistence just switches off) and re-joins the room automatically after a network drop

---

## Architecture

```
                 ┌─────────────────────┐
   browser ──────┤  React app (CRA)     │
   (CodeMirror)  │  src/                │
                 └──────────┬──────────-┘
                            │  Socket.IO (websocket)   +   REST (/api/*)
                 ┌──────────┴──────────┐
                 │  Express server     │
                 │  server.js          │
                 │   ├─ server/sockets     live editing, presence, lock/admit
                 │   ├─ server/routes      /api/execute, room reads
                 │   ├─ server/roomAccess  REST access tokens
                 │   ├─ server/judge0      Judge0 proxy (API key stays here)
                 │   └─ server/db          Postgres queries
                 └──────┬───────────┬──┘
                        │           │
              ┌─────────┴──┐   ┌────┴─────────┐
              │  Judge0 CE │   │ Neon Postgres│
              │ (RapidAPI) │   │ rooms,       │
              └────────────┘   │ executions   │
                               └──────────────┘
```

In production the Express server also serves the built React app (`build/`), so
the client and API share an origin.

### Tech

| Layer | Choice |
|---|---|
| Client | React 19, Create React App, CodeMirror 5, react-router 7 |
| Realtime | Socket.IO 4 |
| Server | Node, Express 4 |
| Database | Neon (serverless Postgres), `pg` — no ORM |
| Code execution | Judge0 CE via RapidAPI |

---

## Running locally

### Prerequisites

- Node 18+
- A [Neon](https://neon.tech) Postgres database (optional — see below)
- A [Judge0 CE](https://rapidapi.com/judge0-official/api/judge0-ce) RapidAPI key (optional — needed only for "Run Code")

### Setup

```bash
npm install --legacy-peer-deps      # CRA 5 pins eslint 8; the flag is expected
cp .env.example .env                 # then fill in the values
```

### `.env`

| Variable | Scope | Required | Notes |
|---|---|---|---|
| `REACT_APP_BACKEND_URL` | client (build-time) | dev only | Points the client at the API/socket server, e.g. `http://localhost:5000`. Leave **unset** in production — the client then talks to its own origin, which is the server that served it. |
| `JUDGE0_API_URL` | server | no | defaults to the RapidAPI CE endpoint |
| `JUDGE0_API_HOST` | server | no | defaults to `judge0-ce.p.rapidapi.com` |
| `JUDGE0_API_KEY` | server | for "Run Code" | RapidAPI key; **never** prefixed `REACT_APP_` |
| `DATABASE_URL` | server | no | Neon **pooled** connection string (`...-pooler...?sslmode=require`). Unset = no persistence. |
| `EXECUTE_RATE_PER_MIN` | server | no | Per-IP `/api/execute` limit (default 20). |
| `EXECUTE_RATE_GLOBAL_PER_HOUR` | server | no | Global `/api/execute` limit, protects the Judge0 quota (default 300). |

`.env` is git-ignored. Only `REACT_APP_*` variables reach the browser; everything
else stays on the server.

### Start

```bash
npm run server:dev      # API + socket server on :5000 (nodemon)
npm start               # React dev server on :3000
```

For a production-style run: `npm run build` then `npm run server.prod` (the
server serves the build and the API from `:5000`).

### Tests

```bash
npm run test:server     # server lane (Jest, node env)
CI=true npm test         # client lane (CRA / RTL)
```

Nothing in the suite touches the network or a database. See
[TESTING.md](TESTING.md) for what's covered and what's mocked.

---

## Deploy

One service — the container builds the React client and runs the Express
server, which serves both. Neon and Judge0 stay external. It's a single
stateful process (in-memory presence, lock state, and access tokens), so run
**one instance**.

The [`Dockerfile`](Dockerfile) is a multi-stage build; the app listens on
`$PORT` (default 5000).

### Render (Docker)

- New **Web Service** → Runtime **Docker**
- Instance: 1 (do not enable autoscaling)
- Environment variables: `JUDGE0_API_KEY`, `JUDGE0_API_HOST`, `JUDGE0_API_URL`,
  `DATABASE_URL` (Neon **pooled** string). Leave `REACT_APP_BACKEND_URL` unset.
- Health check path: `/`

### Fly.io

```bash
fly launch --no-deploy          # detects the Dockerfile
fly secrets set JUDGE0_API_KEY=... DATABASE_URL=...
fly deploy
```
Set `min_machines_running = 1` and `max_machines_running = 1` in `fly.toml`.

### Local container check

```bash
docker build -t realtime-editor .
docker run -p 5000:5000 --env-file .env realtime-editor
# open http://localhost:5000
```

### First deploy checklist

- Rotate the Judge0 key and Neon password first — put the fresh values straight
  into the platform's env vars, never back into local `.env`
- After deploy: create a room → open the link in a second browser → live-edit →
  lock the room → knock + admit → run code → refresh (persistence survives)
- Put the live URL at the top of this README

---

## API

All room-scoped endpoints require an `X-Room-Token` header (issued by the socket
layer on join).

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/api/execute` | Run code via Judge0. Body: `{ language_id, source_code, stdin?, roomId? }`. Persists the run when `roomId` is given (token required then). Rate-limited per-IP and globally. |
| `GET` | `/api/rooms/:id` | Room row (`content`, `language_id`, timestamps). Token required. |
| `GET` | `/api/rooms/:id/executions` | Last 20 runs for the room, newest first. Token required. |

### Socket events

`join` → server replies `joined` (presence); a joiner also gets `room-access`
(the REST token + lock state), `code-change`, and `language-change`, and the
first person in also gets `host`. `code-change` / `language-change` from a
client are relayed to the room. `sync-request` asks one existing peer for the
live document, returned via `sync-code`.

**Lock flow:** the host sends `lock-room` / `unlock-room`. Into a locked room, a
joiner gets `waiting` and the host gets `knock` + `pending`; the host replies
with `admit` (→ `admitted`) or `deny` (→ `denied`).

---

## Design notes

**The server is the source of truth for a room's code.** On join, if the room
already has people in it, the server asks *one* of them for the current document
(a peer's copy is fresher than the database — it includes edits still inside the
debounce window). If the room is empty, the server restores the last saved
document from Postgres. Either way the joiner ends up in sync with one message,
not one-per-peer.

**Editing is full-document, last-write-wins.** Every change ships the whole file
and the receiver calls `setValue`. This is fine when one person types at a time
(interviews, teaching, pairing) and is deliberately simple. It is *not* a CRDT —
truly simultaneous editing would jump cursors and could drop in-flight edits.
Moving to Yjs is the natural next step if that becomes a requirement.

**Writes are debounced.** A room is written to Postgres 2s after the last
keystroke, so a burst of typing is one write. On `SIGTERM`/`SIGINT` the server
flushes every pending write before exiting, so a redeploy doesn't lose the last
few seconds of edits.

**No database is a supported mode.** With `DATABASE_URL` unset, all persistence
calls no-op and rooms are purely in-memory + peer-synced. Handy for local dev.

**Room access is capability-based, with an optional lock.** The room ID is an
unguessable UUID — possession of the link is the authorization, like a Meet
link. On top of that, the first person in is the **host** and can **lock** the
room; while locked, new joiners sit in a lobby until the host admits or denies
them. A host token (in `sessionStorage`) keeps the host as host across a
reload/reconnect; if the host leaves with people still in, the oldest is
promoted. Lock state is in-memory and session-scoped — an empty room resets to
unlocked. When you're in a room the server issues a short-lived **access token**;
the REST endpoints (`/api/rooms/:id`, `/executions`, and room-scoped
`/api/execute`) require it, so a leaked link doesn't expose a locked room's code
or history over HTTP.

**Single instance only.** Presence (`userSocketMap`), lock state, and access
tokens all live in server memory, so running more than one server process would
split the room state. Horizontal scaling would need the Socket.IO Redis adapter
and a shared token store.

---

## Project structure

```
server.js              bootstrap: express, socket.io, graceful shutdown
server/
  db.js / db.test.js         pg pool + room/execution queries (no-ops without DATABASE_URL)
  schema.sql                 applied on boot
  judge0.js / judge0.test.js Judge0 request wrapper
  roomAccess.js / .test.js   in-memory REST access tokens
  routes.js                  REST endpoints (+ requireRoomAccess middleware)
  sockets.js / sockets.test.js  realtime handlers, lock/admit flow, debounced persistence
test/
  routes.test.js             REST endpoints (supertest, db + judge0 mocked)
  execute-rate-limit.test.js  per-IP limiter
  sockets.integration.test.js real socket.io server + client
src/
  Actions.js           shared socket event names
  socket.js            client socket factory
  api/execution.js     runCode + fetchExecutions
  components/Editor.js  CodeMirror + sync wiring
  pages/
    Home.js            create / join a room
    EditorPage.js      the room: presence, editor, run, history
```

---

## Known limitations / TODO

- CRA is unmaintained; migrating to Vite would remove the audit noise, speed up builds, and unblock router-component tests (see [TESTING.md](TESTING.md))
- Full-document sync (see design notes) rather than CRDT
- No accounts — access is by unguessable link + an optional host lock (see design notes); there's no persistent identity or invite list
- Judge0 CE free tier is rate-limited; heavy use will see 429s
