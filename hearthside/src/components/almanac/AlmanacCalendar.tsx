"use client";

import { useEffect, useState } from 'react';
import GildedPanel from '@/components/design-system/GildedPanel';
import QuestSlips from '@/components/quests/QuestSlips';
import {
  addDays, addMonths, dayButtonLabel, dayKey, firstDay, firstOfMonth, fromDayKey, longDayName, mondayOf, monthDays,
  monthTitle, openQuestsOn, phaseOf, placeLine, questMark, questsDueOn, rangeOf, sameDay, sessionsOn, sheetQuests,
  startOfDay, timeOnDay, weekDays, weekTitle, weekdayShort,
  type AlmanacSession, type Range,
} from '@/lib/almanac';
import type { CampaignSummary } from '@/lib/campaigns';
import AlmanacSheet, { titleOf, type SlipActions } from './AlmanacSheet';
import AlmanacTabs from './AlmanacTabs';
import BannerArt from './BannerArt';

type Span = 'month' | 'week';
const PANEL_ID = 'hs-alm-cal-panel';
const TAB_PREFIX = 'hs-alm-cal-tab';
const WEEK_HEAD = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
/** A month cell shows this many things, then "+2 more". */
const CELL_ITEMS = 3;

const plural = (n: number, unit: string) => `${n} ${unit}${n === 1 ? '' : 's'}`;

/** Played sessions grey their banner; cancelled ones drop it for a dashed outline. */
const phaseClass = (s: AlmanacSession, now: Date) => `is-${phaseOf(s, now)}`;

type Banners = ReadonlyMap<string, CampaignSummary>;

/**
 * The quests on a session's sheet, as a mark on it in the calendar (#252):
 * "2 quests" still open, a tick once they're all done, nothing with none.
 */
function QuestMarkOn({ s }: { s: AlmanacSession }) {
  const mark = questMark(s);
  if (!mark) return null;
  return (
    <span className={mark.done ? 'hs-alm-qm is-done' : 'hs-alm-qm'}>
      {mark.done && <span aria-hidden="true">✓ </span>}{mark.label}
    </span>
  );
}

/** A session in a month cell: its banner behind, in a gilded panel's gold frame; the time and title over a dark fade. */
function MonthSession({ s, day, now, banners }: { s: AlmanacSession; day: Date; now: Date; banners: Banners }) {
  const off = phaseOf(s, now) === 'cancelled';
  return (
    <div className={`hs-alm-ms ${phaseClass(s, now)}`} title={`${s.campaign.title}: ${titleOf(s)}`}>
      {!off && <BannerArt id={s.campaign.id} title={s.campaign.title} url={banners.get(s.campaign.id)?.bannerUrl} />}
      <span className="hs-alm-ms-in">
        <b>{off ? 'Cancelled' : timeOnDay(s, day, false)}</b>
        <span className="hs-alm-ms-t">{titleOf(s)}</span>
        <QuestMarkOn s={s} />
      </span>
    </div>
  );
}

/** A session in a week's day: the banner above its time, title and place. */
function WeekSession({ s, day, now, banners }: { s: AlmanacSession; day: Date; now: Date; banners: Banners }) {
  const off = phaseOf(s, now) === 'cancelled';
  return (
    <div className={`hs-alm-ws ${phaseClass(s, now)}`} title={s.campaign.title}>
      {!off && <span className="hs-alm-ws-bn"><BannerArt id={s.campaign.id} title={s.campaign.title} url={banners.get(s.campaign.id)?.bannerUrl} /></span>}
      <span className="hs-alm-ws-body">
        <span className="hs-alm-ws-t">{timeOnDay(s, day, true)}</span>
        <b>{titleOf(s)}</b>
        <small>{off ? 'Cancelled' : placeLine(s)}</small>
        <QuestMarkOn s={s} />
      </span>
    </div>
  );
}

