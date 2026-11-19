"use client";

import { useEffect, useId, useMemo, useState } from 'react';
import { api, errorOf } from '@/lib/api';
import { optionWhen } from '@/lib/noticeBoard';
import {
  DAY_CHOICES, HOUR_CHOICES, MAX_PICKS, MIN_PICKS, bestTimes, fromDateInput, heatLevel, hourLabel, overlapGrid,
  overlapQuery, slotName, toDateInput, togglePick, whoLine, type Overlap, type PickedTime, type Slot,
} from '@/lib/overlap';

/**
 * The overlap picker (#57, #225), on a notice's parchment: the GM chooses
 * nights to put to the party from when the party is free. Settings (from,
 * for how many days, how long a session runs), the best times, then the
 * availability grid, days across and start times down, each cell the
 * party's headcount on the design system's heat scale, an inked outline
 * where it meets quorum. Pick two to four and send them.
 * Backed by GET /api/availability/campaigns/:id (the GM only).
 */
export default function OverlapPicker({ campaignId, submitLabel, submitting, onSubmit, onCancel }: {
  campaignId: string;
  /** "Send to the party", "Re-shortlist", "Put it to a vote". */
  submitLabel: string;
  submitting: boolean;
  onSubmit: (times: PickedTime[]) => void;
  /** Shows "Never mind" when the picker can be put away. */
  onCancel?: () => void;
}) {
  const id = useId();
  const [from, setFrom] = useState(() => toDateInput(new Date()));
  const [days, setDays] = useState<number>(14);
  const [hours, setHours] = useState<number>(4);
  const [data, setData] = useState<Overlap | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [picked, setPicked] = useState<PickedTime[]>([]);
  const start = useMemo(() => fromDateInput(from) ?? fromDateInput(toDateInput(new Date()))!, [from]);

  useEffect(() => {
    let live = true;
    setLoading(true);
    setError(null);
    api.get<Overlap>(`/api/availability/campaigns/${encodeURIComponent(campaignId)}?${overlapQuery(start, days, hours)}`)
      .then((d) => { if (live) setData(d); })
      .catch((err) => { if (live) { setData(null); setError(errorOf(err, 'The party’s availability couldn’t be read.')); } })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [campaignId, start, days, hours]);

  // A new session length changes every night's end.
  useEffect(() => setPicked([]), [hours]);

  const now = new Date();
  const size = data?.party.length ?? 0;
  const names = useMemo(() => new Map((data?.party ?? []).map((p) => [p.id, p.name])), [data]);
  const grid = data ? overlapGrid(data, start, days, now) : null;
  const best = data ? bestTimes(data.slots, now) : [];
  const isPicked = (s: Slot) => picked.some((p) => p.start === s.start);
  const pick = (s: Slot) => setPicked((prev) => togglePick(prev, s));
  const full = picked.length >= MAX_PICKS;
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone.replace(/_/g, ' ');

  return (
    <div className="hs-pick" role="group" aria-label="Choose nights from the party’s availability">
      <div className="hs-pick-set">
        <label className="hs-pick-field"><span>From</span>
          <input type="date" className="hs-paper-input" value={from} min={toDateInput(now)}
            onChange={(e) => setFrom(e.target.value || toDateInput(new Date()))} />
        </label>
        <label className="hs-pick-field"><span>For</span>
          <select className="hs-paper-input" value={days} onChange={(e) => setDays(Number(e.target.value))}>
            {DAY_CHOICES.map((n) => <option key={n} value={n}>{n} days</option>)}
          </select>
        </label>
        <label className="hs-pick-field"><span>Session length</span>
          <select className="hs-paper-input" value={hours} onChange={(e) => setHours(Number(e.target.value))}>
            {HOUR_CHOICES.map((n) => <option key={n} value={n}>{n} hours</option>)}
          </select>
        </label>
        {data && <span className="hs-pick-quorum">Quorum: {data.quorum} of {size}</span>}
      </div>

      {error && <p className="hs-board-alert" role="alert">{error}</p>}
      {loading && !data && <p className="hs-board-fine">Reading the party’s calendars…</p>}

      {data && (
        <>
          {(data.notes ?? []).map((note) => <p key={note} className="hs-pick-note" role="status">{note}</p>)}

          <div>
            <h5 className="hs-pick-h" id={`${id}-best`}>Best times</h5>
            {best.length === 0 ? (
              <p className="hs-board-fine">Nobody in the party has availability in this range yet.</p>
            ) : (
              <ul className="hs-pick-best" aria-labelledby={`${id}-best`}>
                {best.map((s) => {
                  const who = whoLine(s, names);
                  return (
                    <li key={s.start}>
                      <button type="button" aria-pressed={isPicked(s)} disabled={full && !isPicked(s)} onClick={() => pick(s)}>
                        <span>{optionWhen(s.start, s.end)}</span>
                        <span className={s.meetsQuorum ? 'hs-pick-tag is-ink' : 'hs-pick-tag'}>
                          {s.headcount}/{size} free{s.meetsQuorum ? '' : ' · below quorum'}
                        </span>
                        {who && <small>{who}</small>}
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          {grid && (
            <div>
              <h5 className="hs-pick-h" id={`${id}-grid`}>Every start time · free count</h5>
              <div className="hs-pick-heatwrap">
                <table className="hs-pick-heat" aria-labelledby={`${id}-grid`}>
                  <thead>
                    <tr>
                      <td />
                      {grid.days.map((d) => (
                        <th key={d.day.getTime()} scope="col"><span className="hs-pick-dow">{d.weekday}</span>{d.label}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {grid.hours.map((h, row) => (
                      <tr key={h}>
                        <th scope="row">{hourLabel(h)}</th>
                        {grid.cells[row].map((slot, col) => (
                          <td key={col}>
                            {slot ? (
                              <button type="button" data-v={heatLevel(slot.headcount, size)}
                                className={slot.meetsQuorum ? 'is-q' : undefined}
                                disabled={!slot.headcount || (full && !isPicked(slot))}
                                aria-pressed={isPicked(slot)}
                                aria-label={slotName(slot, size)}
                                title={`${optionWhen(slot.start, slot.end)}\nFree: ${slot.free.map((i) => names.get(i) ?? 'someone').join(', ') || 'nobody'}\n${whoLine(slot, names)}`}
                                onClick={() => pick(slot)}>
                                {slot.headcount || ''}
                              </button>
                            ) : <span className="hs-pick-none" />}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="hs-board-fine">Darker means more of the party is free. An inked outline meets quorum. Times are yours ({tz}).</p>
            </div>
          )}
        </>
      )}

      <div className="hs-pick-list">
        <h5 className="hs-pick-h">Shortlist ({picked.length} of {MAX_PICKS}): pick {MIN_PICKS} to {MAX_PICKS}</h5>
        {picked.length > 0 && (
          <ul className="hs-pick-chips" aria-label="The shortlist">
            {picked.map((p) => (
              <li key={p.start}>
                {optionWhen(p.start, p.end)}
                <button type="button" aria-label={`Take ${optionWhen(p.start, p.end)} off the shortlist`}
                  onClick={() => setPicked((prev) => prev.filter((x) => x.start !== p.start))}>✕</button>
              </li>
            ))}
          </ul>
        )}
        <div className="hs-btn-row">
          <button type="button" className="hs-btn is-primary" disabled={picked.length < MIN_PICKS || submitting} onClick={() => onSubmit(picked)}>
            {submitting ? 'Sending…' : submitLabel}
          </button>
          {onCancel && <button type="button" className="hs-btn" onClick={onCancel}>Never mind</button>}
        </div>
      </div>
    </div>
  );
}
