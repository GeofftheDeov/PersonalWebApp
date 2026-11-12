"use client";

import { useEffect, useRef, useState } from 'react';
import GildedPanel from '@/components/design-system/GildedPanel';
import { useThreads, type ThreadFilter, type ThreadSummary } from '@/lib/letters';
import { threadWhen } from '@/lib/lettersFormat';
import { useSession } from '@/lib/session';
import LetterThread from './LetterThread';
import { useLetters, type OpenLetter } from './LettersProvider';

const FILTERS: { value: ThreadFilter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'campaigns', label: 'Campaigns' },
  { value: 'friends', label: 'Friends' },
];

const letterOf = (t: ThreadSummary): OpenLetter => ({
  kind: t.kind, id: t.targetId, title: t.title, subtitle: t.subtitle, avatarHint: t.avatarHint,
});

/**
 * Letters (#221), the shell's right-hand column on every shell page: the
 * design system's Letters on gilded leather. The thread list (campaign Table
 * Talk and friend DMs, with All, Campaigns and Friends tabs and unread
 * marks), and in its place the open thread (LetterThread). Live throughout,
 * entirely on the shared hooks the portfolio uses. Which thread is open lives
 * in LettersProvider, so a page can open one (`useLetters().openDm`).
 */
export default function Letters() {
  const signedIn = useSession().status === 'signedIn';
  const control = useLetters();
  const { open, summoned } = control;
  const [filter, setFilter] = useState<ThreadFilter>('all');
  const { threads, totalUnread, loading, error, markRead } = useThreads({ filter, enabled: signedIn });
  const heading = useRef<HTMLHeadingElement>(null);
  // The list starts empty and not loading, before its first fetch: don't call that "no letters".
  const [fetched, setFetched] = useState(false);
  useEffect(() => { if (loading) setFetched(true); }, [loading]);
  const settled = fetched && !loading;

  // A page opened a thread: bring Letters into view (on a phone it's at the foot of the page).
  useEffect(() => {
    if (summoned) heading.current?.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }, [summoned]);

  if (!signedIn) return null;

  return (
    <>
      <h2 className="hs-sec" id="hs-letters-h" ref={heading}>
        <span>Letters</span>
        {totalUnread > 0 && <span className="hs-aside">{totalUnread} unread</span>}
      </h2>
      <GildedPanel className="hs-letters">
        {open ? (
          <LetterThread
            key={`${open.kind}:${open.id}`}
            letter={open}
            markRead={markRead}
            onBack={control.close}
          />
        ) : (
          <>
            <div className="hs-tabs" role="tablist" aria-label="Show letters from">
              {FILTERS.map((f) => (
                <button key={f.value} type="button" role="tab" aria-selected={filter === f.value}
                  aria-controls="hs-threads" onClick={() => setFilter(f.value)}>
                  {f.label}
                </button>
              ))}
            </div>
            <ul className="hs-threads" id="hs-threads">
              {threads.map((t) => (
                <li key={t.threadKey}>
                  <button type="button" className="hs-thread-row" onClick={() => control.show(letterOf(t))}>
                    <span className={t.kind === 'campaign' ? 'hs-avatar is-campaign' : 'hs-avatar'} aria-hidden="true">
                      {t.avatarHint}
                    </span>
                    <span className="hs-thread-text">
                      <span className="hs-thread-name">{t.title}</span>
                      <span className="hs-thread-sub">{t.subtitle}</span>
                    </span>
                    <span className="hs-thread-when">
                      {threadWhen(t.lastActivityAt)}
                      {t.unreadCount > 0 && (
                        <>
                          <span className="hs-dot" aria-hidden="true" />
                          <span className="hs-sr-only">, {t.unreadCount} unread</span>
                        </>
                      )}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
            {threads.length === 0 && settled && !error && (
              <p className="hs-panel-note">
                {filter === 'friends'
                  ? 'No letters from friends yet.'
                  : filter === 'campaigns' ? 'No campaigns under way.' : 'No letters yet. Your campaigns’ Table Talk and your friends’ letters land here.'}
              </p>
            )}
            {threads.length === 0 && !settled && !error && <p className="hs-panel-note">Fetching your letters…</p>}
            {error && <p className="hs-panel-note hs-panel-error" role="alert">{error}</p>}
          </>
        )}
      </GildedPanel>
    </>
  );
}
