import React, { useState, useRef, useEffect } from 'react';
import toast from 'react-hot-toast';
import ACTIONS from '../Actions';
import Client from '../components/Client';
import Editor from '../components/Editor';
import { runCode, fetchExecutions } from '../api/execution';
import { initSocket } from '../socket';
import {
    useLocation,
    useNavigate,
    Navigate,
    useParams,
} from 'react-router-dom';

const LANGUAGES = [
    { id: 54, name: 'C++ (GCC 9.2.0)' },
    { id: 62, name: 'Java (OpenJDK 13.0.1)' },
    { id: 63, name: 'JavaScript (Node.js 12.14.0)' },
    { id: 71, name: 'Python (3.8.1)' },
];

const EditorPage = () => {
    const socketRef = useRef(null);
    const codeRef = useRef(null);
    const location = useLocation();
    const { roomId } = useParams();
    const reactNavigator = useNavigate();

    // Host token survives a reload/reconnect so the host stays the host.
    const hostKey = `codesync:host:${roomId}`;
    const readHostToken = () => {
        try {
            return window.sessionStorage.getItem(hostKey);
        } catch {
            return null;
        }
    };
    const hostTokenRef = useRef(readHostToken());
    const accessTokenRef = useRef(null);

    const [socket, setSocket] = useState(null);
    const [clients, setClients] = useState([]);
    const [stdin, setStdin] = useState('');
    const [output, setOutput] = useState('');
    const [isRunning, setIsRunning] = useState(false);
    const [executions, setExecutions] = useState([]);
    const [languageId, setLanguageId] = useState(63); // JavaScript (Node.js)

    const [waiting, setWaiting] = useState(false);
    const [isHost, setIsHost] = useState(false);
    const [locked, setLocked] = useState(false);
    const [pending, setPending] = useState([]);

    const refreshExecutions = () => {
        fetchExecutions(roomId, accessTokenRef.current).then(setExecutions);
    };

    useEffect(() => {
        // Guards against React 18 StrictMode double-invoking this effect.
        // Because init() is async, the effect can be cleaned up before the
        // socket finishes connecting; without this flag the first (orphaned)
        // socket would still join the room, showing the user twice.
        let cancelled = false;
        let hasConnected = false;

        const myUsername = location.state?.username;

        const handleErrors = (e) => {
            console.log('socket error', e);
            // Once we've connected, socket.io keeps retrying on its own -
            // a transient failure shouldn't kick the user out of the room.
            if (hasConnected) return;
            toast.error('Socket connection failed, try again later.');
            reactNavigator('/');
        };

        const init = async () => {
            const conn = await initSocket();

            if (cancelled) {
                conn.disconnect();
                return;
            }

            socketRef.current = conn;
            setSocket(conn);

            conn.on('connect_error', handleErrors);
            conn.on('connect_failed', handleErrors);

            // Fires on the first connection *and* every reconnection, so a
            // dropped network blip re-joins the room instead of silently
            // leaving the user desynced until they refresh.
            const emitJoin = () => {
                conn.emit(ACTIONS.JOIN, {
                    roomId,
                    username: myUsername,
                    hostToken: hostTokenRef.current || undefined,
                });
            };
            conn.on('connect', () => {
                if (hasConnected) toast.success('Reconnected.');
                hasConnected = true;
                emitJoin();
            });
            if (conn.connected) {
                hasConnected = true;
                emitJoin();
            }

            conn.on('disconnect', (reason) => {
                if (reason !== 'io client disconnect') {
                    toast.error('Connection lost - reconnecting...');
                }
            });

            conn.on(ACTIONS.JOINED, ({ clients, username }) => {
                if (username !== myUsername) {
                    toast.success(`${username} joined the room.`);
                }
                setClients(clients);
            });

            conn.on(ACTIONS.SYNC_REQUEST, ({ socketId }) => {
                conn.emit(ACTIONS.SYNC_CODE, {
                    socketId,
                    code: codeRef.current ?? '',
                });
            });

            conn.on(ACTIONS.LANGUAGE_CHANGE, ({ languageId }) => {
                if (Number.isInteger(languageId)) setLanguageId(languageId);
            });

            conn.on(ACTIONS.DISCONNECTED, ({ socketId, username }) => {
                toast.success(`${username} left the room.`);
                setClients((prev) =>
                    prev.filter((client) => client.socketId !== socketId)
                );
            });

            // --- lockable room / admit flow ---

            conn.on(ACTIONS.HOST, ({ hostToken }) => {
                hostTokenRef.current = hostToken;
                try {
                    window.sessionStorage.setItem(hostKey, hostToken);
                } catch {
                    /* private mode - host status just won't survive reload */
                }
                setIsHost(true);
            });

            conn.on(ACTIONS.ROOM_ACCESS, ({ token, locked, isHost }) => {
                accessTokenRef.current = token;
                setLocked(locked);
                setIsHost(isHost);
                setWaiting(false);
                refreshExecutions();
            });

            conn.on(ACTIONS.ROOM_LOCK_STATE, ({ locked }) => setLocked(locked));

            conn.on(ACTIONS.WAITING, () => setWaiting(true));
            conn.on(ACTIONS.ADMITTED, () => setWaiting(false));

            conn.on(ACTIONS.DENIED, ({ reason }) => {
                if (reason === 'host-left') {
                    // The room reset; re-join and take it over.
                    emitJoin();
                    return;
                }
                toast.error('The host did not let you into the room.');
                reactNavigator('/');
            });

            conn.on(ACTIONS.KNOCK, ({ username }) => {
                toast(`${username} wants to join`, { icon: '🔔' });
            });

            conn.on(ACTIONS.PENDING, ({ pending }) => setPending(pending || []));
        };

        init();

        return () => {
            cancelled = true;
            const conn = socketRef.current;
            if (conn) {
                conn.off('connect');
                conn.off('disconnect');
                conn.off('connect_error', handleErrors);
                conn.off('connect_failed', handleErrors);
                conn.off(ACTIONS.JOINED);
                conn.off(ACTIONS.DISCONNECTED);
                conn.off(ACTIONS.SYNC_REQUEST);
                conn.off(ACTIONS.LANGUAGE_CHANGE);
                conn.off(ACTIONS.HOST);
                conn.off(ACTIONS.ROOM_ACCESS);
                conn.off(ACTIONS.ROOM_LOCK_STATE);
                conn.off(ACTIONS.WAITING);
                conn.off(ACTIONS.ADMITTED);
                conn.off(ACTIONS.DENIED);
                conn.off(ACTIONS.KNOCK);
                conn.off(ACTIONS.PENDING);
                conn.disconnect();
            }
            socketRef.current = null;
            setSocket(null);
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    async function copyRoomId() {
        try {
            await navigator.clipboard.writeText(roomId);
            toast.success('Room ID has been copied to your clipboard');
        } catch (err) {
            toast.error('Could not copy the Room ID');
            console.error(err);
        }
    }

    function changeLanguage(nextId) {
        setLanguageId(nextId);
        socketRef.current?.emit(ACTIONS.LANGUAGE_CHANGE, {
            roomId,
            languageId: nextId,
        });
    }

    function toggleLock() {
        socketRef.current?.emit(
            locked ? ACTIONS.UNLOCK_ROOM : ACTIONS.LOCK_ROOM,
            { roomId }
        );
    }

    const admit = (socketId) =>
        socketRef.current?.emit(ACTIONS.ADMIT, { roomId, socketId });
    const deny = (socketId) =>
        socketRef.current?.emit(ACTIONS.DENY, { roomId, socketId });

    const handleRunClick = async () => {
        if (isRunning) return;
        setIsRunning(true);
        setOutput('Running...');
        try {
            const result = await runCode(
                languageId,
                codeRef.current,
                roomId,
                stdin,
                accessTokenRef.current
            );
            if (result.stdout) setOutput(result.stdout);
            else if (result.stderr) setOutput(result.stderr);
            else if (result.compile_output) setOutput(result.compile_output);
            else if (result.error) setOutput(result.error);
            else setOutput('No output');

            if (!result.error) refreshExecutions();
        } finally {
            setIsRunning(false);
        }
    };

    function leaveRoom() {
        reactNavigator('/');
    }

    if (!location.state) {
        return <Navigate to="/" />;
    }

    return (
        <div className="mainWrap">
            {waiting && (
                <div className="waitingOverlay">
                    <div className="waitingCard">
                        <img
                            className="waitingLogo"
                            src="/code-sync.png"
                            alt="logo"
                        />
                        <h2>Waiting to be let in…</h2>
                        <p>The room is locked. The host has to admit you.</p>
                        <button className="btn leaveBtn" onClick={leaveRoom}>
                            Cancel
                        </button>
                    </div>
                </div>
            )}

            <div className="aside">
                <div className="asideInner">
                    <div className="logo">
                        <img
                            className="logoImage"
                            src="/code-sync.png"
                            alt="logo"
                        />
                    </div>

                    <h3>
                        Connected {locked && <span className="lockBadge">🔒 locked</span>}
                    </h3>
                    <div className="clientsList">
                        {clients.map((client) => (
                            <Client
                                key={client.socketId}
                                username={client.username}
                            />
                        ))}
                    </div>

                    {isHost && (
                        <div className="hostControls">
                            <button
                                className="btn lockBtn"
                                onClick={toggleLock}
                            >
                                {locked ? 'Unlock room' : 'Lock room'}
                            </button>

                            {pending.length > 0 && (
                                <div className="lobbyList">
                                    <h4>Waiting to join</h4>
                                    {pending.map((p) => (
                                        <div
                                            key={p.socketId}
                                            className="lobbyItem"
                                        >
                                            <span>{p.username}</span>
                                            <span className="lobbyActions">
                                                <button
                                                    onClick={() =>
                                                        admit(p.socketId)
                                                    }
                                                >
                                                    Admit
                                                </button>
                                                <button
                                                    onClick={() =>
                                                        deny(p.socketId)
                                                    }
                                                >
                                                    Deny
                                                </button>
                                            </span>
                                        </div>
                                    ))}
                                </div>
                            )}
                        </div>
                    )}
                </div>

                <button className="btn copyBtn" onClick={copyRoomId}>
                    Copy ROOM ID
                </button>

                <button className="btn leaveBtn" onClick={leaveRoom}>
                    Leave
                </button>
            </div>

            <div className="editorWrap">
                <div className="editorToolbar">
                    <div className="languageSelector">
                        <label htmlFor="language">Language:</label>
                        <select
                            id="language"
                            value={languageId}
                            onChange={(e) =>
                                changeLanguage(Number(e.target.value))
                            }
                        >
                            {LANGUAGES.map((lang) => (
                                <option key={lang.id} value={lang.id}>
                                    {lang.name}
                                </option>
                            ))}
                        </select>
                    </div>

                    <button
                        className="btn runBtn"
                        onClick={handleRunClick}
                        disabled={isRunning}
                    >
                        {isRunning ? 'Running...' : 'Run Code'}
                    </button>
                </div>

                <div className="editorMain">
                    <Editor
                        socket={socket}
                        roomId={roomId}
                        onCodeChange={(code) => {
                            codeRef.current = code;
                        }}
                    />
                </div>

                <div className="outputPanel">
                    <div className="stdinWindow">
                        <h3>Input (stdin):</h3>
                        <textarea
                            className="stdinBox"
                            value={stdin}
                            onChange={(e) => setStdin(e.target.value)}
                            placeholder="Values your program reads, one per line"
                            spellCheck="false"
                        />
                    </div>

                    <div className="outputWindow">
                        <h3>Output:</h3>
                        <pre>{output}</pre>
                    </div>

                    {executions.length > 0 && (
                        <div className="historyWindow">
                            <h3>Recent runs</h3>
                            <ul>
                                {executions.map((ex) => (
                                    <li key={ex.id}>
                                        {new Date(
                                            ex.created_at
                                        ).toLocaleTimeString()}
                                        {' — '}
                                        {ex.status || 'unknown'}
                                    </li>
                                ))}
                            </ul>
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
};

export default EditorPage;
