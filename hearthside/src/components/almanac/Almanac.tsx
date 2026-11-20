"use client";

import { useCallback, useMemo, useState } from 'react';
import {
  NO_FILTER, applyFilter, campaignChoices, filterCounts, headLine, isFiltered,
  type AlmanacFilter,
} from '@/lib/almanac';
import type { Quest } from '@/lib/quests';
import { useRequiredSession } from '@/lib/session';
import { useAlmanac } from '@/lib/useAlmanac';
import AlmanacCalendar from './AlmanacCalendar';
import AlmanacFilters from './AlmanacFilters';
import type { SlipActions } from './AlmanacSheet';
import ChronicleList from './ChronicleList';

type View = 'list' | 'calendar';

/**
 * The Almanac (#228, spec #69): layout B, "Chronicle", from
 * prototype/hearthside-almanac. The viewer's dated sessions and their quests
 * on them, as a list by week (the default) or a calendar, with a List /
 * Calendar switch at the right of the heading and filters under it for both.
 * Sessions still picking a night aren't here yet (#201), and personal tasks
 * and events stay on the portfolio's calendar.
 */
export default function Almanac() {
  const { status, user } = useRequiredSession();
  const [now] = useState(() => new Date());
  const data = useAlmanac(status === 'signedIn', now);
  const [view, setView] = useState<View>('list');
  const [filter, setFilter] = useState<AlmanacFilter>(NO_FILTER);
  const viewerId = user?.id ?? null;

  const all = useMemo(() => data.sessions ?? [], [data.sessions]);
  const shown = useMemo(() => applyFilter(all, filter), [all, filter]);
  const choices = useMemo(() => campaignChoices(all), [all]);
  const counts = useMemo(() => filterCounts(all, filter, now), [all, filter, now]);

  // The Almanac lists only your own quests: tick an open one off.
  const canTick = useCallback((q: Quest) => q.status === 'open' && !!viewerId && q.assignee?.id === viewerId, [viewerId]);
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
            ? <ChronicleList sessions={shown} filtered={isFiltered(filter)} slips={slips} />
            : <AlmanacCalendar sessions={shown} banners={data.campaigns} slips={slips} ensure={data.ensure} />}
        </>
      )}
    </>
  );
}
