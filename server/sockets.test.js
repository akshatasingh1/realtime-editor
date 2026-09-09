// Unit tests for the socket handlers. The DB and roomAccess are mocked and
// `io` / sockets are hand-rolled fakes, so this runs with no server, no
// network, no database.
jest.mock('./db', () => ({
    isEnabled: jest.fn(() => false),
    init: jest.fn().mockResolvedValue(undefined),
    getRoom: jest.fn().mockResolvedValue(null),
    ensureRoom: jest.fn().mockResolvedValue(null),
    saveRoomContent: jest.fn().mockResolvedValue(undefined),
    setRoomLanguage: jest.fn().mockResolvedValue(undefined),
    recordExecution: jest.fn().mockResolvedValue(undefined),
    listExecutions: jest.fn().mockResolvedValue([]),
}));
jest.mock('./roomAccess', () => {
    let n = 0;
    return {
        issue: jest.fn(() => `token-${(n += 1)}`),
        revoke: jest.fn(),
        isValid: jest.fn(() => true),
    };
});

const db = require('./db');
const ACTIONS = require('../src/Actions');
const { registerSocketHandlers } = require('./sockets');

const flushMicrotasks = () => new Promise((resolve) => setImmediate(resolve));

function harness() {
    const connectionHandlers = [];
    const emits = []; // { to, event, payload }
    const roomsMap = new Map();
    const socketsMap = new Map();

    const io = {
        on: (event, fn) => {
            if (event === 'connection') connectionHandlers.push(fn);
        },
        to: (target) => ({
            emit: (event, payload) => emits.push({ to: target, event, payload }),
        }),
        in: (target) => ({
            emit: (event, payload) =>
                emits.push({ to: `room:${target}`, event, payload }),
        }),
        sockets: {
            adapter: { rooms: roomsMap },
            sockets: socketsMap,
        },
    };

    const api = registerSocketHandlers(io);

    function connect(id) {
        const handlers = {};
        const socket = {
            id,
            rooms: new Set(),
            on: (event, fn) => {
                handlers[event] = fn;
            },
            join: (roomId) => {
                socket.rooms.add(roomId);
                if (!roomsMap.has(roomId)) roomsMap.set(roomId, new Set());
                roomsMap.get(roomId).add(id);
            },
            in: (roomId) => ({
                emit: (event, payload) =>
                    emits.push({ to: `in:${roomId}`, event, payload }),
            }),
        };
        socketsMap.set(id, socket);
        connectionHandlers.forEach((fn) => fn(socket));
        return { socket, handlers };
    }

    function disconnect(entry) {
        entry.handlers.disconnecting?.();
        for (const r of entry.socket.rooms) roomsMap.get(r)?.delete(entry.socket.id);
        socketsMap.delete(entry.socket.id);
    }

    const eventsTo = (target, event) =>
        emits.filter((e) => e.to === target && e.event === event);

    return { emits, connect, disconnect, eventsTo, ...api };
}

beforeEach(() => {
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
    db.ensureRoom.mockResolvedValue(null);
    db.saveRoomContent.mockResolvedValue(undefined);
    db.setRoomLanguage.mockResolvedValue(undefined);
});

async function joinRoom(h, id, roomId, username, hostToken) {
    const entry = h.connect(id);
    await entry.handlers[ACTIONS.JOIN]({ roomId, username, hostToken });
    await flushMicrotasks();
    return entry;
}

describe('JOIN (unlocked room)', () => {
    test('broadcasts presence before it awaits the database', async () => {
        db.ensureRoom.mockResolvedValue({ content: 'x', language_id: 71 });
        const h = harness();
        const alice = h.connect('a');

        alice.handlers[ACTIONS.JOIN]({ roomId: 'R', username: 'alice' }); // not awaited

        expect(h.emits.filter((e) => e.event === ACTIONS.JOINED)).toHaveLength(1);
        expect(h.emits.some((e) => e.event === ACTIONS.LANGUAGE_CHANGE)).toBe(false);

        await flushMicrotasks();
        expect(h.emits.some((e) => e.event === ACTIONS.LANGUAGE_CHANGE)).toBe(true);
    });

    test('first client becomes host and gets a token + access grant', async () => {
        const h = harness();
        await joinRoom(h, 'a', 'R', 'alice');

        expect(h.eventsTo('a', ACTIONS.HOST)).toHaveLength(1);
        const access = h.eventsTo('a', ACTIONS.ROOM_ACCESS)[0];
        expect(access.payload).toMatchObject({ isHost: true, locked: false });
        expect(access.payload.token).toBeTruthy();
    });

    test('first client in an empty room gets the persisted document', async () => {
        db.ensureRoom.mockResolvedValue({ content: 'saved code', language_id: 63 });
        const h = harness();
        await joinRoom(h, 'a', 'R', 'alice');

        expect(h.emits.some((e) => e.event === ACTIONS.SYNC_REQUEST)).toBe(false);
        const codeChange = h.emits.find((e) => e.event === ACTIONS.CODE_CHANGE);
        expect(codeChange.payload).toEqual({ code: 'saved code' });
    });

    test('a later joiner is asked to sync from exactly one peer', async () => {
        db.ensureRoom.mockResolvedValue({ content: 'db copy', language_id: 63 });
        const h = harness();
        await joinRoom(h, 'a', 'R', 'alice');
        await joinRoom(h, 'c', 'R', 'carol');
        h.emits.length = 0;

        await joinRoom(h, 'b', 'R', 'bob');

        const syncRequests = h.emits.filter((e) => e.event === ACTIONS.SYNC_REQUEST);
        expect(syncRequests).toHaveLength(1);
        expect(syncRequests[0].to).toBe('a');
        expect(syncRequests[0].payload).toEqual({ socketId: 'b' });
    });

    test('the second joiner does not become host', async () => {
        const h = harness();
        await joinRoom(h, 'a', 'R', 'alice');
        h.emits.length = 0;
        await joinRoom(h, 'b', 'R', 'bob');

        expect(h.eventsTo('b', ACTIONS.HOST)).toHaveLength(0);
        expect(h.eventsTo('b', ACTIONS.ROOM_ACCESS)[0].payload.isHost).toBe(false);
    });
});

