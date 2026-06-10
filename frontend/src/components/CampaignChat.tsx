"use client";

import { useCallback, useEffect, useRef, useState } from 'react';
import { MessageSquare, Send, WifiOff } from 'lucide-react';

interface ChatMessage {
    messageId: string;
    sender: { id: string; name: string; email: string };
    body: string;
    createdAt: string;
}

/**
 * Campaign-scoped live chat for the Game Night Planner.
 * History via REST, live updates via SSE (`/api/messages/.../stream`),
 * both fed by the backend event bus (gamenight.message).
 */
export default function CampaignChat({ campaignId }: { campaignId: string }) {
    const [messages, setMessages] = useState<ChatMessage[]>([]);
    const [draft, setDraft] = useState('');
    const [sending, setSending] = useState(false);
    const [connected, setConnected] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const scrollRef = useRef<HTMLDivElement>(null);
    const seen = useRef<Set<string>>(new Set());

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

    // History + SSE subscription
    useEffect(() => {
        const t = token();
        if (!t || !campaignId) return;

        fetch(`/api/messages/campaign/${campaignId}?limit=50`, { headers: { Authorization: `Bearer ${t}` } })
            .then(async res => {
                if (!res.ok) throw new Error('history failed');
                const rows = await res.json();
                append(rows.map((r: any) => ({
                    messageId: r._id, sender: r.sender, body: r.body, createdAt: r.createdAt,
                })));
            })
            .catch(() => setError('Could not load chat history'));

        const es = new EventSource(`/api/messages/campaign/${campaignId}/stream?token=${encodeURIComponent(t)}`);
        es.addEventListener('connected', () => { setConnected(true); setError(null); });
        es.addEventListener('message', (e: MessageEvent) => {
            try { append([JSON.parse(e.data)]); } catch { /* ignore malformed frame */ }
        });
        es.onerror = () => setConnected(false); // EventSource auto-reconnects

        return () => es.close();
    }, [campaignId, append]);

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
            const res = await fetch(`/api/messages/campaign/${campaignId}`, {
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
        <div className="mt-10">
            <div className="flex items-center justify-between mb-4">
                <h2 className="text-2xl font-permanent text-black dark:text-white uppercase flex items-center gap-2">
                    <MessageSquare className="w-5 h-5 text-teal-500" /> Table Talk
                </h2>
                <span className={`flex items-center gap-1.5 px-2 py-1 border-2 border-black font-permanent text-xs uppercase ${connected ? 'bg-teal-500 text-white' : 'bg-zinc-600 text-zinc-200'}`}>
                    {connected ? 'LIVE' : <><WifiOff className="w-3 h-3" /> OFFLINE</>}
                </span>
            </div>

            <div className="border-4 border-black bg-white dark:bg-slate-800 shadow-[4px_4px_0px_0px_rgba(0,0,0,1)]">
                <div ref={scrollRef} className="h-72 overflow-y-auto p-4 space-y-3">
                    {messages.length === 0 ? (
                        <p className="font-permanent text-sm text-zinc-400 uppercase text-center pt-24">
                            No messages yet. Say hello to the party.
                        </p>
                    ) : messages.map(m => {
                        const mine = myId.current != null && m.sender.id === myId.current;
                        return (
                            <div key={m.messageId} className={`flex ${mine ? 'justify-end' : 'justify-start'}`}>
                                <div className={`max-w-[80%] p-2.5 border-2 border-black ${mine ? 'bg-teal-500 text-white' : 'bg-yellow-50 dark:bg-slate-700 text-black dark:text-white'}`}>
                                    <div className="flex items-baseline gap-2">
                                        <span className={`font-permanent text-xs uppercase ${mine ? 'text-yellow-300' : 'text-teal-600 dark:text-yellow-400'}`}>{m.sender.name}</span>
                                        <span className={`text-[10px] font-permanent ${mine ? 'text-teal-100' : 'text-zinc-400'}`}>{fmtTime(m.createdAt)}</span>
                                    </div>
                                    <p className="text-sm whitespace-pre-wrap break-words">{m.body}</p>
                                </div>
                            </div>
                        );
                    })}
                </div>

                <form onSubmit={handleSend} className="flex border-t-4 border-black">
                    <input
                        value={draft}
                        onChange={e => setDraft(e.target.value)}
                        placeholder="MESSAGE THE PARTY…"
                        maxLength={4000}
                        className="flex-grow p-3 bg-white dark:bg-slate-900 text-black dark:text-white font-permanent text-sm uppercase outline-none focus:bg-yellow-50 dark:focus:bg-slate-800"
                    />
                    <button
                        type="submit"
                        disabled={sending || !draft.trim()}
                        className="px-5 bg-yellow-400 text-black border-l-4 border-black font-permanent uppercase text-xs flex items-center gap-2 hover:bg-white transition-colors disabled:opacity-50 disabled:hover:bg-yellow-400"
                    >
                        <Send className="w-4 h-4" /> SEND
                    </button>
                </form>
            </div>
            {error && <p className="mt-2 font-permanent text-xs text-red-500 uppercase">{error}</p>}
        </div>
    );
}
