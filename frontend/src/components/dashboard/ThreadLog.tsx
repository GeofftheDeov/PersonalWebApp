"use client";

import { useRef, useState, type FormEvent } from 'react';
import { ArrowLeft, ExternalLink, MessageSquare, Send, WifiOff } from 'lucide-react';
import { messageWhen } from '@gtd/shared/letters';
import { MessageBody, MESSAGE_BODY_TW } from '@gtd/shared/letters/react';
import { AttachButton, DraftAttachments, MessageAttachments } from '@gtd/shared/topbar';
import { letters, useAttachmentDraft, useThread, useThreadScroll, useTyping, type ThreadEntry, type ThreadSummary } from '@/lib/letters';
import { campaignHref } from '@/lib/hearthside';
import { useSession } from '@/lib/session';

/** Older messages stored the sender's email as the name: show its name part. */
const senderLabel = (sender: { name?: string }) => {
    const name = sender?.name?.trim() || 'Someone';
    return name.includes('@') ? name.split('@')[0] : name;
};

/** The right-hand column before a chat is picked. */
export function NoThread() {
    return (
        <div className="flex flex-col items-center justify-center gap-4 p-8 min-h-[20rem] text-center border-4 border-black dark:border-white bg-zinc-200 dark:bg-slate-800 shadow-[6px_6px_0px_0px_rgba(0,0,0,1)]">
            <span className="p-3 bg-yellow-400 border-4 border-black shadow-[4px_4px_0px_0px_rgba(0,0,0,1)]" aria-hidden="true">
                <MessageSquare className="w-8 h-8 text-black" />
            </span>
            <p className="text-2xl font-permanent uppercase text-teal-600 dark:text-yellow-400">Pick a chat</p>
            <p className="max-w-xs text-sm font-medium tracking-wider uppercase text-zinc-500 dark:text-zinc-400">
                Choose a campaign or a friend under your profile to read and reply here.
            </p>
        </div>
    );
}

/**
 * One open chat in the dashboard's right-hand column (#233): its head (with
 * "Open in Hearthside" for a campaign), the log (newest at the bottom, older
 * messages loading as you scroll up), who's writing, and the compose bar
 * with attachments. Everything it does is the shared Letters hooks'
 * (useThread, useThreadScroll, useTyping, useAttachmentDraft), drawn in the
 * portfolio's look; mount it with a `key` per thread.
 */
