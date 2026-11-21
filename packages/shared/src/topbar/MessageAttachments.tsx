"use client";

import { FileText, ImageOff, Paperclip, X } from 'lucide-react';
import type { MessageAttachment } from '../realtime/liveClient';
import { ATTACHMENT_ACCEPT, formatBytes, isImageType } from '../letters/attachments';
import type { AttachmentDraft } from '../letters/useAttachmentDraft';

/**
 * Letters attachments (#104) in the log and in the composer, in the
 * portfolio's look: Table Talk (light) and the dock (dark). The picking
 * itself is the headless `useAttachmentDraft` (@gtd/shared/letters/react).
 *
 *   <MessageAttachments attachments={m.attachments} files={m.files} />   in a message bubble
 *   const draft = useAttachmentDraft();                                  in a composer
 *   <AttachButton draft={draft} />  <DraftAttachments draft={draft} />
 */

type Tone = 'light' | 'dark';

/** Stored attachments (images as previews, PDFs as named links), or your unsent files by name. */
export function MessageAttachments({ attachments, files, tone = 'light' }: {
    attachments?: MessageAttachment[];
    files?: File[];
    tone?: Tone;
}) {
    if (!attachments?.length && !files?.length) return null;
    const linkCls = tone === 'dark' ? 'border-black bg-zinc-900 text-white hover:bg-black' : 'border-black bg-white text-black hover:bg-yellow-100 dark:bg-slate-900 dark:text-white';
    return (
        <div className="mt-1.5 flex flex-col gap-1.5">
            {attachments?.map((a) => {
                if (isImageType(a.contentType) && a.url) {
                    return (
                        <a key={a.key} href={a.url} target="_blank" rel="noopener noreferrer" title={a.name} className="block">
                            <img
                                src={a.url}
                                alt={a.name}
                                width={a.width}
                                height={a.height}
                                loading="lazy"
                                className="block max-h-60 max-w-full w-auto h-auto border-2 border-black bg-zinc-200"
                            />
                        </a>
                    );
                }
                if (!a.url) {
                    return (
                        <span key={a.key} className={`inline-flex items-center gap-1.5 px-2 py-1 border-2 text-xs opacity-70 ${linkCls}`}>
                            <ImageOff className="w-3.5 h-3.5 shrink-0" /> {a.name} (unavailable)
                        </span>
                    );
                }
                return (
                    <a key={a.key} href={a.url} target="_blank" rel="noopener noreferrer"
                        className={`inline-flex items-center gap-1.5 px-2 py-1 border-2 text-xs font-bold underline-offset-2 hover:underline ${linkCls}`}>
                        <FileText className="w-4 h-4 shrink-0" />
                        <span className="truncate">{a.name}</span>
                        <span className="shrink-0 opacity-60">{formatBytes(a.size)}</span>
                    </a>
                );
            })}
            {files?.map((f, i) => (
                <span key={`${f.name}-${i}`} className={`inline-flex items-center gap-1.5 px-2 py-1 border-2 text-xs ${linkCls}`}>
                    {isImageType(f.type) ? <Paperclip className="w-3.5 h-3.5 shrink-0" /> : <FileText className="w-3.5 h-3.5 shrink-0" />}
                    <span className="truncate">{f.name}</span>
                    <span className="shrink-0 opacity-60">{formatBytes(f.size)}</span>
                </span>
            ))}
        </div>
    );
}

/** The paperclip button and its hidden file input. */
export function AttachButton({ draft, className }: { draft: AttachmentDraft; className?: string }) {
    return (
        <>
            <input
                ref={draft.inputRef}
                type="file"
                multiple
                accept={ATTACHMENT_ACCEPT}
                className="hidden"
                onChange={(e) => draft.add(e.target.files)}
            />
            <button type="button" title="Attach an image or PDF (10 MB max)" aria-label="Attach a file"
                onClick={draft.open} className={className}>
                <Paperclip className="w-4 h-4" />
            </button>
        </>
    );
}

/** Picked files as removable chips, plus why any were refused. */
export function DraftAttachments({ draft, tone = 'light' }: { draft: AttachmentDraft; tone?: Tone }) {
    if (!draft.files.length && !draft.error) return null;
    const chip = tone === 'dark' ? 'bg-zinc-900 text-white border-black' : 'bg-yellow-50 dark:bg-slate-800 text-black dark:text-white border-black';
    return (
        <div className="flex flex-wrap items-center gap-1.5 px-2 py-1.5">
            {draft.files.map((f, i) => (
                <span key={`${f.name}-${i}`} className={`inline-flex max-w-full items-center gap-1 px-1.5 py-0.5 border-2 text-[11px] font-bold ${chip}`}>
                    <span className="truncate max-w-[12rem]">{f.name}</span>
                    <span className="opacity-60">{formatBytes(f.size)}</span>
                    <button type="button" aria-label={`Remove ${f.name}`} onClick={() => draft.remove(i)} className="hover:text-red-500">
                        <X className="w-3 h-3" />
                    </button>
                </span>
            ))}
            {draft.error && <span role="alert" className="text-[11px] font-bold text-red-500">{draft.error}</span>}
        </div>
    );
}
