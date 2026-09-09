// Real in-process Socket.IO server + real socket.io-client. Only the DB is
// mocked, so this exercises the actual event wiring end to end.
jest.mock('../server/db', () => ({
    isEnabled: jest.fn(() => false),
    init: jest.fn().mockResolvedValue(undefined),
    getRoom: jest.fn().mockResolvedValue(null),
    ensureRoom: jest.fn().mockResolvedValue({ content: '', language_id: 63 }),
    saveRoomContent: jest.fn().mockResolvedValue(undefined),
    setRoomLanguage: jest.fn().mockResolvedValue(undefined),
    recordExecution: jest.fn().mockResolvedValue(undefined),
    listExecutions: jest.fn().mockResolvedValue([]),
}));

const http = require('http');
const { Server } = require('socket.io');
const { io: ioClient } = require('socket.io-client');
const { registerSocketHandlers } = require('../server/sockets');
const ACTIONS = require('../src/Actions');

let httpServer;
let io;
let url;

beforeAll((done) => {
    jest.spyOn(console, 'log').mockImplementation(() => {});
    httpServer = http.createServer();
    io = new Server(httpServer);
    registerSocketHandlers(io);
    httpServer.listen(() => {
        url = `http://localhost:${httpServer.address().port}`;
        done();
    });
});

afterAll((done) => {
    io.close(done);
});

const connect = () =>
    ioClient(url, { forceNew: true, transports: ['websocket'] });
const once = (socket, event) =>
    new Promise((resolve) => socket.once(event, resolve));
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('a late joiner gets the document from exactly one peer', async () => {
    const alice = connect();
    await once(alice, 'connect');
    alice.on(ACTIONS.SYNC_REQUEST, ({ socketId }) => {
        alice.emit(ACTIONS.SYNC_CODE, { socketId, code: 'aliceDoc' });
    });
    alice.emit(ACTIONS.JOIN, { roomId: 'room-x', username: 'alice' });
    await wait(100);

    const bob = connect();
    let codeMessages = 0;
    let bobDoc = null;
    bob.on(ACTIONS.CODE_CHANGE, ({ code }) => {
        codeMessages += 1;
        bobDoc = code;
    });
    await once(bob, 'connect');
    bob.emit(ACTIONS.JOIN, { roomId: 'room-x', username: 'bob' });
    await wait(300);

    expect(bobDoc).toBe('aliceDoc');
    expect(codeMessages).toBe(1);

    alice.disconnect();
    bob.disconnect();
});

test('a language change propagates to the other client in the room', async () => {
    const alice = connect();
    await once(alice, 'connect');
    alice.emit(ACTIONS.JOIN, { roomId: 'room-lang', username: 'alice' });
    await wait(100);

    const bob = connect();
    let bobLang = null;
    bob.on(ACTIONS.LANGUAGE_CHANGE, ({ languageId }) => {
        bobLang = languageId;
    });
    await once(bob, 'connect');
    bob.emit(ACTIONS.JOIN, { roomId: 'room-lang', username: 'bob' });
    await wait(150);

    alice.emit(ACTIONS.LANGUAGE_CHANGE, {
        roomId: 'room-lang',
        languageId: 71,
    });
    await wait(200);

    expect(bobLang).toBe(71);

    alice.disconnect();
    bob.disconnect();
});

test('re-emitting JOIN (a reconnect) produces a fresh JOINED', async () => {
    const alice = connect();
    await once(alice, 'connect');
    alice.emit(ACTIONS.JOIN, { roomId: 'room-rejoin', username: 'alice' });
    await wait(100);

    let joinedCount = 0;
    alice.on(ACTIONS.JOINED, () => {
        joinedCount += 1;
    });
    alice.emit(ACTIONS.JOIN, { roomId: 'room-rejoin', username: 'alice' });
    await wait(200);

    expect(joinedCount).toBeGreaterThan(0);
    alice.disconnect();
});