export default function ThreadLog({ thread: summary, markRead, onBack }: {
    thread: ThreadSummary;
    /** useThreads' markRead, so the list's unread count clears at once. */
    markRead: (threadKey: string, messageId: string) => void;
    /** Back to the list: the control only shows at phone width, where the list and the log take turns. */
    onBack: () => void;
}) {
    const myId = useSession().user?.id ?? null;
    const threadKey = letters.threadKeyFor(summary.kind, summary.targetId);
    const { label: writing, typing, sent } = useTyping(threadKey);
    const thread = useThread(threadKey, { markRead, onSent: sent });
    const logRef = useRef<HTMLDivElement>(null);
    const onScroll = useThreadScroll(logRef, thread.messages, { onNearTop: thread.loadOlder, canLoadMore: thread.hasMore });
    const draft = useAttachmentDraft();
    const [text, setText] = useState('');
    const live = thread.status === 'open';

    const submit = (e: FormEvent) => {
        e.preventDefault();
        // The message shows in the log at once (sending, then sent or failed), so the box clears now.
        if (thread.send(text, draft.files)) {
            setText('');
            draft.clear();
        }
    };

    return (
        <div className="flex flex-col border-4 border-black dark:border-white bg-zinc-200 dark:bg-slate-800 shadow-[6px_6px_0px_0px_rgba(0,0,0,1)]">
            <div className="flex items-center gap-3 p-3 border-b-4 border-black dark:border-white">
                <button
                    type="button"
                    onClick={onBack}
                    aria-label="Back to chats"
                    className="md:hidden shrink-0 p-2 bg-yellow-400 text-black border-4 border-black shadow-[3px_3px_0px_0px_rgba(0,0,0,1)] hover:bg-white transition-colors"
                >
                    <ArrowLeft className="w-4 h-4" />
                </button>
                <span aria-hidden="true" className={`w-10 h-10 shrink-0 flex items-center justify-center border-2 border-black font-permanent text-sm uppercase ${summary.kind === 'campaign' ? 'bg-teal-600 text-white' : 'bg-yellow-400 text-black'}`}>
                    {summary.avatarHint}
                </span>
                <div className="flex-1 min-w-0">
                    <h3 className="font-permanent text-lg uppercase truncate text-teal-600 dark:text-yellow-400">{summary.title}</h3>
                    <p className="text-xs font-medium tracking-wider uppercase truncate text-zinc-500 dark:text-zinc-400">{summary.subtitle}</p>
                </div>
                <span className={`shrink-0 flex items-center gap-1.5 px-2 py-1 border-2 border-black font-permanent text-xs uppercase ${live ? 'bg-teal-500 text-white' : 'bg-zinc-600 text-zinc-200'}`}>
                    {live ? 'Live' : <><WifiOff className="w-3 h-3" aria-hidden="true" /> Offline</>}
                </span>
            </div>

            {/* Hearthside's campaign page, or the portfolio's own while Hearthside isn't configured */}
            {summary.kind === 'campaign' && (
                <div className="flex justify-end px-3 py-2 border-b-4 border-black dark:border-white">
                    <a
                        href={campaignHref(summary.targetId)}
                        className="inline-flex items-center gap-2 px-3 py-1.5 bg-yellow-400 text-black border-4 border-black font-permanent text-xs uppercase shadow-[3px_3px_0px_0px_rgba(0,0,0,1)] hover:bg-white transition-colors"
                    >
                        Open in Hearthside <ExternalLink className="w-3.5 h-3.5" aria-hidden="true" />
                    </a>
                </div>
            )}

            <div
                ref={logRef}
                onScroll={onScroll}
                role="log"
                aria-label={`Messages with ${summary.title}`}
                className="h-[26rem] overflow-y-auto p-4 space-y-3 bg-white dark:bg-slate-900"
            >
                {thread.loadingOlder && (
                    <p className="font-permanent text-xs uppercase text-center text-zinc-400">Loading older messages…</p>
                )}
                {thread.messages.length === 0 && (
                    <p className="pt-24 font-permanent text-sm uppercase text-center text-zinc-400">
                        {thread.loading ? 'Loading messages…'
                            : summary.kind === 'campaign' ? 'No messages yet. Say hello to the party.' : `No messages with ${summary.title} yet.`}
                    </p>
                )}
                {thread.messages.map(m => (
                    <Message key={m.key} entry={m} myId={myId}
                        onResend={() => thread.resend(m.key)} onDiscard={() => thread.discard(m.key)} />
                ))}
            </div>

            {/* Who else is writing; a fixed height, so the compose bar doesn't jump */}
            <p aria-live="polite" className="h-7 px-4 py-1 border-t-4 border-black dark:border-white font-permanent text-xs italic truncate text-zinc-500 dark:text-zinc-400">
                {writing}
            </p>

            {(draft.files.length > 0 || draft.error) && (
                <div className="border-t-2 border-black/20 dark:border-white/20 bg-white dark:bg-slate-900">
                    <DraftAttachments draft={draft} />
                </div>
            )}
            <form onSubmit={submit} className="flex border-t-4 border-black dark:border-white">
                <AttachButton draft={draft} className="px-3 bg-zinc-50 dark:bg-slate-800 text-black dark:text-white border-r-4 border-black dark:border-white hover:bg-yellow-400 hover:text-black transition-colors" />
                <input
                    value={text}
                    onChange={e => { setText(e.target.value); if (e.target.value.trim()) typing(); }}
                    aria-label="Write a message"
                    placeholder={summary.kind === 'campaign' ? 'WRITE TO THE PARTY…' : `WRITE TO ${summary.title.toUpperCase()}…`}
                    maxLength={4000}
                    className="flex-grow min-w-0 p-3 bg-white dark:bg-black text-black dark:text-white font-permanent text-sm outline-none placeholder-zinc-400 focus:bg-yellow-50 dark:focus:bg-slate-900"
                />
                <button
                    type="submit"
                    disabled={!text.trim() && !draft.files.length}
                    className="shrink-0 px-4 bg-yellow-400 text-black border-l-4 border-black dark:border-white font-permanent uppercase text-sm flex items-center gap-2 hover:bg-white transition-colors disabled:opacity-50 disabled:hover:bg-yellow-400"
                >
                    <Send className="w-4 h-4" aria-hidden="true" /> Send
                </button>
            </form>
            {thread.error && <p role="alert" className="px-4 py-2 border-t-4 border-black dark:border-white font-permanent text-xs uppercase text-red-600 dark:text-red-400">{thread.error}</p>}
        </div>
    );
}

/** One message: yours on the right in teal, others' on the left. */
function Message({ entry: m, myId, onResend, onDiscard }: {
    entry: ThreadEntry;
    myId: string | null;
    onResend: () => void;
    onDiscard: () => void;
}) {
    const mine = m.state !== 'sent' || (myId !== null && m.sender.id === myId);
    const failed = m.state === 'failed';
    const bubble = failed
        ? 'border-red-500 bg-red-50 dark:bg-slate-900 text-black dark:text-white'
        : mine ? 'border-black bg-teal-500 text-white' : 'border-black bg-yellow-50 dark:bg-slate-700 text-black dark:text-white';
    return (
        <div className={`flex ${mine ? 'justify-end' : 'justify-start'}`}>
            <div className={`max-w-[85%] min-w-0 p-2.5 border-2 shadow-[3px_3px_0px_0px_rgba(0,0,0,1)] ${bubble} ${m.state === 'sending' ? 'opacity-60' : ''}`}>
                <div className="flex items-baseline gap-2 mb-1">
                    <span className={`font-permanent text-xs uppercase ${failed ? 'text-red-600 dark:text-red-400' : mine ? 'text-yellow-300' : 'text-teal-600 dark:text-yellow-400'}`}>
                        {mine ? 'You' : senderLabel(m.sender)}
                    </span>
                    <span className={`text-[10px] font-permanent uppercase ${mine && !failed ? 'text-teal-100' : 'text-zinc-400'}`}>
                        {m.state === 'sending' ? 'Sending…' : messageWhen(m.createdAt)}
                    </span>
                </div>
                {m.body && <MessageBody body={m.body} className={MESSAGE_BODY_TW} />}
                <MessageAttachments attachments={m.attachments} files={m.state === 'sent' ? undefined : m.files} />
                {failed && (
                    <div className="mt-1 flex items-center gap-2 font-permanent text-[10px] uppercase">
                        <span className="text-red-600 dark:text-red-400">{m.error || 'Not sent'}</span>
                        <button type="button" onClick={onResend} className="underline text-teal-600 dark:text-yellow-400 hover:text-black dark:hover:text-white">Resend</button>
                        <button type="button" onClick={onDiscard} className="underline text-zinc-500 hover:text-black dark:hover:text-white">Discard</button>
                    </div>
                )}
            </div>
        </div>
    );
}
