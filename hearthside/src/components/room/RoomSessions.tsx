"use client";

import Link from 'next/link';
import { useState } from 'react';
import { bySessionFilter, filterOptions, type RoomSession, type SessionFilter } from '@/lib/room';
import { timeSpan, whenFromNow } from '@/lib/sessionPage';

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function SessionRow({ s, up, now }: { s: RoomSession; up: boolean; now: Date }) {
  const d = s.date ? new Date(s.date) : null;
  const soon = up && s.date ? whenFromNow(s.date, now) : '';
  return (
    <li>
      <Link className={up ? 'hs-room-sr is-next' : 'hs-room-sr'} href={`/sessions/${s.id}`}>
        <span className="hs-room-sr-when">
          {d ? <><b>{MON[d.getMonth()]} {d.getDate()}</b>{up ? `${WD[d.getDay()]} ${timeSpan(s.date!)}` : d.getFullYear()}</> : <b>No date</b>}
        </span>
        <span className="hs-room-sr-t">
          {s.campaign && <span className="hs-room-sr-k">{s.campaign.title}</span>}
          <span className="hs-room-sr-n">{s.title}</span>
          {soon && <span className="hs-room-sr-as">{soon}</span>}
        </span>
      </Link>
    </li>
  );
}

/**
 * The Sessions tab (layout A): Coming up (dated sessions in the player's
 * campaigns) and Played (the sessions they attended), with one campaign
 * filter over both. The filter shows once there are two campaigns to choose.
 */
export default function RoomSessions({ comingUp, played, now }: { comingUp: RoomSession[] | null; played: RoomSession[] | null; now: Date }) {
  const [filter, setFilter] = useState<SessionFilter>('all');
  if (!comingUp || !played) return <div className="hs-room-sec"><p className="hs-room-empty" role="status">Gathering your sessions…</p></div>;
  if (!comingUp.length && !played.length) {
    return <div className="hs-room-sec"><p className="hs-room-empty">No sessions yet. Sessions in your campaigns show here, and the ones you play stay on the record.</p></div>;
  }

  const options = filterOptions(comingUp, played);
  const current = options.some((o) => o.id === filter) ? filter : 'all';
  const up = bySessionFilter(comingUp, current);
  const done = bySessionFilter(played, current);
  const total = comingUp.length + played.length;

  return (
    <>
      {options.length > 1 && (
        <div className="hs-room-filt" role="group" aria-label="Show sessions from">
          <button type="button" aria-pressed={current === 'all'} onClick={() => setFilter('all')}>
            All <span className="hs-room-n">{total}</span>
          </button>
          {options.map((o) => (
            <button key={o.id} type="button" aria-pressed={current === o.id} onClick={() => setFilter(o.id)}>
              {o.title} <span className="hs-room-n">{o.count}</span>
            </button>
          ))}
        </div>
      )}
      <div className="hs-room-sec">
        <h2 className="hs-room-h" id="hs-room-up">Coming up</h2>
        {up.length
          ? <ul className="hs-room-srs" aria-labelledby="hs-room-up">{up.map((s) => <SessionRow key={s.id} s={s} up now={now} />)}</ul>
          : <p className="hs-room-empty">Nothing on the calendar{current === 'all' ? '' : ' in this campaign'}.</p>}
      </div>
      <div className="hs-room-sec">
        <h2 className="hs-room-h" id="hs-room-played">Played</h2>
        {done.length
          ? <ul className="hs-room-srs" aria-labelledby="hs-room-played">{done.map((s) => <SessionRow key={s.id} s={s} up={false} now={now} />)}</ul>
          : <p className="hs-room-empty">No sessions played{current === 'all' ? ' yet' : ' in this campaign'}.</p>}
      </div>
    </>
  );
}