/** The chosen day under the calendar: its sessions on parchment, then the quests due that day. */
function DayDetail({ day, sessions, slips }: { day: Date; sessions: readonly AlmanacSession[]; slips: SlipActions }) {
  const ss = sessionsOn(sessions, day);
  const qs = questsDueOn(sessions, day);
  const bits = [ss.length ? plural(ss.length, 'session') : '', qs.length ? `${plural(qs.length, 'quest')} due` : ''].filter(Boolean);
  return (
    <section className="hs-alm-dayd" aria-labelledby="hs-alm-dayd-h">
      <h2 className="hs-sec" id="hs-alm-dayd-h">
        <span>{longDayName(day)}</span>
        <span className="hs-aside">{bits.join(' · ') || 'Nothing on'}</span>
      </h2>
      {ss.length > 0 && <div className="hs-alm-sheets">{ss.map((s) => <AlmanacSheet key={s.id} session={s} slips={slips} />)}</div>}
      {qs.length > 0 && (
        <GildedPanel className="hs-alm-due">
          <p className="hs-alm-panel-h">Due this day</p>
          <QuestSlips label="Due this day" quests={qs} now={slips.now} canTick={slips.canTick} ticking={slips.ticking} onTick={slips.onTick} />
        </GildedPanel>
      )}
      {!ss.length && !qs.length && <p className="hs-note">No sessions or quests on this day. Pick another day on the calendar.</p>}
    </section>
  );
}

/**
 * The Almanac as a calendar: Month and Week tabs across the top of a gilded
 * panel, the chosen day's sessions on parchment below. Switching between
 * Month and Week keeps the chosen day. Sessions outrank quests: each carries
 * its campaign's banner in a gold frame (greyed once played, outlined if
 * cancelled). Quests sit on the day they're due as paper slips (#227's),
 * ticked off there, unless that's a day of their own session (or they have no
 * due time), when they're on its sheet and the session carries a mark with
 * how many are still open (#252). A day's button counts the quests still open
 * on it, slips and marks alike. Under 520px the month's cells show marks instead; under
 * 560px Week is a list of days.
 */
