import axios from 'axios';
import { runCode, fetchExecutions } from './execution';

jest.mock('axios');

beforeEach(() => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => jest.clearAllMocks());

describe('runCode', () => {
    it('posts the run to /api/execute and returns the Judge0 result', async () => {
        axios.post.mockResolvedValue({ data: { stdout: '42\n' } });

        const result = await runCode(63, 'console.log(42)', 'room-1', '5');

        expect(result).toEqual({ stdout: '42\n' });
        expect(axios.post).toHaveBeenCalledWith(
            expect.stringContaining('/api/execute'),
            {
                language_id: 63,
                source_code: 'console.log(42)',
                roomId: 'room-1',
                stdin: '5',
            }
        );
    });

    it('surfaces the server error message on failure', async () => {
        axios.post.mockRejectedValue({
            response: { data: { error: 'Too many runs from this address.' } },
        });

        const result = await runCode(63, 'x', 'r');

        expect(result).toEqual({ error: 'Too many runs from this address.' });
    });

    it('falls back to a generic message when there is no response body', async () => {
        axios.post.mockRejectedValue(new Error('network down'));

        expect(await runCode(63, 'x', 'r')).toEqual({
            error: 'Code execution failed.',
        });
    });
});

describe('fetchExecutions', () => {
    it('returns the array from the API', async () => {
        axios.get.mockResolvedValue({ data: [{ id: '1', status: 'Accepted' }] });

        expect(await fetchExecutions('r1')).toEqual([
            { id: '1', status: 'Accepted' },
        ]);
    });

    it('returns [] on request failure', async () => {
        axios.get.mockRejectedValue(new Error('boom'));

        expect(await fetchExecutions('r1')).toEqual([]);
    });

    it('returns [] when the API responds with a non-array', async () => {
        axios.get.mockResolvedValue({ data: { error: 'nope' } });

        expect(await fetchExecutions('r1')).toEqual([]);
    });
});
