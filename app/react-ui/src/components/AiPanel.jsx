/**
 * AiPanel.jsx — AI Assistant chat panel for MCP ADT Manager
 *
 * Features:
 *  - Chat interface with message history
 *  - Tool call bubbles showing AI's ADT operations
 *  - Mock data mode for UI development/testing (MOCK_MODE = true)
 *  - New chat session creation
 */

import { useState, useRef, useEffect } from 'react';
import ToolCallBubble from './ToolCallBubble';

const USER_ROLE = 'user';
const AI_ROLE   = 'assistant';

// ── Toggle mock mode for local UI development (no backend needed) ──
const MOCK_MODE = import.meta.env.DEV && !import.meta.env.VITE_REAL_AI;

const MOCK_CONVERSATION = [
    { role: USER_ROLE, content: 'Find all classes starting with ZCL_IYH in the system' },
    {
        role: AI_ROLE,
        content: 'I found **3 ABAP classes** matching your query `ZCL_IYH*`:',
        toolCalls: [
            { turn: 0, tool: 'search_object', params: { query: 'ZCL_IYH*', objectType: 'CLAS' }, status: 'success', result: '{"count":3,"data":[]}', textBefore: 'Searching the ABAP repository...' }
        ]
    },
    { role: USER_ROLE, content: 'Create a new class ZCL_TEST_AI in package ZPK_IYH1HC_MCP that prints Hello World' },
    {
        role: AI_ROLE,
        content: '✓ Successfully created and activated class `ZCL_TEST_AI` in package `ZPK_IYH1HC_MCP`.\n\nThe class has a public method `run` that outputs:\n```abap\nWRITE: / \'Hello World\'.\n```\nYou can now open it in Eclipse ADT or activate it from the Source Editor tab.',
        toolCalls: [
            { turn: 0, tool: 'search_package', params: { query: 'ZPK_IYH1HC_MCP' }, status: 'success', result: '{"count":1}', textBefore: 'Looking up the package...' },
            { turn: 1, tool: 'create_object',  params: { name: 'ZCL_TEST_AI', objectType: 'CLAS/OC' }, status: 'success', result: '{"objectUrl":"/sap/bc/adt/oo/classes/zcl_test_ai"}', textBefore: 'Creating the class...' },
            { turn: 2, tool: 'lock',            params: { objectUrl: '/sap/bc/adt/oo/classes/zcl_test_ai' }, status: 'success', result: '{"lockHandle":"CA0F3716..."}', textBefore: 'Locking for editing...' },
            { turn: 3, tool: 'set_source',      params: { objectUrl: '/sap/bc/adt/oo/classes/zcl_test_ai', sourceUrl: '/sap/bc/adt/oo/classes/zcl_test_ai/source/main' }, status: 'success', result: '{"message":"Source saved"}', textBefore: 'Uploading source code...' },
            { turn: 4, tool: 'unlock',          params: { objectUrl: '/sap/bc/adt/oo/classes/zcl_test_ai' }, status: 'success', result: '{"message":"Object unlocked"}', textBefore: '' },
            { turn: 5, tool: 'activate',        params: { objects: [{ 'adtcore:name': 'ZCL_TEST_AI', 'adtcore:type': 'CLAS/OC' }] }, status: 'success', result: '{"message":"Activated successfully"}', textBefore: 'Activating...' },
        ]
    },
];

async function mockChat(message) {
    await new Promise(r => setTimeout(r, 1400));
    return {
        response: `I received your request: **"${message}"**\n\nThis is a **mock response** for UI development. In production, the AI would:\n1. Analyze your request\n2. Call the appropriate ADT tools\n3. Return real results from SAP system \`T4X_011\``,
        historyId: 'mock-session-001',
        toolCalls: [
            { turn: 0, tool: 'search_object', params: { query: message.split(' ').pop() }, status: 'success', result: '{"count":2}', textBefore: 'Processing your request...' }
        ]
    };
}

