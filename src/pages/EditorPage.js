import React, { useState, useRef, useEffect } from 'react';
import toast from 'react-hot-toast';
import ACTIONS from '../Actions';
import Client from '../components/Client';
import Editor from '../components/Editor';
import axios from 'axios';
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
    const [clients, setClients] = useState([]);

    const [languageId, setLanguageId] = useState(63); // Default: JavaScript (Node.js)
    const languages = [
        { id: 54, name: 'C++ (GCC 9.2.0)' },
        { id: 62, name: 'Java (OpenJDK 13.0.1)' },
        { id: 63, name: 'JavaScript (Node.js 12.14.0)' },
        { id: 71, name: 'Python (3.8.1)' },
    // Add more if needed
    ];


    useEffect(() => {
        const init = async () => {
            socketRef.current = await initSocket();
            socketRef.current.on('connect_error', (err) => handleErrors(err));
            socketRef.current.on('connect_failed', (err) => handleErrors(err));

            function handleErrors(e) {
                console.log('socket error', e);
                toast.error('Socket connection failed, try again later.');
                reactNavigator('/');
            }

            socketRef.current.emit(ACTIONS.JOIN, {
                roomId,
                username: location.state?.username,
            });

            socketRef.current.on(ACTIONS.JOINED, ({ clients, username, socketId }) => {
                if (username !== location.state?.username) {
                    toast.success(`${username} joined the room.`);
                }
                setClients(clients);
                socketRef.current.emit(ACTIONS.SYNC_CODE, {
                    code: codeRef.current,
                    socketId,
                });
            });

            socketRef.current.on(ACTIONS.DISCONNECTED, ({ socketId, username }) => {
                toast.success(`${username} left the room.`);
                setClients((prev) =>
                    prev.filter((client) => client.socketId !== socketId)
                );
            });
        };

        init();

        // Safe cleanup to avoid calling methods on null
        return () => {
            if (socketRef.current) {
                socketRef.current.disconnect();
                socketRef.current.off(ACTIONS.JOINED);
                socketRef.current.off(ACTIONS.DISCONNECTED);
            }
        };
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

    

const JUDGE0_API_URL = 'https://judge0-ce.p.rapidapi.com/submissions';
const JUDGE0_API_HEADERS = {
    'Content-Type': 'application/json',
    'X-RapidAPI-Key': '348a4001c5msh9f2bad44424f12ap1a01f8jsnd65c423164eb',
    'X-RapidAPI-Host': 'judge0-ce.p.rapidapi.com',
};

async function runCode(language_id, source_code, stdin = '') {
    try {
        const { data } = await axios.post(
            JUDGE0_API_URL + '?base64_encoded=false&wait=true',
            {
                source_code,
                language_id, // e.g., 63 for JavaScript (Node.js)
                stdin,
            },
            { headers: JUDGE0_API_HEADERS }
        );

        return data; // Contains output, stderr, compile_output, etc.
    } catch (err) {
        console.error('Code execution failed:', err);
        return { error: 'Code execution failed.' };
    }
}

const [output, setOutput] = useState('');

const handleRunClick = async () => {
    const code = codeRef.current;
    const result = await runCode(languageId, code);
    if (result.stdout) setOutput(result.stdout);
    else if (result.stderr) setOutput(result.stderr);
    else if (result.compile_output) setOutput(result.compile_output);
    else setOutput('No output');
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

                

                <button className="btn runBtn" onClick={handleRunClick}>
                    Run Code
                </button>

                 <div className="outputWindow">
                     <h3>Output:</h3>
                    <pre>{output}</pre>
                     </div>

                <button className="btn copyBtn" onClick={copyRoomId}>
                    Copy ROOM ID
                </button>

                

                <button className="btn leaveBtn" onClick={leaveRoom}>
                    Leave
                </button>
            </div>
            <div className="editorWrap">
                <Editor
                    socketRef={socketRef}
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