describe('lock / lobby / admit', () => {
    test('a locked room sends new joiners to the lobby and knocks the host', async () => {
        const h = harness();
        const alice = await joinRoom(h, 'a', 'R', 'alice');
        alice.handlers[ACTIONS.LOCK_ROOM]({ roomId: 'R' });
        h.emits.length = 0;

        await joinRoom(h, 'b', 'R', 'bob');

        expect(h.eventsTo('b', ACTIONS.WAITING)).toHaveLength(1);
        expect(h.eventsTo('b', ACTIONS.JOINED)).toHaveLength(0); // not in the room
        const knock = h.eventsTo('a', ACTIONS.KNOCK)[0];
        expect(knock.payload).toEqual({ socketId: 'b', username: 'bob' });
        const pending = h.eventsTo('a', ACTIONS.PENDING).slice(-1)[0];
        expect(pending.payload.pending).toEqual([
            { socketId: 'b', username: 'bob' },
        ]);
    });

    test('the host admits a waiter, who then enters the room', async () => {
        const h = harness();
        const alice = await joinRoom(h, 'a', 'R', 'alice');
        alice.handlers[ACTIONS.LOCK_ROOM]({ roomId: 'R' });
        await joinRoom(h, 'b', 'R', 'bob');
        h.emits.length = 0;

        alice.handlers[ACTIONS.ADMIT]({ roomId: 'R', socketId: 'b' });
        await flushMicrotasks();

        expect(h.eventsTo('b', ACTIONS.ADMITTED)).toHaveLength(1);
        expect(h.emits.some((e) => e.event === ACTIONS.JOINED)).toBe(true);
        expect(h.eventsTo('b', ACTIONS.ROOM_ACCESS)[0].payload.isHost).toBe(false);
    });

    test('the host denies a waiter', async () => {
        const h = harness();
        const alice = await joinRoom(h, 'a', 'R', 'alice');
        alice.handlers[ACTIONS.LOCK_ROOM]({ roomId: 'R' });
        await joinRoom(h, 'b', 'R', 'bob');
        h.emits.length = 0;

        alice.handlers[ACTIONS.DENY]({ roomId: 'R', socketId: 'b' });

        expect(h.eventsTo('b', ACTIONS.DENIED)[0].payload).toEqual({
            reason: 'denied',
        });
    });

    test('unlocking admits everyone waiting', async () => {
        const h = harness();
        const alice = await joinRoom(h, 'a', 'R', 'alice');
        alice.handlers[ACTIONS.LOCK_ROOM]({ roomId: 'R' });
        await joinRoom(h, 'b', 'R', 'bob');
        await joinRoom(h, 'c', 'R', 'carol');
        h.emits.length = 0;

        alice.handlers[ACTIONS.UNLOCK_ROOM]({ roomId: 'R' });
        await flushMicrotasks();

        expect(h.eventsTo('b', ACTIONS.ADMITTED)).toHaveLength(1);
        expect(h.eventsTo('c', ACTIONS.ADMITTED)).toHaveLength(1);
        expect(
            h.emits.some(
                (e) =>
                    e.event === ACTIONS.ROOM_LOCK_STATE &&
                    e.payload.locked === false
            )
        ).toBe(true);
    });

    test('a non-host cannot lock or admit', async () => {
        const h = harness();
        const alice = await joinRoom(h, 'a', 'R', 'alice');
        alice.handlers[ACTIONS.LOCK_ROOM]({ roomId: 'R' });
        const bob = await joinRoom(h, 'b', 'R', 'bob'); // in the lobby
        // bob got admitted? no - locked. Force bob to be a real member first:
        alice.handlers[ACTIONS.ADMIT]({ roomId: 'R', socketId: 'b' });
        await flushMicrotasks();
        h.emits.length = 0;

        bob.handlers[ACTIONS.LOCK_ROOM]({ roomId: 'R' });
        bob.handlers[ACTIONS.ADMIT]({ roomId: 'R', socketId: 'x' });

        expect(h.emits).toHaveLength(0);
    });

    test('the returning host (valid hostToken) skips the lobby', async () => {
        const h = harness();
        const alice = await joinRoom(h, 'a', 'R', 'alice');
        const hostToken = h.eventsTo('a', ACTIONS.HOST)[0].payload.hostToken;
        alice.handlers[ACTIONS.LOCK_ROOM]({ roomId: 'R' });
        h.emits.length = 0;

        // alice reconnects on a new socket id, presenting the host token
        await joinRoom(h, 'a2', 'R', 'alice', hostToken);

        expect(h.eventsTo('a2', ACTIONS.WAITING)).toHaveLength(0);
        expect(h.eventsTo('a2', ACTIONS.ROOM_ACCESS)[0].payload.isHost).toBe(true);
    });
});

