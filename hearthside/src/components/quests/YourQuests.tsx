"use client";

import Link from 'next/link';
import GildedPanel from '@/components/design-system/GildedPanel';
import { KIND_TAG, questWhen } from '@/lib/quests';
import { setQuestDone, useYourQuests } from '@/lib/useQuests';

/**
 * Your Quests (#221), in the shell's rail: the design system's QuestList on
 * gilded leather. Your open and done quests for sessions being planned or
 * still to come, soonest first, each ticked off (or back on) in place
 * through the quests API. A done quest stays struck through until its
 * session is over.
 *
 * Each quest links to its session's table (`/sessions/:id#quests`), where the
 * quest bells and reminders also land (#214).
 */
export default function YourQuests() {
  const { status, quests, error, ticking } = useYourQuests();
  if (status === 'idle') return null;
  const open = quests.filter((q) => q.status === 'open').length;
  const now = new Date();

  return (
    <section className="hs-quests-sec" aria-labelledby="hs-quests-h">
      <h2 className="hs-sec" id="hs-quests-h">
        <span>Your Quests</span>
        {status === 'ready' && <span className="hs-aside">{open} open</span>}
      </h2>
      <GildedPanel>
        {status === 'loading' && <p className="hs-panel-note">Unrolling your quests…</p>}
        {status !== 'loading' && quests.length === 0 && !error && (
          <p className="hs-panel-note">No quests. You&rsquo;re set for game night.</p>
        )}
        {quests.length > 0 && (
          <ul className="hs-quests">
            {quests.map((q) => {
              const done = q.status === 'done';
              const tag = KIND_TAG[q.kind];
              return (
                <li key={q.id} className={done ? 'is-done' : undefined}>
                  <button
                    type="button"
                    className="hs-box"
                    role="checkbox"
                    aria-checked={done}
                    aria-label={`${q.title}: ${done ? 'done' : 'mark done'}`}
                    disabled={ticking.has(q.id)}
                    onClick={() => setQuestDone(q.id, !done)}
                  />
                  <div>
                    <div className="hs-quest-name">
                      {q.title}
                      {tag && <span className="hs-tag">{tag}</span>}
                    </div>
                    <div className="hs-quest-time">{questWhen(q, now)}</div>
                    {q.notes && <div className="hs-quest-desc">{q.notes}</div>}
                    <Link className="hs-quest-desc hs-quest-where" href={`/sessions/${q.sessionId}#quests`}>
                      {q.session.title} · {q.session.campaign.title}
                    </Link>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
        {error && <p className="hs-panel-note hs-panel-error" role="alert">{error}</p>}
      </GildedPanel>
    </section>
  );
}
