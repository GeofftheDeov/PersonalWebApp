"use client";

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ATTACHMENT_ACCEPT, formatBytes, isImageType } from '@gtd/shared/letters';
import { letters, useAttachmentDraft, useThread, useThreadScroll, useTyping } from '@/lib/letters';
import { messageWhen, senderLabel } from '@/lib/lettersFormat';
import { useSession } from '@/lib/session';
import type { ThreadEntry } from '@gtd/shared/letters';
import type { OpenLetter } from './LettersProvider';

const LIVE_LABEL: Record<string, string> = { open: 'Live', connecting: 'Connecting', idle: 'Connecting' };

/**
 * One open thread in Letters (#221): its head, the log (newest at the bottom,
 * older letters loading as you scroll up), who's writing, and the compose bar
 * with attachments. Everything it does is the shared hooks' (useThread,
 * useThreadScroll, useTyping, useAttachmentDraft); this only draws them in
 * the design system's Letters markup.
 */
export default function LetterThread({ letter, markRead, onBack, summoned }: {
  letter: OpenLetter;
  /** useThreads' markRead, so the list's count clears at once. */
  markRead: (threadKey: string, messageId: string) => void;
  onBack: () => void;
  /** Changes when a page asked for this thread: the compose box takes focus. */
  summoned: number;
}) {
  const myId = useSession().user?.id ?? null;
  const threadKey = letters.threadKeyFor(letter.kind, letter.id);
  const { label: writing, typing, sent } = useTyping(threadKey);
  const thread = useThread(threadKey, { markRead, onSent: sent });
  const logRef = useRef<HTMLDivElement>(null);
  const onScroll = useThreadScroll(logRef, thread.messages, { onNearTop: thread.loadOlder, canLoadMore: thread.hasMore });
  const draft = useAttachmentDraft();
  const [text, setText] = useState('');
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => { if (summoned) input.current?.focus({ preventScroll: true }); }, [summoned]);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    // The letter shows in the log at once (sending, then sent or failed), so the box clears now.
    if (thread.send(text, draft.files)) {
      setText('');
      draft.clear();
    }
  };

  const live = LIVE_LABEL[thread.status] ?? 'Offline';

  return (
    <>
      <div className="hs-convo-head">
        <button type="button" className="hs-back" aria-label="Back to your letters" onClick={onBack}>←</button>
        <span className={letter.kind === 'campaign' ? 'hs-avatar is-campaign' : 'hs-avatar'} aria-hidden="true">
          {letter.avatarHint}
        </span>
        <div className="hs-thread-text">
          <h3 className="hs-thread-name">{letter.title}</h3>
          <div className="hs-thread-sub">{letter.subtitle}</div>
        </div>
        <span className={live === 'Live' ? 'hs-live' : 'hs-live is-off'}>{live}</span>
      </div>

      <div className="hs-convo" ref={logRef} onScroll={onScroll} aria-label={`Letters with ${letter.title}`} role="log">
        {thread.loadingOlder && <p className="hs-convo-note">Fetching older letters…</p>}
        {thread.loading && thread.messages.length === 0 && <p className="hs-convo-note">Unsealing the letters…</p>}
        {!thread.loading && thread.messages.length === 0 && (
          <p className="hs-convo-note">
            {letter.kind === 'campaign' ? 'Nobody has written to the party yet.' : `No letters with ${letter.title} yet.`}
          </p>
        )}
        {thread.messages.map((m) => (
          <Letter key={m.key} entry={m} myId={myId}
            onResend={() => thread.resend(m.key)} onDiscard={() => thread.discard(m.key)} />
        ))}
        {writing && (
          <div className="hs-typing">{writing.replace(/…$/, '')}<i /><i /><i /></div>
        )}
      </div>

      {(draft.files.length > 0 || draft.error) && (
        <div className="hs-draft">
          {draft.files.map((f, i) => (
            <span key={`${f.name}-${i}`} className="hs-draft-file">
              <span className="hs-att-name">{f.name}</span>
              <small>{formatBytes(f.size)}</small>
              <button type="button" aria-label={`Remove ${f.name}`} onClick={() => draft.remove(i)}>×</button>
            </span>
          ))}
          {draft.error && <span className="hs-letters-error" role="alert">{draft.error}</span>}
        </div>
      )}
      <form className="hs-compose" onSubmit={submit}>
        <input ref={draft.inputRef} type="file" multiple accept={ATTACHMENT_ACCEPT} hidden
          onChange={(e) => draft.add(e.target.files)} />
        <button type="button" className="hs-attach" aria-label="Attach a file"
          title="Attach an image or PDF (10 MB at most)" onClick={draft.open}>+</button>
        <input
          ref={input}
          value={text}
          onChange={(e) => { setText(e.target.value); if (e.target.value.trim()) typing(); }}
          aria-label="Write a letter"
          placeholder={letter.kind === 'campaign' ? 'Write to the party…' : `Write to ${letter.title}…`}
          maxLength={4000}
        />
        <button type="submit" className="hs-btn-amber" disabled={!text.trim() && !draft.files.length}>Send</button>
      </form>
      {thread.error && <p className="hs-panel-note hs-panel-error" role="alert">{thread.error}</p>}
    </>
  );
}

/** One letter in the log: yours on the right in amber, others' on the left. */
function Letter({ entry: m, myId, onResend, onDiscard }: {
  entry: ThreadEntry;
  myId: string | null;
  onResend: () => void;
  onDiscard: () => void;
}) {
  const mine = m.state !== 'sent' || (myId !== null && m.sender.id === myId);
  const cls = ['hs-msg', mine && 'is-me', m.state === 'sending' && 'is-sending', m.state === 'failed' && 'is-failed']
    .filter(Boolean).join(' ');
  return (
    <div className={cls}>
      <span className="hs-msg-by">
        {mine ? 'You' : senderLabel(m.sender, myId)}
        <span className="hs-msg-time">{m.state === 'sending' ? 'sending…' : messageWhen(m.createdAt)}</span>
      </span>
      {m.body && <p className="hs-msg-body">{m.body}</p>}
      {m.attachments?.map((a) => {
        if (!a.url) return <span key={a.key} className="hs-att">{a.name} (unavailable)</span>;
        if (isImageType(a.contentType)) {
          return (
            <a key={a.key} className="hs-att-img" href={a.url} target="_blank" rel="noopener noreferrer" title={a.name}>
              <img src={a.url} alt={a.name} width={a.width} height={a.height} loading="lazy" />
            </a>
          );
        }
        return (
          <a key={a.key} className="hs-att" href={a.url} target="_blank" rel="noopener noreferrer">
            <span className="hs-att-icon" aria-hidden="true" />
            <span className="hs-att-name">{a.name}</span>
            <small>{formatBytes(a.size)}</small>
          </a>
        );
      })}
      {m.state !== 'sent' && m.files?.map((f, i) => (
        <span key={`${f.name}-${i}`} className="hs-att">
          <span className="hs-att-icon" aria-hidden="true" />
          <span className="hs-att-name">{f.name}</span>
          <small>{formatBytes(f.size)}</small>
        </span>
      ))}
      {m.state === 'failed' && (
        <span className="hs-msg-failed">
          {m.error || 'Not sent'}
          <button type="button" onClick={onResend}>Resend</button>
          <button type="button" onClick={onDiscard}>Discard</button>
        </span>
      )}
    </div>
  );
}
