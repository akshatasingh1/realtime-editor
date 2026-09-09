import React, { useEffect, useRef } from 'react';
import Codemirror from 'codemirror';
import 'codemirror/lib/codemirror.css';
import 'codemirror/theme/dracula.css';
import 'codemirror/mode/javascript/javascript';
import 'codemirror/addon/edit/closetag';
import 'codemirror/addon/edit/closebrackets';
import ACTIONS from '../Actions';

const Editor = ({ socket, roomId, onCodeChange }) => {
    const editorRef = useRef(null);

    // Keep the latest socket/roomId/onCodeChange reachable from the CodeMirror
    // "change" handler, which is registered once and must not close over stale
    // values.
    const socketRef = useRef(socket);
    const roomIdRef = useRef(roomId);
    const onCodeChangeRef = useRef(onCodeChange);
    useEffect(() => {
        socketRef.current = socket;
        roomIdRef.current = roomId;
        onCodeChangeRef.current = onCodeChange;
    }, [socket, roomId, onCodeChange]);

    // Initialise CodeMirror once.
    useEffect(() => {
        editorRef.current = Codemirror.fromTextArea(
            document.getElementById('realtimeEditor'),
            {
                mode: { name: 'javascript', json: true },
                theme: 'dracula',
                autoCloseTags: true,
                autoCloseBrackets: true,
                lineNumbers: true,
            }
        );

        editorRef.current.on('change', (instance, changes) => {
            const { origin } = changes;
            const code = instance.getValue();
            onCodeChangeRef.current?.(code);
            if (origin !== 'setValue') {
                socketRef.current?.emit(ACTIONS.CODE_CHANGE, {
                    roomId: roomIdRef.current,
                    code,
                });
            }
        });

        return () => {
            editorRef.current?.toTextArea();
            editorRef.current = null;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // (Re)subscribe to remote edits whenever the socket instance changes.
    useEffect(() => {
        if (!socket) return undefined;

        const handleRemoteChange = ({ code }) => {
            if (code !== null && editorRef.current) {
                editorRef.current.setValue(code);
            }
        };

        socket.on(ACTIONS.CODE_CHANGE, handleRemoteChange);
        return () => socket.off(ACTIONS.CODE_CHANGE, handleRemoteChange);
    }, [socket]);

    return <textarea id="realtimeEditor"></textarea>;
};

export default Editor;