describe('host disconnect', () => {
    test('promotes the oldest remaining member', async () => {
        const h = harness();
        const alice = await joinRoom(h, 'a', 'R', 'alice');
        await joinRoom(h, 'b', 'R', 'bob');
        h.emits.length = 0;

        h.disconnect(alice);

        expect(h.eventsTo('b', ACTIONS.HOST)).toHaveLength(1);
    });

    test('ends the room and frees the lobby when the host leaves alone', async () => {
        const h = harness();
        const alice = await joinRoom(h, 'a', 'R', 'alice');
        alice.handlers[ACTIONS.LOCK_ROOM]({ roomId: 'R' });
        await joinRoom(h, 'b', 'R', 'bob'); // waiting
        h.emits.length = 0;

        h.disconnect(alice);

        expect(h.eventsTo('b', ACTIONS.DENIED)[0].payload).toEqual({
            reason: 'host-left',
        });
    });
});

describe('CODE_CHANGE / LANGUAGE_CHANGE', () => {
    test('CODE_CHANGE relays to the room and schedules a debounced save', () => {
        jest.useFakeTimers();
        const h = harness();
        const alice = h.connect('a');

        alice.handlers[ACTIONS.CODE_CHANGE]({ roomId: 'R', code: 'hello' });

        expect(h.emits).toContainEqual({
            to: 'in:R',
            event: ACTIONS.CODE_CHANGE,
            payload: { code: 'hello' },
        });
        jest.advanceTimersByTime(2000);
        expect(db.saveRoomContent).toHaveBeenCalledWith('R', 'hello');
        jest.useRealTimers();
    });

    test('CODE_CHANGE ignores malformed payloads', () => {
        const h = harness();
        const alice = h.connect('a');
        alice.handlers[ACTIONS.CODE_CHANGE]({ roomId: 123, code: 'x' });
        alice.handlers[ACTIONS.CODE_CHANGE]({ roomId: 'R', code: null });
        expect(h.emits).toHaveLength(0);
        expect(db.saveRoomContent).not.toHaveBeenCalled();
    });

    test('LANGUAGE_CHANGE relays and persists', () => {
        const h = harness();
        const alice = h.connect('a');
        alice.handlers[ACTIONS.LANGUAGE_CHANGE]({ roomId: 'R', languageId: 71 });
        expect(h.emits).toContainEqual({
            to: 'in:R',
            event: ACTIONS.LANGUAGE_CHANGE,
            payload: { languageId: 71 },
        });
        expect(db.setRoomLanguage).toHaveBeenCalledWith('R', 71);
    });

    test('LANGUAGE_CHANGE ignores a non-integer id', () => {
        const h = harness();
        const alice = h.connect('a');
        alice.handlers[ACTIONS.LANGUAGE_CHANGE]({
            roomId: 'R',
            languageId: 'python',
        });
        expect(db.setRoomLanguage).not.toHaveBeenCalled();
    });
});

describe('flushPendingSaves', () => {
    beforeEach(() => jest.useFakeTimers());
    afterEach(() => jest.useRealTimers());

    test('writes the latest code per room and cancels the debounce', async () => {
        const h = harness();
        const alice = h.connect('a');

        alice.handlers[ACTIONS.CODE_CHANGE]({ roomId: 'A', code: 'v1' });
        alice.handlers[ACTIONS.CODE_CHANGE]({ roomId: 'A', code: 'v2' });
        alice.handlers[ACTIONS.CODE_CHANGE]({ roomId: 'B', code: 'b1' });

        const count = await h.flushPendingSaves();

        expect(count).toBe(2);
        expect(db.saveRoomContent).toHaveBeenCalledWith('A', 'v2');
        expect(db.saveRoomContent).toHaveBeenCalledWith('B', 'b1');
        expect(db.saveRoomContent).not.toHaveBeenCalledWith('A', 'v1');

        db.saveRoomContent.mockClear();
        jest.advanceTimersByTime(5000);
        expect(db.saveRoomContent).not.toHaveBeenCalled();
    });

    test('a second flush with nothing pending is a no-op', async () => {
        const h = harness();
        h.connect('a').handlers[ACTIONS.CODE_CHANGE]({ roomId: 'A', code: 'x' });
        await h.flushPendingSaves();
        db.saveRoomContent.mockClear();
        expect(await h.flushPendingSaves()).toBe(0);
        expect(db.saveRoomContent).not.toHaveBeenCalled();
    });
});
