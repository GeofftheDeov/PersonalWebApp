"use client";

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  NO_FILTER, applyFilter, campaignChoices, filterCounts, headLine, isFiltered, keepView, storedView,
  type AlmanacFilter, type AlmanacView,
} from '@/lib/almanac';
import type { Quest } from '@/lib/quests';
import { useRequiredSession } from '@/lib/session';
import { browserStorage } from '@/lib/signIn';
import { useAlmanac } from '@/lib/useAlmanac';
import AlmanacCalendar from './AlmanacCalendar';
import AlmanacFilters from './AlmanacFilters';
import type { SlipActions } from './AlmanacSheet';
import ChronicleList from './ChronicleList';

/**
 * The Almanac (#228, spec #69): layout B, "Chronicle", from
 * prototype/hearthside-almanac. The viewer's dated sessions and their quests
 * on them, as a list by week or a calendar, with a List / Calendar switch at
 * the right of the heading and filters under it for both. It opens on the
 * view used last (#252, kept in localStorage under `VIEW_KEY`), the list at
 * first or when storage is refused.
 * Sessions still picking a night aren't here yet (#201), and personal tasks
 * and events stay on the portfolio's calendar.
 */
export default function Almanac() {
  const { status, user } = useRequiredSession();
  const [now] = useState(() => new Date());
  const data = useAlmanac(status === 'signedIn', now);
  const [view, setViewState] = useState<AlmanacView>('list');
  // Read after mounting, so the server's render and the first client one agree.
  useEffect(() => { setViewState(storedView(browserStorage())); }, []);
  const setView = (v: AlmanacView) => { setViewState(v); keepView(browserStorage(), v); };
  const [filter, setFilter] = useState<AlmanacFilter>(NO_FILTER);
  const viewerId = user?.id ?? null;

  const all = useMemo(() => data.sessions ?? [], [data.sessions]);
  const shown = useMemo(() => applyFilter(all, filter), [all, filter]);
  const choices = useMemo(() => campaignChoices(all), [all]);
  const counts = useMemo(() => filterCounts(all, filter, now), [all, filter, now]);
  const filterKey = `${filter.where}|${[...filter.campaigns].sort().join()}`;

  // The Almanac lists only your own quests: tick one off, or back on.
  const canTick = useCallback((q: Quest) => q.status !== 'cancelled' && !!viewerId && q.assignee?.id === viewerId, [viewerId]);
  const slips: SlipActions = { now, canTick, ticking: data.ticking, onTick: data.tick };

  return (
    <>
      <header className="hs-page-head hs-alm-head">
        <div>
          <h1>The Almanac</h1>
          {data.sessions && <p>{headLine(shown, now)}</p>}
        </div>
        <div className="hs-alm-seg" role="group" aria-label="Show the Almanac as">
          <button type="button" aria-pressed={view === 'list'} onClick={() => setView('list')}>List</button>
          <button type="button" aria-pressed={view === 'calendar'} onClick={() => setView('calendar')}>Calendar</button>
        </div>
      </header>

      {data.error ? (
        <p className="hs-note hs-alm-error" role="alert">{data.error}</p>
      ) : !data.sessions ? (
        <p className="hs-note" role="status">Unrolling the Almanac…</p>
      ) : (
        <>
          <AlmanacFilters filter={filter} onChange={setFilter} choices={choices} counts={counts} banners={data.campaigns} />
          {data.tickError && <p className="hs-alert hs-alm-error" role="alert">{data.tickError}</p>}
          {view === 'list'
            ? <ChronicleList sessions={shown} filtered={isFiltered(filter)} filterKey={filterKey} slips={slips} older={data.older} loadOlder={data.loadOlder} />
            : <AlmanacCalendar sessions={shown} banners={data.campaigns} slips={slips} ensure={data.ensure} />}
        </>
      )}
    </>
  );
}