export default function AlmanacCalendar({ sessions, banners, slips, ensure }: {
  /** Already filtered. */
  sessions: readonly AlmanacSession[];
  banners: Banners;
  slips: SlipActions;
  ensure: (r: Range) => void;
}) {
  const { now } = slips;
  const today = startOfDay(now);
  const [span, setSpan] = useState<Span>('month');
  const [month, setMonth] = useState(() => firstOfMonth(now));
  const [week, setWeek] = useState(() => mondayOf(now));
  /** The day picked, as a key; null to let the calendar choose (after moving a month or a week). */
  const [chosen, setChosen] = useState<string | null>(null);

  const days = span === 'month' ? monthDays(month) : weekDays(week);
  // Read the span shown, if the first read didn't reach it.
  const shownAt = span === 'month' ? month.getTime() : week.getTime();
  useEffect(() => {
    const at = new Date(shownAt);
    ensure(rangeOf(span === 'month' ? monthDays(at) : weekDays(at)));
  }, [span, shownAt, ensure]);

  const busy = (d: Date) => sessionsOn(sessions, d).length > 0 || questsDueOn(sessions, d).length > 0;
  const ownDays = span === 'month' ? days.filter((d) => d.getMonth() === month.getMonth()) : days;
  const day = chosen && days.some((d) => dayKey(d) === chosen) ? fromDayKey(chosen) : firstDay(ownDays, now, busy);

  const pick = (d: Date) => {
    setChosen(dayKey(d));
    if (span === 'month' && d.getMonth() !== month.getMonth()) setMonth(firstOfMonth(d));
  };
  // Keep the chosen day: the other span opens on the month or week it's in.
  const switchTo = (to: Span) => {
    if (to === span) return;
    setChosen(dayKey(day));
    setMonth(firstOfMonth(day));
    setWeek(mondayOf(day));
    setSpan(to);
  };
  const move = (n: number) => {
    setChosen(null);
    if (span === 'month') setMonth(addMonths(month, n));
    else setWeek(addDays(week, 7 * n));
  };
  const toToday = () => {
    setChosen(dayKey(today));
    setMonth(firstOfMonth(today));
    setWeek(mondayOf(today));
  };

  const unit = span === 'month' ? 'month' : 'week';

  return (
    <>
      <GildedPanel as="section" className="hs-alm-cal" aria-label="Calendar">
        <AlmanacTabs
          label="Calendar span"
          tabs={[{ id: 'month', label: 'Month' }, { id: 'week', label: 'Week' }]}
          value={span}
          onChange={switchTo}
          panelId={PANEL_ID}
          idPrefix={TAB_PREFIX}
        />
        <div role="tabpanel" id={PANEL_ID} aria-labelledby={`${TAB_PREFIX}-${span}`} className="hs-alm-cal-in">
          <div className="hs-alm-cal-head">
            <button type="button" className="hs-alm-nav" aria-label={`Previous ${unit}`} onClick={() => move(-1)}>‹</button>
            <h2>{span === 'month' ? monthTitle(month) : weekTitle(week)}</h2>
            <button type="button" className="hs-alm-nav" onClick={toToday}>Today</button>
            <button type="button" className="hs-alm-nav" aria-label={`Next ${unit}`} onClick={() => move(1)}>›</button>
          </div>

          {span === 'month' ? (
            <div className="hs-alm-month">
              <div className="hs-alm-wd" aria-hidden="true">{WEEK_HEAD.map((w) => <span key={w}>{w}</span>)}</div>
              <div className="hs-alm-grid">
                {days.map((d) => {
                  const ss = sessionsOn(sessions, d);
                  const qs = questsDueOn(sessions, d);
                  const sel = sameDay(d, day);
                  const shownS = ss.slice(0, CELL_ITEMS);
                  const shownQ = qs.slice(0, Math.max(0, CELL_ITEMS - shownS.length));
                  const more = ss.length + qs.length - shownS.length - shownQ.length;
                  const cls = ['hs-alm-cell', d.getMonth() !== month.getMonth() && 'is-out', sameDay(d, today) && 'is-today', sel && 'is-sel'].filter(Boolean).join(' ');
                  return (
                    // The cell picks its day on a click; the day's number is the way in from the keyboard.
                    <div key={dayKey(d)} className={cls} onClick={() => pick(d)}>
                      <button type="button" className="hs-alm-num" aria-label={dayButtonLabel(d, ss.length, openQuestsOn(sessions, d))} aria-pressed={sel}>
                        {d.getDate()}
                      </button>
                      <div className="hs-alm-items">
                        {shownS.map((s) => <MonthSession key={s.id} s={s} day={d} now={now} banners={banners} />)}
                        {shownQ.length > 0 && (
                          <QuestSlips label={`Quests due ${longDayName(d)}`} quests={shownQ} now={now} canTick={slips.canTick} ticking={slips.ticking} onTick={slips.onTick} className="hs-alm-cslips" />
                        )}
                        {more > 0 && <span className="hs-alm-more">+{more} more</span>}
                      </div>
                      <div className="hs-alm-dots" aria-hidden="true">
                        {ss.map((s) => <i key={s.id} className={phaseOf(s, now) === 'cancelled' ? 'is-off' : undefined} />)}
                        {[...ss.flatMap((s) => (questMark(s) ? sheetQuests(s) : [])), ...qs].map((q) => (
                          <i key={q.id} className={q.status === 'done' ? 'q is-done' : 'q'} />
                        ))}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          ) : (
            <ol className="hs-alm-wgrid" aria-label="Days of the week">
              {days.map((d) => {
                const ss = sessionsOn(sessions, d);
                const qs = questsDueOn(sessions, d);
                const sel = sameDay(d, day);
                const cls = ['hs-alm-wday', sameDay(d, today) && 'is-today', sel && 'is-sel'].filter(Boolean).join(' ');
                return (
                  <li key={dayKey(d)} className={cls} onClick={() => pick(d)}>
                    <button type="button" className="hs-alm-wdh" aria-label={dayButtonLabel(d, ss.length, openQuestsOn(sessions, d))} aria-pressed={sel}>
                      <span>{weekdayShort(d)}</span><b>{d.getDate()}</b>
                    </button>
                    <div className="hs-alm-witems">
                      {ss.map((s) => <WeekSession key={s.id} s={s} day={d} now={now} banners={banners} />)}
                      {qs.length > 0 && (
                        <QuestSlips label={`Quests due ${longDayName(d)}`} quests={qs} now={now} canTick={slips.canTick} ticking={slips.ticking} onTick={slips.onTick} className="hs-alm-cslips" />
                      )}
                      {!ss.length && !qs.length && <span className="hs-alm-none">Nothing on</span>}
                    </div>
                  </li>
                );
              })}
            </ol>
          )}
          <p className="hs-alm-legend">
            Sessions carry their campaign’s banner: greyed once played. Paper slips are your quests, on the day they’re due; tick one to mark it done.
          </p>
        </div>
      </GildedPanel>
      <DayDetail day={day} sessions={sessions} slips={slips} />
    </>
  );
}
