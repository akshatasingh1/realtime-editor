const axios = require('axios');

const JUDGE0_API_URL =
    process.env.JUDGE0_API_URL || 'https://judge0-ce.p.rapidapi.com';
const JUDGE0_API_HOST =
    process.env.JUDGE0_API_HOST || 'judge0-ce.p.rapidapi.com';
const JUDGE0_API_KEY = process.env.JUDGE0_API_KEY;

/**
 * Run source code through Judge0. Returns Judge0's result object on success,
 * or { error, status } on failure so the caller can pick an HTTP status.
 */
async function execute({ language_id, source_code, stdin = '' }) {
    if (!JUDGE0_API_KEY) {
        return {
            error: 'Code execution is not configured on the server.',
            status: 500,
        };
    }

    try {
        const { data } = await axios.post(
            `${JUDGE0_API_URL}/submissions?base64_encoded=false&wait=true`,
            { language_id, source_code, stdin },
            {
                headers: {
                    'Content-Type': 'application/json',
                    'X-RapidAPI-Key': JUDGE0_API_KEY,
                    'X-RapidAPI-Host': JUDGE0_API_HOST,
                },
                timeout: 20000,
            }
        );
        return data;
    } catch (err) {
        const rateLimited = err.response?.status === 429;
        console.error(
            'Judge0 request failed:',
            err.response?.data || err.message
        );
        return {
            error: rateLimited
                ? 'Code execution is rate-limited right now. Wait a moment and try again.'
                : 'Code execution failed.',
            status: rateLimited ? 429 : 502,
        };
    }
}

module.exports = { execute };
