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

const EditorPage = () => {
    const socketRef = useRef(null);
    const codeRef = useRef(null);
    const location = useLocation();
    const { roomId } = useParams();
    const reactNavigator = useNavigate();

    const [socket, setSocket] = useState(null);
    const [clients, setClients] = useState([]);
    const [output, setOutput] = useState('');
    const [isRunning, setIsRunning] = useState(false);
    const [executions, setExecutions] = useState([]);

    const [languageId, setLanguageId] = useState(63); // Default: JavaScript (Node.js)
    const languages = [
        { id: 54, name: 'C++ (GCC 9.2.0)' },
        { id: 62, name: 'Java (OpenJDK 13.0.1)' },
        { id: 63, name: 'JavaScript (Node.js 12.14.0)' },
        { id: 71, name: 'Python (3.8.1)' },
    ];

    useEffect(() => {
        // Guards against React 18 StrictMode double-invoking this effect.
        // Because init() is async, the effect can be cleaned up before the
        // socket finishes connecting; without this flag the first (orphaned)
        // socket would still join the room, showing the user twice.
        let cancelled = false;

        const handleErrors = (e) => {
            console.log('socket error', e);
            toast.error('Socket connection failed, try again later.');
            reactNavigator('/');
        };

        const init = async () => {
            const conn = await initSocket();

            if (cancelled) {
                // Effect was cleaned up while we were connecting - throw this
                // socket away so it never joins the room.
                conn.disconnect();
                return;
            }

            socketRef.current = conn;
            setSocket(conn);

            conn.on('connect_error', handleErrors);
            conn.on('connect_failed', handleErrors);

            conn.emit(ACTIONS.JOIN, {
                roomId,
                username: location.state?.username,
            });

            conn.on(ACTIONS.JOINED, ({ clients, username, socketId }) => {
                if (username !== location.state?.username) {
                    toast.success(`${username} joined the room.`);
                }
                setClients(clients);
                conn.emit(ACTIONS.SYNC_CODE, {
                    code: codeRef.current,
                    socketId,
                });
            });

            conn.on(ACTIONS.DISCONNECTED, ({ socketId, username }) => {
                toast.success(`${username} left the room.`);
                setClients((prev) =>
                    prev.filter((client) => client.socketId !== socketId)
                );
            });
        };

        init();

        return () => {
            cancelled = true;
            const conn = socketRef.current;
            if (conn) {
                conn.off('connect_error', handleErrors);
                conn.off('connect_failed', handleErrors);
                conn.off(ACTIONS.JOINED);
                conn.off(ACTIONS.DISCONNECTED);
                conn.disconnect();
            }
            socketRef.current = null;
            setSocket(null);
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    useEffect(() => {
        fetchExecutions(roomId).then(setExecutions);
    }, [roomId]);

    async function copyRoomId() {
        try {
            await navigator.clipboard.writeText(roomId);
            toast.success('Room ID has been copied to your clipboard');
        } catch (err) {
            toast.error('Could not copy the Room ID');
            console.error(err);
        }
    }

    const handleRunClick = async () => {
        if (isRunning) return;
        setIsRunning(true);
        setOutput('Running...');
        try {
            const result = await runCode(languageId, codeRef.current, roomId);
            if (result.stdout) setOutput(result.stdout);
            else if (result.stderr) setOutput(result.stderr);
            else if (result.compile_output) setOutput(result.compile_output);
            else if (result.error) setOutput(result.error);
            else setOutput('No output');

            if (!result.error) {
                fetchExecutions(roomId).then(setExecutions);
            }
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
            <div className="aside">
                <div className="asideInner">
                    <div className="logo">
                        <img
                            className="logoImage"
                            src="/code-sync.png"
                            alt="logo"
                        />
                    </div>
                    <h3>Connected</h3>
                    <div className="clientsList">
                        {clients.map((client) => (
                            <Client
                                key={client.socketId}
                                username={client.username}
                            />
                        ))}
                    </div>

                    <div className="languageSelector">
                        <label htmlFor="language">Language:</label>
                        <select
                            id="language"
                            value={languageId}
                            onChange={(e) => setLanguageId(Number(e.target.value))}
                        >
                            {languages.map((lang) => (
                                <option key={lang.id} value={lang.id}>
                                    {lang.name}
                                </option>
                            ))}
                        </select>
                    </div>
                </div>

                <button
                    className="btn runBtn"
                    onClick={handleRunClick}
                    disabled={isRunning}
                >
                    {isRunning ? 'Running...' : 'Run Code'}
                </button>

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
                                    {new Date(ex.created_at).toLocaleTimeString()}
                                    {' — '}
                                    {ex.status || 'unknown'}
                                </li>
                            ))}
                        </ul>
                    </div>
                )}

                <button className="btn copyBtn" onClick={copyRoomId}>
                    Copy ROOM ID
                </button>

                <button className="btn leaveBtn" onClick={leaveRoom}>
                    Leave
                </button>
            </div>
            <div className="editorWrap">
                <Editor
                    socket={socket}
                    roomId={roomId}
                    onCodeChange={(code) => {
                        codeRef.current = code;
                    }}
                />
            </div>
        </div>
    );
};

export default EditorPage;
