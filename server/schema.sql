-- Applied on server boot (see server/db.js). Safe to run repeatedly.

CREATE TABLE IF NOT EXISTS rooms (
    id             TEXT PRIMARY KEY,
    language_id    INTEGER     NOT NULL DEFAULT 63,
    content        TEXT        NOT NULL DEFAULT '',
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_active_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS executions (
    id             BIGSERIAL PRIMARY KEY,
    room_id        TEXT        NOT NULL REFERENCES rooms (id) ON DELETE CASCADE,
    language_id    INTEGER     NOT NULL,
    stdout         TEXT,
    stderr         TEXT,
    compile_output TEXT,
    status         TEXT,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS executions_room_created_idx
    ON executions (room_id, created_at DESC);
