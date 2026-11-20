"use client";

import Link from 'next/link';
import { useState } from 'react';
import GildedPanel from '@/components/design-system/GildedPanel';
import {
  almanacLists, chronicleWeeks, dayKey, longDayName, phaseOf, placeLine, sameDay, shortDay, weekdayShort,
  type AlmanacSession,
} from '@/lib/almanac';
import AlmanacSheet, { titleOf, type SlipActions } from './AlmanacSheet';
import AlmanacTabs from './AlmanacTabs';

type Which = 'up' | 'played';
const PANEL_ID = 'hs-alm-list-panel';
const TAB_PREFIX = 'hs-alm-list-tab';

const plural = (n: number, unit: string) => `${n} ${unit}${n === 1 ? '' : 's'}`;

/** A played session's row: its night, name, campaign, place and how its quests went. */
function PlayedRow({ s }: { s: AlmanacSession }) {
  const done = s.quests.filter((q) => q.status === 'done').length;
  const bits = [s.campaign.title, placeLine(s), s.quests.length ? `${done} of ${plural(s.quests.length, 'quest')} done` : ''].filter(Boolean);
  return (
    <li>
      <Link className="hs-alm-prow" href={`/sessions/${encodeURIComponent(s.id)}`}>
        <time dateTime={s.date}>{shortDay(new Date(s.date))}</time>
        <span className="hs-alm-prow-t"><b>{titleOf(s)}</b><small>{bits.join(' · ')}</small></span>
      </Link>
    </li>
  );
}

/**
 * The Almanac as a list (layout B, "Chronicle"; the page opens on it): Coming
 * up and Played tabs. Coming up runs week by week, each day's date set large
 * on the floor beside its sessions' parchment sheets, with the viewer's quests
 * on them. Played lists the sessions that are over, latest first.
 */
export default function ChronicleList({ sessions, filtered, slips }: {
  /** Already filtered. */
  sessions: readonly AlmanacSession[];
  /** Whether a filter is on, for the empty notes. */
  filtered: boolean;
  slips: SlipActions;
}) {
  const [which, setWhich] = useState<Which>('up');
  const { now } = slips;
  const { comingUp, played } = almanacLists(sessions, now);
  const weeks = chronicleWeeks(comingUp, now);

  return (
    <>
      <GildedPanel className="hs-alm-strip">
        <AlmanacTabs
          label="Which sessions"
          tabs={[{ id: 'up', label: 'Coming up', count: comingUp.length }, { id: 'played', label: 'Played', count: played.length }]}
          value={which}
          onChange={setWhich}
          panelId={PANEL_ID}
          idPrefix={TAB_PREFIX}
        />
      </GildedPanel>

      <div role="tabpanel" id={PANEL_ID} aria-labelledby={`${TAB_PREFIX}-${which}`} className="hs-alm-list">
        {which === 'played' ? (
          played.length ? (
            <GildedPanel>
              <ul className="hs-alm-played" aria-label="Played sessions">{played.map((s) => <PlayedRow key={s.id} s={s} />)}</ul>
            </GildedPanel>
          ) : (
            <p className="hs-note">{filtered ? 'No played sessions match these filters.' : 'Nothing played yet.'}</p>
          )
        ) : weeks.length ? (
          weeks.map((w) => {
            const headId = `hs-alm-week-${dayKey(w.monday)}`;
            return (
              <section key={headId} className="hs-alm-week" aria-labelledby={headId}>
                <h2 className="hs-alm-week-h" id={headId}>{w.label}</h2>
                {w.days.map((d) => (
                  <div key={dayKey(d.day)} className="hs-alm-entry">
                    <div className={sameDay(d.day, now) ? 'hs-alm-leaf is-today' : 'hs-alm-leaf'}>
                      <b aria-hidden="true">{d.day.getDate()}</b>
                      <span aria-hidden="true">{weekdayShort(d.day)}</span>
                      <span className="hs-sr-only">{longDayName(d.day)}</span>
                    </div>
                    <div className="hs-alm-day">
                      {d.sessions.map((s) => phaseOf(s, now) === 'cancelled' ? (
                        <GildedPanel key={s.id} className="hs-alm-off">
                          <b>{titleOf(s)}</b>
                          <span>{s.campaign.title} · Cancelled</span>
                        </GildedPanel>
                      ) : (
                        <AlmanacSheet key={s.id} session={s} slips={slips} />
                      ))}
                    </div>
                  </div>
                ))}
              </section>
            );
          })
        ) : (
          <p className="hs-note">
            {filtered ? 'No sessions coming up match these filters.' : 'Nothing coming up. When a session gets a night, it shows here.'}
          </p>
        )}
      </div>
    </>
  );
}
