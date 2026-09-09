# Testing

Two lanes, because the codebase has two runtimes.

| Lane | Runner | Scope | Command |
|---|---|---|---|
| Client | `react-scripts test` (CRA's Jest + React Testing Library) | `src/**/*.test.js` | `npm test` |
| Server | Jest via `jest.server.config.js` (`node` environment) | `server/**/*.test.js`, `test/**/*.test.js` | `npm run test:server` |

The two never collide: `react-scripts test` only scans `src/`, and the server
config's `testMatch` only covers `server/` and `test/`.

Locally, `npm test` starts CRA's watch mode; add `CI=true` to run once
(`CI=true npm test`). CI runs both lanes non-interactively.

## What's real vs. mocked

Nothing in the suite touches the network or a database.

- **Judge0** (`server/judge0.js`) — `axios` is mocked.
- **Postgres** (`server/db.js`) — `pg` is mocked; `server/db.test.js` also
  covers the "no `DATABASE_URL`" path where every query is a no-op.
- **Sockets** — `server/sockets.test.js` drives the handlers with a hand-rolled
  fake `io` (DB and `roomAccess` mocked); `test/sockets.integration.test.js`
  runs a **real** in-process Socket.IO server and a real `socket.io-client`,
  with only the DB mocked.

## Coverage

**Server (`test:server`) — the part with real logic and past bugs:**

- `judge0.test.js` — no-key → 500, success passthrough, upstream 429 → friendly
  message, other failure → 502
- `db.test.js` — the graceful-degradation contract (no DB → no-ops), and the
  SQL + params for every query when a DB is configured
- `sockets.test.js` — JOIN emits presence before awaiting the DB; first-in gets
  the DB restore + host role; a populated room asks exactly one peer;
  lock → lobby → admit/deny/unlock; host token skips the lobby; host disconnect
  promotes the oldest / ends the room; `flushPendingSaves` writes
  latest-code-per-room and leaves no leaked debounce timer; payload validation
- `roomAccess.test.js` — token issue / scope / revoke / bad input
- `routes.test.js` — `/api/execute` body validation, run + record, error
  passthrough, "history write failure doesn't fail the run", **403 without a
  valid room token**, anonymous runs need none; room read + executions 403/hit
- `execute-rate-limit.test.js` — per-IP limiter returns 429 past the limit
- `sockets.integration.test.js` — a late joiner gets the document from exactly
  one peer (over a real socket); language change propagates; re-JOIN (reconnect)
  produces a fresh `joined`; **lock → knock → admit / deny** round trips

**Client (`npm test`):**

- `api/execution.test.js` — `runCode` request shape + error handling;
  `fetchExecutions` returns `[]` on any failure
- `components/Client.test.js` — renders the username / client entry

## Known gap: page/router component tests

`src/pages/*` (`Home`, `EditorPage`) import `react-router-dom@7`, whose
`exports`-map / ESM layout the Jest bundled with `react-scripts@5` (Jest 27)
cannot resolve — it fails deep inside `react-router`'s dependency chain. This is
a CRA-vs-modern-ecosystem problem, not a code problem; it needs `craco` (to
override CRA's Jest config) or a move to Vite. Until then those components are
exercised manually and by `sockets.integration.test.js` at the protocol level.
The stock `src/App.test.js` (which hit the same wall) was removed.

## Database integration tests (optional, local)

The suite intentionally does not write to a real database. To sanity-check the
real SQL against Postgres, point `DATABASE_URL` at a throwaway Neon branch and
run the app's own flows — `server/db.js` applies `schema.sql` on boot.
