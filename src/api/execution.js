import axios from 'axios';

const API_BASE = process.env.REACT_APP_BACKEND_URL || '';

const roomHeaders = (token) => (token ? { 'X-Room-Token': token } : {});

/**
 * Run source code via the server's /api/execute proxy (which talks to Judge0
 * and records the run against the room). Returns the Judge0 result object,
 * or { error } on failure.
 */
export async function runCode(languageId, sourceCode, roomId, stdin = '', token) {
    try {
        const { data } = await axios.post(
            `${API_BASE}/api/execute`,
            {
                language_id: languageId,
                source_code: sourceCode,
                roomId,
                stdin,
            },
            { headers: roomHeaders(token) }
        );
        return data;
    } catch (err) {
        console.error('Code execution failed:', err);
        return {
            error: err.response?.data?.error || 'Code execution failed.',
        };
    }
}

/** Recent runs for a room, newest first. Returns [] if unavailable. */
export async function fetchExecutions(roomId, token) {
    try {
        const { data } = await axios.get(
            `${API_BASE}/api/rooms/${roomId}/executions`,
            { headers: roomHeaders(token) }
        );
        return Array.isArray(data) ? data : [];
    } catch (err) {
        console.error('Failed to load run history:', err);
        return [];
    }
}
