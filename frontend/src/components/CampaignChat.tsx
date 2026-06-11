"use client";

import { useCallback, useEffect, useRef, useState } from 'react';
import { useEditor, EditorContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { MessageSquare, Send, WifiOff, Bold, Italic, Code, List, ListOrdered } from 'lucide-react';

interface ChatMessage {
    messageId: string;
    sender: { id: string; name: string; email: string };
    body: string;
    createdAt: string;
}

/** Older messages stored the sender's email as the name — show the handle-ish local part instead. */
const senderLabel = (s: { name?: string }) => {
    const n = s?.name || 'UNKNOWN';
    return n.includes('@') ? n.split('@')[0] : n;
};

/** Convert Tiptap's JSON doc to a markdown string. */
function docToMarkdown(doc: any): string {
    if (!doc?.content) return '';
    return doc.content.map((node: any) => nodeToMd(node)).join('\n').trim();
}

function nodeToMd(node: any): string {
    switch (node.type) {
        case 'paragraph':
            return (node.content?.map(inlineToMd).join('') ?? '') + '\n';
        case 'bulletList':
            return node.content?.map((item: any) =>
                '- ' + item.content?.map((n: any) => nodeToMd(n).replace(/\n$/, '')).join('')
            ).join('\n') + '\n';
        case 'orderedList':
            return node.content?.map((item: any, i: number) =>
                `${i + 1}. ` + item.content?.map((n: any) => nodeToMd(n).replace(/\n$/, '')).join('')
            ).join('\n') + '\n';
        case 'codeBlock':
            return '```\n' + (node.content?.[0]?.text ?? '') + '\n```\n';
        case 'blockquote':
            return node.content?.map((n: any) => '> ' + nodeToMd(n).replace(/\n$/, '')).join('\n') + '\n';
        case 'hardBreak':
            return '  \n';
        default:
            return node.content?.map((n: any) => nodeToMd(n)).join('') ?? '';
    }
}

function inlineToMd(node: any): string {
    if (node.type === 'hardBreak') return '  \n';
    const text = node.text ?? '';
    if (!node.marks?.length) return text;
    return node.marks.reduce((acc: string, mark: any) => {
        switch (mark.type) {
            case 'bold': return `**${acc}**`;
            case 'italic': return `*${acc}*`;
            case 'code': return `\`${acc}\``;
            case 'strike': return `~~${acc}~~`;
            default: return acc;
        }
    }, text);
}

const ToolbarBtn = ({
    active, onClick, title, children,
}: { active?: boolean; onClick: () => void; title: string; children: React.ReactNode }) => (
    <button
        type="button"
        title={title}
        onMouseDown={e => { e.preventDefault(); onClick(); }}
        className={`p-1.5 border-2 border-black font-permanent text-xs transition-colors ${active ? 'bg-teal-500 text-white' : 'bg-white dark:bg-slate-700 text-black dark:text-white hover:bg-yellow-400 hover:text-black'}`}
    >
        {children}
    </button>
);

export default function CampaignChat({ campaignId }: { campaignId: string }) {
    const [messages, setMessages] = useState<ChatMessage[]>([]);
    const [sending, setSending] = useState(false);
    const [connected, setConnected] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const scrollRef = useRef<HTMLDivElement>(null);
    const seen = useRef<Set<string>>(new Set());

    const token = () => (typeof window !== 'undefined' ? localStorage.getItem('token') : null);

    const myId = useRef<string | null>(null);
    useEffect(() => {
        try {
            const t = token();
            if (t) myId.current = JSON.parse(atob(t.split('.')[1]))?.id ?? null;
        } catch { /* cosmetic */ }
    }, []);

    const editor = useEditor({
        extensions: [StarterKit],
        editorProps: {
            attributes: {
                class: 'flex-grow p-3 bg-white dark:bg-slate-900 text-black dark:text-white font-permanent text-sm outline-none min-h-[44px] max-h-40 overflow-y-auto focus:bg-yellow-50 dark:focus:bg-slate-800 prose prose-sm dark:prose-invert max-w-none',
            },
            handleKeyDown(view, event) {
                // Submit on Enter, new line on Shift+Enter
                if (event.key === 'Enter' && !event.shiftKey) {
                    event.preventDefault();
                    document.getElementById('chat-send-btn')?.click();
                    return true;
                }
                return false;
            },
        },
    });

    const append = useCallback((msgs: ChatMessage[]) => {
        const fresh = msgs.filter(m => !seen.current.has(m.messageId));
        if (!fresh.length) return;
        fresh.forEach(m => seen.current.add(m.messageId));
        setMessages(prev => [...prev, ...fresh].sort(
            (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
        ));
    }, []);

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
            try { append([JSON.parse(e.data)]); } catch { /* ignore */ }
        });
        es.onerror = () => setConnected(false);

        return () => es.close();
    }, [campaignId, append]);

    useEffect(() => {
        scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
    }, [messages]);

    const handleSend = async (e?: React.FormEvent) => {
        e?.preventDefault();
        if (!editor || sending) return;
        const body = docToMarkdown(editor.getJSON()).trim();
        if (!body) return;
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
            editor.commands.clearContent();
        } catch (err: any) {
            setError(err.message || 'Failed to send');
        } finally {
            setSending(false);
        }
    };

    const fmtTime = (iso: string) =>
        new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }).toUpperCase();

    const isDraftEmpty = !editor || editor.isEmpty;

    return (
        <div>
            <div className="flex items-center justify-between mb-4">
                <h2 className="text-2xl font-permanent text-black dark:text-white uppercase flex items-center gap-2">
                    <MessageSquare className="w-5 h-5 text-teal-500" /> Table Talk
                </h2>
                <span className={`flex items-center gap-1.5 px-2 py-1 border-2 border-black font-permanent text-xs uppercase ${connected ? 'bg-teal-500 text-white' : 'bg-zinc-600 text-zinc-200'}`}>
                    {connected ? 'LIVE' : <><WifiOff className="w-3 h-3" /> OFFLINE</>}
                </span>
            </div>

            <div className="border-4 border-black bg-white dark:bg-slate-800 shadow-[4px_4px_0px_0px_rgba(0,0,0,1)]">
                {/* Message history */}
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
                                    <div className="flex items-baseline gap-2 mb-1">
                                        <span className={`font-permanent text-xs uppercase ${mine ? 'text-yellow-300' : 'text-teal-600 dark:text-yellow-400'}`}>{senderLabel(m.sender)}</span>
                                        <span className={`text-[10px] font-permanent ${mine ? 'text-teal-100' : 'text-zinc-400'}`}>{fmtTime(m.createdAt)}</span>
                                    </div>
                                    <div className="text-sm break-words">
                                        <ReactMarkdown
                                            remarkPlugins={[remarkGfm]}
                                            components={{
                                                p: ({ children }) => <p className="mb-1 last:mb-0 leading-snug">{children}</p>,
                                                strong: ({ children }) => <strong className="font-bold">{children}</strong>,
                                                em: ({ children }) => <em className="italic">{children}</em>,
                                                code: ({ inline, children }: any) => inline
                                                    ? <code className={`px-1 py-0.5 rounded text-xs font-mono border ${mine ? 'bg-teal-600 border-teal-400' : 'bg-zinc-200 dark:bg-zinc-700 border-zinc-300 dark:border-zinc-600'}`}>{children}</code>
                                                    : <code className={`block p-2 my-1 rounded text-xs font-mono whitespace-pre-wrap border ${mine ? 'bg-teal-600 border-teal-400' : 'bg-zinc-200 dark:bg-zinc-700 border-zinc-300 dark:border-zinc-600'}`}>{children}</code>,
                                                pre: ({ children }) => <>{children}</>,
                                                ul: ({ children }) => <ul className="list-disc list-inside my-1 space-y-0.5">{children}</ul>,
                                                ol: ({ children }) => <ol className="list-decimal list-inside my-1 space-y-0.5">{children}</ol>,
                                                li: ({ children }) => <li className="leading-snug">{children}</li>,
                                                blockquote: ({ children }) => <blockquote className={`border-l-2 pl-2 my-1 italic opacity-80 ${mine ? 'border-teal-300' : 'border-zinc-400 dark:border-zinc-500'}`}>{children}</blockquote>,
                                            }}
                                        >{m.body}</ReactMarkdown>
                                    </div>
                                </div>
                            </div>
                        );
                    })}
                </div>

                {/* Formatting toolbar */}
                <div className="flex gap-1 px-3 py-2 border-t-2 border-black/20 dark:border-white/10 bg-zinc-50 dark:bg-slate-900">
                    <ToolbarBtn title="Bold (Ctrl+B)" active={editor?.isActive('bold')} onClick={() => editor?.chain().focus().toggleBold().run()}>
                        <Bold className="w-3.5 h-3.5" />
                    </ToolbarBtn>
                    <ToolbarBtn title="Italic (Ctrl+I)" active={editor?.isActive('italic')} onClick={() => editor?.chain().focus().toggleItalic().run()}>
                        <Italic className="w-3.5 h-3.5" />
                    </ToolbarBtn>
                    <ToolbarBtn title="Inline code" active={editor?.isActive('code')} onClick={() => editor?.chain().focus().toggleCode().run()}>
                        <Code className="w-3.5 h-3.5" />
                    </ToolbarBtn>
                    <ToolbarBtn title="Bullet list" active={editor?.isActive('bulletList')} onClick={() => editor?.chain().focus().toggleBulletList().run()}>
                        <List className="w-3.5 h-3.5" />
                    </ToolbarBtn>
                    <ToolbarBtn title="Ordered list" active={editor?.isActive('orderedList')} onClick={() => editor?.chain().focus().toggleOrderedList().run()}>
                        <ListOrdered className="w-3.5 h-3.5" />
                    </ToolbarBtn>
                    <ToolbarBtn title="Code block" active={editor?.isActive('codeBlock')} onClick={() => editor?.chain().focus().toggleCodeBlock().run()}>
                        <span className="font-mono text-xs leading-none">{'<>'}</span>
                    </ToolbarBtn>
                    <span className="ml-auto font-permanent text-[10px] text-zinc-400 self-center uppercase">Shift+Enter for new line</span>
                </div>

                {/* Editor + send */}
                <form onSubmit={handleSend} className="flex border-t-4 border-black items-end">
                    <div className="flex-grow min-w-0">
                        <EditorContent editor={editor} />
                    </div>
                    <button
                        id="chat-send-btn"
                        type="submit"
                        disabled={sending || isDraftEmpty}
                        className="px-5 py-3 bg-yellow-400 text-black border-l-4 border-black font-permanent uppercase text-xs flex items-center gap-2 hover:bg-white transition-colors disabled:opacity-50 disabled:hover:bg-yellow-400 self-stretch"
                    >
                        <Send className="w-4 h-4" /> SEND
                    </button>
                </form>
            </div>
            {error && <p className="mt-2 font-permanent text-xs text-red-500 uppercase">{error}</p>}
        </div>
    );
}
