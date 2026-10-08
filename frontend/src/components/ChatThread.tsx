"use client";

import { useRef, useState } from 'react';
import { Send, WifiOff } from 'lucide-react';
import { threadKeyFor } from '../lib/useThreads';
import { myAccountId, useThread } from '../lib/useThread';
import { useThreadScroll } from '../lib/useThreadScroll';

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
 * History, live updates, send and mark-read all come from useThread, the same
 * hook Table Talk on a campaign page uses. Dark styling to sit inside the dock panel.
 */
export default function ChatThread({ channel, placeholder, onLatestMessage }: {
    channel: ChatChannel;
    placeholder?: string;
    /** Called with the newest message's id whenever it changes while the thread is open (to mark it read). */
    onLatestMessage?: (messageId: string) => void;
}) {
    const [draft, setDraft] = useState('');
    const scrollRef = useRef<HTMLDivElement>(null);
    const myId = myAccountId();

    const threadKey = channel.id ? threadKeyFor(channel.kind, channel.id) : null;
    const thread = useThread(threadKey, {
        markRead: onLatestMessage ? (_key, messageId) => onLatestMessage(messageId) : undefined,
    });
    const { messages } = thread;
    const connected = thread.status === 'open';
    const onScroll = useThreadScroll(scrollRef, messages, { onNearTop: thread.loadOlder, canLoadMore: thread.hasMore });

    const handleSend = (e: React.FormEvent) => {
        e.preventDefault();
        // The message stays in the log (sending, then sent or failed), so the box clears at once.
        if (thread.send(draft)) setDraft('');
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

            <div ref={scrollRef} onScroll={onScroll} className="flex-grow min-h-0 overflow-y-auto space-y-3 border-4 border-black bg-zinc-800 p-3 custom-scrollbar">
                {thread.loadingOlder && (
                    <p className="font-bold text-[10px] text-zinc-500 uppercase text-center">Loading older messages…</p>
                )}
                {messages.length === 0 ? (
                    <p className="font-bold text-xs text-zinc-500 uppercase text-center pt-16">
                        No messages yet. Break the ice.
                    </p>
                ) : messages.map(m => {
                    const mine = m.state !== 'sent' || (myId != null && m.sender.id === myId);
                    const failed = m.state === 'failed';
                    return (
                        <div key={m.key} className={`flex ${mine ? 'justify-end' : 'justify-start'}`}>
                            <div className={`max-w-[85%] p-2 border-2 ${failed ? 'border-red-500 bg-zinc-900 text-white' : `border-black ${mine ? 'bg-teal-500 text-white' : 'bg-zinc-700 text-white'}`} ${m.state === 'sending' ? 'opacity-60' : ''}`}>
                                <div className="flex items-baseline gap-2">
                                    <span className={`font-black text-[10px] uppercase ${mine ? 'text-yellow-300' : 'text-teal-400'}`}>{senderLabel(m.sender)}</span>
                                    <span className={`text-[9px] font-bold ${mine ? 'text-teal-100' : 'text-zinc-400'}`}>
                                        {m.state === 'sending' ? 'SENDING…' : fmtTime(m.createdAt)}
                                    </span>
                                </div>
                                <p className="text-sm whitespace-pre-wrap break-words">{m.body}</p>
                                {failed && (
                                    <div className="mt-1 flex items-center gap-2 text-[10px] font-black uppercase">
                                        <span className="text-red-400">{m.error || 'Not sent'}</span>
                                        <button type="button" onClick={() => thread.resend(m.key)} className="underline text-yellow-300 hover:text-white">Resend</button>
                                        <button type="button" onClick={() => thread.discard(m.key)} className="underline text-zinc-400 hover:text-white">Discard</button>
                                    </div>
                                )}
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
                    disabled={!draft.trim()}
                    className="px-4 bg-yellow-400 text-black border-l-4 border-black font-black uppercase text-xs flex items-center gap-1.5 hover:bg-white transition-colors disabled:opacity-50 disabled:hover:bg-yellow-400"
                >
                    <Send className="w-4 h-4" /> SEND
                </button>
            </form>
            {thread.error && <p className="mt-2 font-bold text-[10px] text-red-500 uppercase">{thread.error}</p>}
        </div>
    );
}
