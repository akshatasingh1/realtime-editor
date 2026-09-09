const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

// Neon (and most hosted Postgres) require SSL. The pooled connection string
// already carries ?sslmode=require; this keeps `pg` from rejecting the cert.
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : undefined,
    max: 10,
    // Fail fast instead of hanging a request when the DB is unreachable/slow.
    connectionTimeoutMillis: 8000,
    statement_timeout: 8000,
});

pool.on('error', (err) => console.error('Unexpected Postgres pool error:', err.message));

let enabled = false;

/**
 * The app runs fine without a database - persistence is just switched off.
 * Every query helper below no-ops when DATABASE_URL is not configured.
 */
function isEnabled() {
    return enabled;
}

async function init() {
    if (!process.env.DATABASE_URL) {
        console.warn('DATABASE_URL not set - running without persistence.');
        return;
    }
    const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
    await pool.query(schema);
    enabled = true;
    console.log('Database ready.');
}

// --- rooms -----------------------------------------------------------------

async function getRoom(id) {
    if (!enabled) return null;
    const { rows } = await pool.query('SELECT * FROM rooms WHERE id = $1', [id]);
    return rows[0] || null;
}

/** Create the room on first join, or just bump its activity timestamp. */
async function ensureRoom(id, languageId = 63) {
    if (!enabled) return null;
    const { rows } = await pool.query(
        `INSERT INTO rooms (id, language_id)
         VALUES ($1, $2)
         ON CONFLICT (id) DO UPDATE SET last_active_at = now()
         RETURNING *`,
        [id, languageId]
    );
    return rows[0];
}

async function saveRoomContent(id, content, languageId = null) {
    if (!enabled) return;
    await pool.query(
        `UPDATE rooms
            SET content = $2,
                language_id = COALESCE($3, language_id),
                last_active_at = now()
          WHERE id = $1`,
        [id, content, languageId]
    );
}

async function setRoomLanguage(id, languageId) {
    if (!enabled) return;
    await pool.query(
        `UPDATE rooms
            SET language_id = $2, last_active_at = now()
          WHERE id = $1`,
        [id, languageId]
    );
}

// --- executions ----------------------------------------------------------

async function recordExecution(roomId, languageId, result) {
    if (!enabled) return;
    await pool.query(
        `INSERT INTO executions
             (room_id, language_id, stdout, stderr, compile_output, status)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
            roomId,
            languageId,
            result.stdout ?? null,
            result.stderr ?? null,
            result.compile_output ?? null,
            result.status?.description ?? null,
        ]
    );
}

async function listExecutions(roomId, limit = 20) {
    if (!enabled) return [];
    const { rows } = await pool.query(
        `SELECT id, language_id, stdout, stderr, compile_output, status, created_at
           FROM executions
          WHERE room_id = $1
          ORDER BY created_at DESC
          LIMIT $2`,
        [roomId, limit]
    );
    return rows;
}

module.exports = {
    pool,
    init,
    isEnabled,
    getRoom,
    ensureRoom,
    saveRoomContent,
    setRoomLanguage,
    recordExecution,
    listExecutions,
};
