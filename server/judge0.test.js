// judge0.execute() reads JUDGE0_API_KEY at module load, so each test resets the
// module registry and requires it fresh with the env it wants.
jest.mock('axios', () => ({ post: jest.fn() }));

describe('judge0.execute', () => {
    const OLD_ENV = process.env;

    beforeEach(() => {
        jest.resetModules();
        process.env = { ...OLD_ENV };
        jest.spyOn(console, 'error').mockImplementation(() => {});
    });

    afterAll(() => {
        process.env = OLD_ENV;
    });

    function load() {
        const axios = require('axios');
        const { execute } = require('./judge0');
        return { axios, execute };
    }

    test('returns a 500 error when no API key is configured', async () => {
        delete process.env.JUDGE0_API_KEY;
        const { execute, axios } = load();

        const result = await execute({ language_id: 63, source_code: 'x' });

        expect(result).toEqual({
            error: expect.stringContaining('not configured'),
            status: 500,
        });
        expect(axios.post).not.toHaveBeenCalled();
    });

    test('passes the Judge0 response body through on success', async () => {
        process.env.JUDGE0_API_KEY = 'test-key';
        const { execute, axios } = load();
        axios.post.mockResolvedValue({
            data: { stdout: '42\n', status: { id: 3, description: 'Accepted' } },
        });

        const result = await execute({
            language_id: 63,
            source_code: 'console.log(42)',
            stdin: '',
        });

        expect(result.stdout).toBe('42\n');
        expect(axios.post).toHaveBeenCalledWith(
            expect.stringContaining('/submissions?base64_encoded=false&wait=true'),
            { language_id: 63, source_code: 'console.log(42)', stdin: '' },
            expect.objectContaining({
                headers: expect.objectContaining({ 'X-RapidAPI-Key': 'test-key' }),
            })
        );
    });

    test('maps an upstream 429 to a friendly rate-limit message', async () => {
        process.env.JUDGE0_API_KEY = 'test-key';
        const { execute, axios } = load();
        axios.post.mockRejectedValue({ response: { status: 429, data: {} } });

        const result = await execute({ language_id: 63, source_code: 'x' });

        expect(result.status).toBe(429);
        expect(result.error).toMatch(/rate-limited/i);
    });

    test('maps any other upstream failure to 502', async () => {
        process.env.JUDGE0_API_KEY = 'test-key';
        const { execute, axios } = load();
        axios.post.mockRejectedValue(new Error('socket hang up'));

        const result = await execute({ language_id: 63, source_code: 'x' });

        expect(result).toEqual({ error: 'Code execution failed.', status: 502 });
    });
});