export default function AiPanel({ destinationName }) {
    const [messages, setMessages]     = useState(MOCK_MODE ? MOCK_CONVERSATION : []);
    const [input, setInput]           = useState('');
    const [loading, setLoading]       = useState(false);
    const [historyId, setHistoryId]   = useState(MOCK_MODE ? 'mock-session-001' : null);
    const messagesEndRef               = useRef(null);
    const inputRef                     = useRef(null);

    useEffect(() => {
        messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }, [messages]);

    function startNewChat() {
        setMessages([]);
        setHistoryId(null);
        setInput('');
        inputRef.current?.focus();
    }

    async function sendMessage() {
        const text = input.trim();
        if (!text || loading) return;

        setInput('');
        setLoading(true);

        setMessages(prev => [...prev, { role: USER_ROLE, content: text }]);

        const thinkingId = Date.now();
        setMessages(prev => [
            ...prev,
            { role: AI_ROLE, id: thinkingId, content: '', toolCalls: [], thinking: true }
        ]);

        try {
            let data;
            if (MOCK_MODE) {
                data = await mockChat(text);
            } else {
                const res = await fetch('/api/ai/chat', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ message: text, historyId, destinationName: destinationName || 'T4X_011' })
                });
                data = await res.json();
                if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
            }

            if (data.historyId && !historyId) setHistoryId(data.historyId);

            setMessages(prev => prev.map(m =>
                m.id === thinkingId
                    ? { role: AI_ROLE, content: data.response, toolCalls: data.toolCalls || [], thinking: false }
                    : m
            ));
        } catch (err) {
            setMessages(prev => prev.map(m =>
                m.id === thinkingId
                    ? { role: AI_ROLE, content: `Error: ${err.message}`, toolCalls: [], thinking: false, isError: true }
                    : m
            ));
        } finally {
            setLoading(false);
            inputRef.current?.focus();
        }
    }

    function handleKeyDown(e) {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            sendMessage();
        }
    }

    return (
        <div className="ai-panel">

            {/* ── Header ── */}
            <div className="ai-panel-header">
                <div className="ai-panel-title">
                    <span className="ai-panel-icon">✦</span>
                    <span>AI Assistant</span>
                    {MOCK_MODE && <span className="ai-mock-badge">Mock</span>}
                    {!MOCK_MODE && historyId && (
                        <span className="ai-session-badge">● Active</span>
                    )}
                </div>
                <button className="ai-new-chat-btn" onClick={startNewChat} disabled={loading} title="Start a new conversation">
                    <svg width="13" height="13" viewBox="0 0 14 14" fill="none">
                        <path d="M7 1v12M1 7h12" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/>
                    </svg>
                    New Chat
                </button>
            </div>

            {/* ── Messages ── */}
            <div className="ai-messages">
                {messages.length === 0 && (
                    <div className="ai-empty-state">
                        <div className="ai-empty-icon">✦</div>
                        <div className="ai-empty-title">MCP ADT AI Assistant</div>
                        <div className="ai-empty-subtitle">
                            Describe what you need in plain language.<br/>
                            I will search, create, and modify ABAP objects automatically.
                        </div>
                        <div className="ai-suggestions">
                            {[
                                'Find all classes starting with ZCL_IYH',
                                'Read source code of ZCL_IYH1HC_MCP',
                                'Create class ZCL_TEST in package ZPK_IYH1HC_MCP',
                            ].map(s => (
                                <button key={s} className="ai-suggestion-chip"
                                    onClick={() => { setInput(s); inputRef.current?.focus(); }}>
                                    <span className="ai-chip-arrow">→</span> {s}
                                </button>
                            ))}
                        </div>
                    </div>
                )}

                {messages.map((msg, idx) => (
                    <div key={idx} className={`ai-message ai-message--${msg.role}`}>
                        <div className="ai-message-label">
                            {msg.role === USER_ROLE
                                ? <><span className="ai-avatar ai-avatar--user">Y</span> You</>
                                : <><span className="ai-avatar ai-avatar--ai">✦</span> AI Assistant</>
                            }
                        </div>

                        {msg.role === AI_ROLE && msg.toolCalls?.length > 0 && (
                            <div className="ai-tool-calls">
                                {msg.toolCalls.map((tc, i) => (
                                    <ToolCallBubble key={i} toolCall={tc} />
                                ))}
                            </div>
                        )}

                        {msg.thinking ? (
                            <div className="ai-thinking">
                                <span className="ai-thinking-dot" />
                                <span className="ai-thinking-dot" />
                                <span className="ai-thinking-dot" />
                            </div>
                        ) : (
                            <div className={`ai-message-content ${msg.isError ? 'ai-message--error' : ''}`}>
                                <MarkdownText text={msg.content} />
                            </div>
                        )}
                    </div>
                ))}
                <div ref={messagesEndRef} />
            </div>

            {/* ── Input Bar ── */}
            <div className="ai-input-bar">
                <div className="ai-input-wrapper">
                    <textarea
                        ref={inputRef}
                        className="ai-input"
                        value={input}
                        onChange={e => setInput(e.target.value)}
                        onKeyDown={handleKeyDown}
                        placeholder="Ask me anything about your ABAP objects...  ⏎ Send  ⇧⏎ New line"
                        rows={1}
                        disabled={loading}
                    />
                    <button
                        className={`ai-send-btn ${loading ? 'ai-send-btn--loading' : ''} ${!input.trim() ? 'ai-send-btn--empty' : ''}`}
                        onClick={sendMessage}
                        disabled={loading || !input.trim()}
                        title="Send (Enter)"
                    >
                        {loading
                            ? <span className="ai-spinner" />
                            : <svg width="16" height="16" viewBox="0 0 20 20" fill="none">
                                <path d="M3 10h14M11 4l6 6-6 6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
                              </svg>
                        }
                    </button>
                </div>
                <div className="ai-input-hint">
                    Destination: <strong>{destinationName || 'T4X_011'}</strong>
                    {MOCK_MODE && <span style={{color:'var(--warn)', marginLeft: 8}}>· Mock Mode</span>}
                </div>
            </div>
        </div>
    );
}

function MarkdownText({ text = '' }) {
    if (!text) return null;
    const parts = text.split(/(```[\s\S]*?```)/g);
    return (
        <div className="ai-markdown">
            {parts.map((part, i) => {
                if (part.startsWith('```')) {
                    const lang = part.match(/^```(\w*)/)?.[1] || '';
                    const code = part.replace(/^```[^\n]*\n?/, '').replace(/```$/, '');
                    return (
                        <div key={i} className="ai-code-block-wrap">
                            {lang && <span className="ai-code-lang">{lang.toUpperCase()}</span>}
                            <pre className="ai-code-block"><code>{code.trim()}</code></pre>
                        </div>
                    );
                }
                return (
                    <span key={i}>
                        {part.split('\n').map((line, li, arr) => {
                            const formatted = line.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).map((seg, si) => {
                                if (seg.startsWith('**') && seg.endsWith('**'))
                                    return <strong key={si}>{seg.slice(2, -2)}</strong>;
                                if (seg.startsWith('`') && seg.endsWith('`'))
                                    return <code key={si} className="ai-inline-code">{seg.slice(1, -1)}</code>;
                                return seg;
                            });
                            return <span key={li}>{formatted}{li < arr.length - 1 && <br />}</span>;
                        })}
                    </span>
                );
            })}
        </div>
    );
}
