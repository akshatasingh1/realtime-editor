import axios from 'axios';

const API_BASE = process.env.REACT_APP_BACKEND_URL || '';

/**
 * Run source code via the server's /api/execute proxy (which talks to Judge0
 * and records the run against the room). Returns the Judge0 result object,
 * or { error } on failure.
 */
export async function runCode(languageId, sourceCode, roomId, stdin = '') {
    try {
        const { data } = await axios.post(`${API_BASE}/api/execute`, {
            language_id: languageId,
            source_code: sourceCode,
            roomId,
            stdin,
        });
        return data;
    } catch (err) {
        console.error('Code execution failed:', err);
        return {
            error: err.response?.data?.error || 'Code execution failed.',
        };
    }
}

/** Recent runs for a room, newest first. Returns [] if unavailable. */
export async function fetchExecutions(roomId) {
    try {
        const { data } = await axios.get(
            `${API_BASE}/api/rooms/${roomId}/executions`
        );
        return Array.isArray(data) ? data : [];
    } catch (err) {
        console.error('Failed to load run history:', err);
        return [];
    }
}
