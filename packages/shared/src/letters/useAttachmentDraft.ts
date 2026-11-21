import { useCallback, useRef, useState } from 'react';
import { MAX_ATTACHMENTS_PER_MESSAGE, attachmentProblem } from './attachments';

/**
 * Attachments picked for the next message (#104), headless: each file is
 * checked as it's picked (type, size, at most 10 a message), so a bad one
 * never reaches an upload. Wire `inputRef` to a hidden file input and call
 * `open()` from the composer's attach button; `send(body, draft.files)` then
 * `clear()`.
 */
export function useAttachmentDraft() {
    const [files, setFiles] = useState<File[]>([]);
    const [error, setError] = useState<string | null>(null);
    const inputRef = useRef<HTMLInputElement>(null);
    const filesRef = useRef(files);
    filesRef.current = files;

    const add = useCallback((picked: FileList | File[] | null) => {
        const list = Array.from(picked ?? []);
        if (inputRef.current) inputRef.current.value = ''; // picking the same file again still fires
        if (!list.length) return;
        const problems = list.map(attachmentProblem).filter((p): p is string => !!p);
        const ok = list.filter((f) => !attachmentProblem(f));
        const room = Math.max(MAX_ATTACHMENTS_PER_MESSAGE - filesRef.current.length, 0);
        if (ok.length > room) problems.push(`A message can have at most ${MAX_ATTACHMENTS_PER_MESSAGE} attachments.`);
        setError(problems.length ? problems.join(' ') : null);
        if (ok.length && room) setFiles((prev) => [...prev, ...ok.slice(0, room)]);
    }, []);

    const remove = useCallback((index: number) => {
        setFiles((prev) => prev.filter((_, i) => i !== index));
        setError(null);
    }, []);

    const clear = useCallback(() => { setFiles([]); setError(null); }, []);

    return { files, error, add, remove, clear, inputRef, open: () => inputRef.current?.click() };
}

/** The draft `useAttachmentDraft` returns: what a composer's attach button and chips work on. */
export type AttachmentDraft = ReturnType<typeof useAttachmentDraft>;
