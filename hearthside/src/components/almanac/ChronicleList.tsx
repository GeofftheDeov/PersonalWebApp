"use client";

import Link from 'next/link';
import { useEffect, useId, useState } from 'react';
import GildedPanel from '@/components/design-system/GildedPanel';
import {
  DEFAULT_PAGE_SIZE, PAGE_SIZES, almanacLists, chronicleWeeks, dayKey, isPageSize, longDayName, pageAfterResize, phaseOf,
  placeLine, playedPage, reached, sameDay, shortDay, weekdayShort,
  type AlmanacSession,
} from '@/lib/almanac';
import type { OlderState } from '@/lib/useAlmanac';
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
 * Played, a page at a time (#252), latest first: the range shown and a page
 * size dropdown at its head, Previous and Next at its foot. Older sessions
 * are read as the pages need them (`loadOlder`), until there are no more.
 */
function PlayedPages({ played, filtered, filterKey, older, loadOlder }: {
  /** Already filtered and reached, latest first. */
  played: readonly AlmanacSession[];
  filtered: boolean;
  filterKey: string;
  older: OlderState;
  loadOlder: () => void;
}) {
  const sizeId = useId();
  const [size, setSize] = useState<number>(DEFAULT_PAGE_SIZE);
  const [page, setPage] = useState(0);
  // A new filter starts again from the first page.
  const [pagedFor, setPagedFor] = useState(filterKey);
  if (pagedFor !== filterKey) {
    setPagedFor(filterKey);
    setPage(0);
  }
  const more = older.reach !== null;
  const p = playedPage(played, page, size, more);
  // Read further back until this page is full and it's known whether there's a next.
  useEffect(() => {
    if (p.short && !older.loading && !older.error) loadOlder();
  }, [p.short, older.loading, older.error, loadOlder]);

  const resize = (to: number) => {
    if (!isPageSize(to)) return;
    setPage(pageAfterResize(p.page, size, to));
    setSize(to);
  };

  if (!p.rows.length && !p.short && !older.error) {
    return <p className="hs-note">{filtered ? 'No played sessions match these filters.' : 'Nothing played yet.'}</p>;
  }
  return (
    <GildedPanel className="hs-alm-pl">
      <div className="hs-alm-pl-head">
        <p className="hs-alm-pl-range" role="status">
          {p.rows.length ? `Sessions ${p.range}` : older.error ? '' : 'Reading older sessions…'}
        </p>
        <label className="hs-alm-pl-size" htmlFor={sizeId}>Per page</label>
        <select id={sizeId} className="hs-alm-pl-select" value={size} onChange={(e) => resize(Number(e.target.value))}>
          {PAGE_SIZES.map((n) => <option key={n} value={n}>{n}</option>)}
        </select>
      </div>
      {p.rows.length > 0 && (
        <ul className="hs-alm-played" aria-label="Played sessions">{p.rows.map((s) => <PlayedRow key={s.id} s={s} />)}</ul>
      )}
      {older.error && (
        <p className="hs-alert hs-alm-error hs-alm-pl-err" role="alert">
          {older.error} <button type="button" className="hs-alm-link" onClick={loadOlder}>Try again</button>
        </p>
      )}
      <nav className="hs-alm-pager" aria-label="Played pages">
        <button type="button" className="hs-alm-nav" aria-label="Previous page" disabled={!p.hasPrev} onClick={() => setPage(p.page - 1)}>‹ Previous</button>
        <span className="hs-alm-pager-n">Page {p.page + 1}</span>
        <button type="button" className="hs-alm-nav" aria-label="Next page" disabled={!p.hasNext} onClick={() => setPage(p.page + 1)}>Next ›</button>
      </nav>
    </GildedPanel>
  );
}

/**
 * The Almanac as a list (layout B, "Chronicle"; the page opens on it): Coming
 * up and Played tabs. Coming up runs week by week, each day's date set large
 * on the floor beside its sessions' parchment sheets, with the viewer's quests
 * on them. Played lists the sessions that are over, latest first, a page at
 * a time, as far back as they go.
 */
export default function ChronicleList({ sessions, filtered, filterKey, slips, older, loadOlder }: {
  /** Already filtered. */
  sessions: readonly AlmanacSession[];
  /** Whether a filter is on, for the empty notes. */
  filtered: boolean;
  /** Changes with the filter, so Played goes back to its first page. */
  filterKey: string;
  slips: SlipActions;
  older: OlderState;
  loadOlder: () => void;
}) {
  const [which, setWhich] = useState<Which>('up');
  const { now } = slips;
  const lists = almanacLists(sessions, now);
  const { comingUp } = lists;
  // Only as far back as Played has read, so there are no gaps (the calendar may have read further back).
  const played = lists.played.filter((s) => reached(s, older.reach));
  const weeks = chronicleWeeks(comingUp, now);

  return (
    <>
      <GildedPanel className="hs-alm-strip">
        <AlmanacTabs
          label="Which sessions"
          tabs={[{ id: 'up', label: 'Coming up', count: comingUp.length }, { id: 'played', label: 'Played', count: `${played.length}${older.more ? '+' : ''}` }]}
          value={which}
          onChange={setWhich}
          panelId={PANEL_ID}
          idPrefix={TAB_PREFIX}
        />
      </GildedPanel>

      <div role="tabpanel" id={PANEL_ID} aria-labelledby={`${TAB_PREFIX}-${which}`} className="hs-alm-list">
        {which === 'played' ? (
          <PlayedPages played={played} filtered={filtered} filterKey={filterKey} older={older} loadOlder={loadOlder} />
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
