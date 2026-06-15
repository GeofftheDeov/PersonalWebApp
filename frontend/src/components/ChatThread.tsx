"use client";

import { useCallback, useEffect, useRef, useState } from 'react';
import { Send, WifiOff } from 'lucide-react';

interface ChatMessage {
    messageId: string;
    sender: { id: string; name: string; email: string };
    body: string;
    createdAt: string;
}

export interface ChatChannel {
    kind: 'campaign' | 'dm';
    /** Campaign id, or the other user's id for DMs. */
    id: string;
}

/** Older messages stored the sender's email as the name — show the handle-ish local part instead. */
const senderLabel = (s: { name?: string }) => {
    const n = s?.name || 'UNKNOWN';
    return n.includes('@') ? n.split('@')[0] : n;
};

/**
 * Live chat thread for the Social Hub — campaign Table Talk or a friend DM.
 * History via REST, live updates via SSE, both fed by the backend event bus
 * (gamenight.message / social.dm). Dark styling to sit inside the dock panel.
 */
export default function ChatThread({ channel, placeholder }: { channel: ChatChannel; placeholder?: string }) {
    const [messages, setMessages] = useState<ChatMessage[]>([]);
    const [draft, setDraft] = useState('');
    const [sending, setSending] = useState(false);
    const [connected, setConnected] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const scrollRef = useRef<HTMLDivElement>(null);
    const seen = useRef<Set<string>>(new Set());

    const base = `/api/messages/${channel.kind === 'campaign' ? 'campaign' : 'dm'}/${channel.id}`;

    const token = () => (typeof window !== 'undefined' ? localStorage.getItem('token') : null);

    const myId = useRef<string | null>(null);
    useEffect(() => {
        // Best-effort decode of own user id for left/right message alignment.
        try {
            const t = token();
            if (t) myId.current = JSON.parse(atob(t.split('.')[1]))?.id ?? null;
        } catch { /* alignment is cosmetic */ }
    }, []);

    const append = useCallback((msgs: ChatMessage[]) => {
        const fresh = msgs.filter(m => !seen.current.has(m.messageId));
        if (!fresh.length) return;
        fresh.forEach(m => seen.current.add(m.messageId));
        setMessages(prev => [...prev, ...fresh].sort(
            (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
        ));
    }, []);

    // Reset on channel switch, then history + SSE subscription.
    useEffect(() => {
        setMessages([]);
        seen.current = new Set();
        setError(null);
        setConnected(false);

        const t = token();
        if (!t || !channel.id) return;

        fetch(`${base}?limit=50`, { headers: { Authorization: `Bearer ${t}` } })
            .then(async res => {
                if (!res.ok) {
                    const err = await res.json().catch(() => ({}));
                    throw new Error(err.error || 'history failed');
                }
                const rows = await res.json();
                append(rows.map((r: any) => ({
                    messageId: r._id, sender: r.sender, body: r.body, createdAt: r.createdAt,
                })));
            })
            .catch((err) => setError(err.message === 'history failed' ? 'Could not load chat history' : err.message));

        const es = new EventSource(`${base}/stream?token=${encodeURIComponent(t)}`);
        es.addEventListener('connected', () => { setConnected(true); setError(null); });
        es.addEventListener('message', (e: MessageEvent) => {
            try { append([JSON.parse(e.data)]); } catch { /* ignore malformed frame */ }
        });
        es.onerror = () => setConnected(false); // EventSource auto-reconnects

        return () => es.close();
    }, [channel.kind, channel.id, base, append]);

    // Auto-scroll on new messages
    useEffect(() => {
        scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
    }, [messages]);

    const handleSend = async (e: React.FormEvent) => {
        e.preventDefault();
        const body = draft.trim();
        if (!body || sending) return;
        setSending(true);
        setError(null);
        try {
            const res = await fetch(base, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token()}` },
                body: JSON.stringify({ body }),
            });
            if (!res.ok) {
                const err = await res.json().catch(() => ({}));
                throw new Error(err.error || 'Failed to send');
            }
            const saved = await res.json();
            append([{ messageId: saved._id, sender: saved.sender, body: saved.body, createdAt: saved.createdAt }]);
            setDraft('');
        } catch (err: any) {
            setError(err.message || 'Failed to send');
        } finally {
            setSending(false);
        }
    };

    const fmtTime = (iso: string) =>
        new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }).toUpperCase();

    return (
        <div className="flex flex-col h-full min-h-0">
            <div className="flex justify-end mb-2">
                <span className={`flex items-center gap-1.5 px-2 py-0.5 border-2 border-black font-black text-[10px] uppercase ${connected ? 'bg-teal-500 text-white' : 'bg-zinc-600 text-zinc-200'}`}>
                    {connected ? 'LIVE' : <><WifiOff className="w-3 h-3" /> OFFLINE</>}
                </span>
            </div>

            <div ref={scrollRef} className="flex-grow min-h-0 overflow-y-auto space-y-3 border-4 border-black bg-zinc-800 p-3 custom-scrollbar">
                {messages.length === 0 ? (
                    <p className="font-bold text-xs text-zinc-500 uppercase text-center pt-16">
                        No messages yet. Break the ice.
                    </p>
                ) : messages.map(m => {
                    const mine = myId.current != null && m.sender.id === myId.current;
                    return (
                        <div key={m.messageId} className={`flex ${mine ? 'justify-end' : 'justify-start'}`}>
                            <div className={`max-w-[85%] p-2 border-2 border-black ${mine ? 'bg-teal-500 text-white' : 'bg-zinc-700 text-white'}`}>
                                <div className="flex items-baseline gap-2">
                                    <span className={`font-black text-[10px] uppercase ${mine ? 'text-yellow-300' : 'text-teal-400'}`}>{senderLabel(m.sender)}</span>
                                    <span className={`text-[9px] font-bold ${mine ? 'text-teal-100' : 'text-zinc-400'}`}>{fmtTime(m.createdAt)}</span>
                                </div>
                                <p className="text-sm whitespace-pre-wrap break-words">{m.body}</p>
                            </div>
                        </div>
                    );
                })}
            </div>

            <form onSubmit={handleSend} className="flex border-4 border-t-0 border-black">
                <input
                    value={draft}
                    onChange={e => setDraft(e.target.value)}
                    placeholder={placeholder || 'TYPE A MESSAGE…'}
                    maxLength={4000}
                    className="flex-grow min-w-0 p-2.5 bg-black text-white font-bold text-sm outline-none placeholder-zinc-600 focus:bg-zinc-900"
                />
                <button
                    type="submit"
                    disabled={sending || !draft.trim()}
                    className="px-4 bg-yellow-400 text-black border-l-4 border-black font-black uppercase text-xs flex items-center gap-1.5 hover:bg-white transition-colors disabled:opacity-50 disabled:hover:bg-yellow-400"
                >
                    <Send className="w-4 h-4" /> SEND
                </button>
            </form>
            {error && <p className="mt-2 font-bold text-[10px] text-red-500 uppercase">{error}</p>}
        </div>
    );
}
