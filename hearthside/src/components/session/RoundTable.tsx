"use client";

import { useEffect, useLayoutEffect, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from 'react';
import { Flame } from 'lucide-react';
import GildedPanel from '@/components/design-system/GildedPanel';
import QuestSlips from '@/components/quests/QuestSlips';
import { errorOf } from '@/lib/api';
import type { SessionPhase } from '@/lib/sessionPage';
import {
  attendanceDraft, canAddQuests, canTick, headOf, middleCard, readyTally, seatMark, seatPositions, slipsBySeat,
  tableSeats, type ReadyCheck, type Seat, type SeatMark,
} from '@/lib/sessionTable';
import type { PlanningRead, SessionDetail } from '@/lib/useSessionPage';
import { useSessionTable } from '@/lib/useSessionTable';

const STATUS: Record<Exclude<SeatMark, null>, string> = {
  ready: 'Ready',
  'not-ready': 'Can’t make it',
  away: 'Away',
  came: 'Came',
};

/** "Now" for the countdown, a minute at a time. */
function useMinute() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(t);
  }, []);
  return now;
}

/**
 * The round table (#227; layout C, "Around the table", revised): the GM at
 * its head with an orange ring, each party member in a seat on a brass
 * plate (as their adventurer in this campaign when they have exactly one
 * who hasn't fallen), and a card in the middle. Seats glow green or red
 * from the ready check; once the GM confirms attendance, whoever was away
 * has a grey seat. Each player's quests sit by their seat as paper slips,
 * the GM's beside the head. Quest links (`#quests`) land here.
 *
 * The table top is a picture, painted once from the session prototype's
 * painter (round-table.jpg), not painted live.
 */
export default function RoundTable({ session, planning, phase, gmTitle, onReadyCheck }: {
  session: SessionDetail;
  planning: PlanningRead | null;
  phase: SessionPhase;
  gmTitle: string;
  /** The ready check after the viewer answered it. */
  onReadyCheck: (readyCheck: ReadyCheck) => void;
}) {
  const now = useMinute();
  const table = useSessionTable(session._id, session.campaign?._id ?? null);
  const { attendance, viewer, quests } = table;
  const [draft, setDraft] = useState<Set<string> | null>(null);
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [adding, setAdding] = useState<string | null>(null);

  const party = planning?.party ?? [];
  const standIn = planning?.session.gmOverride ?? null;
  const headId = headOf(party, planning?.campaign.gameMasterIds ?? [], standIn?.id ?? null);
  const seats = tableSeats(party, headId, table.characters);
  const places = seatPositions(seats.length);
  const slips = slipsBySeat(quests ?? []);
  const isGM = viewer?.isGameMaster ?? planning?.viewer.isGameMaster ?? false;
  const meId = viewer?.id ?? planning?.viewer.id ?? null;
  const adds = canAddQuests(session, phase, isGM) && quests !== null;
  const card = middleCard(session, phase, now);

  // Slips hang below the bottom seats, past the table's edge: make room for them, however many there are.
  const ringRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const ring = ringRef.current;
    if (!ring) return;
    const fit = () => {
      const bottom = ring.getBoundingClientRect().bottom;
      const lowest = Math.max(bottom, ...[...ring.querySelectorAll<HTMLElement>('.hs-seat')].map((s) => s.getBoundingClientRect().bottom));
      ring.style.marginBottom = `${Math.ceil(lowest - bottom) + 12}px`;
    };
    fit();
    const watch = new ResizeObserver(fit);
    watch.observe(ring);
    ring.querySelectorAll('.hs-seat').forEach((s) => watch.observe(s));
    return () => watch.disconnect();
  });

  const takeAttendance = () => { if (attendance) { setProblem(null); setDraft(attendanceDraft(attendance)); } };
  const toggle = (id: string) => setDraft((d) => {
    const next = new Set(d);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  const confirm = async () => {
    if (!draft) return;
    setSaving(true);
    setProblem(null);
    try {
      await table.confirmAttendance([...draft]);
      setDraft(null);
    } catch (err) {
      setProblem(errorOf(err, 'The attendance didn’t save. Try again in a moment.'));
    } finally {
      setSaving(false);
    }
  };
  const answer = async (ready: boolean) => {
    setSaving(true);
    setProblem(null);
    try {
      const check = await table.answerReady(ready);
      if (check) onReadyCheck(check);
    } catch (err) {
      setProblem(errorOf(err, 'Your answer didn’t save. Try again in a moment.'));
    } finally {
      setSaving(false);
    }
  };

  const seatIds = seats.map((s) => s.personId);
  const came = draft ? seatIds.filter((id) => draft.has(id)).length : 0;
  const tally = readyTally(session.readyCheck, seatIds);
  const myAnswer = session.readyCheck?.responses?.find((r) => r.playerId === meId)?.ready;
  const rows: ReactNode[] = [];
  if (session.readyCheck?.sentAt && phase === 'before' && session.status !== 'planning') {
    rows.push(
      <div key="ready" className="hs-table-row">
        <span><b>Ready check</b> · {tally.ready} of {tally.total} ready</span>
        {meId && seatIds.includes(meId) && (
          <span className="hs-table-btns">
            <button type="button" className={myAnswer === true ? 'hs-btn-amber' : 'hs-ghost'} disabled={saving || myAnswer === true} onClick={() => answer(true)}>
              {myAnswer === true ? 'You’re ready' : 'Ready up'}
            </button>
            <button type="button" className="hs-ghost" disabled={saving || myAnswer === false} onClick={() => answer(false)}>Can’t make it</button>
          </span>
        )}
      </div>,
    );
  }
  if (attendance && draft) {
    rows.push(
      <div key="attendance" className="hs-table-row">
        <span>Tap a seat to mark who came.{attendance.confirmedAt ? '' : ' Ticked from the ready check.'}</span>
        <span className="hs-table-btns">
          <button type="button" className="hs-btn-amber" disabled={saving} onClick={confirm}>
            {saving ? 'Saving…' : `Confirm: ${came} of ${seatIds.length} came`}
          </button>
          <button type="button" className="hs-ghost" disabled={saving} onClick={() => setDraft(null)}>Cancel</button>
        </span>
      </div>,
    );
  } else if (attendance?.confirmedAt) {
    const there = seatIds.filter((id) => attendance.people.some((p) => p.playerId === id && p.attended)).length;
    rows.push(
      <div key="attendance" className="hs-table-row">
        <span>{there ? `${there} of ${seatIds.length} came.` : 'Nobody came.'}</span>
        {attendance.canConfirm && attendance.open && (
          <button type="button" className="hs-ghost" onClick={takeAttendance}>Edit attendance</button>
        )}
      </div>,
    );
  } else if (attendance?.canConfirm && attendance.open && phase !== 'cancelled') {
    rows.push(
      <div key="attendance" className="hs-table-row">
        <span>Attendance isn’t taken yet.{session.readyCheck?.responses?.length ? ' The seats show the ready check.' : ''}</span>
        <button type="button" className="hs-btn-amber" onClick={takeAttendance}>Take attendance</button>
      </div>,
    );
  }
  const problems = [problem, table.error].filter(Boolean);

  const seat = (s: Seat, i: number) => {
    let mark = seatMark(s.personId, { phase, readyCheck: session.readyCheck, attendance, draft });
    // The head keeps its orange ring through the ready check; it greys only if the GM was away.
    if (s.head && !draft && mark !== 'away') mark = null;
    // "Came" is only worth saying while the GM taps seats; afterwards the away seats tell it.
    const status = mark && (mark !== 'came' || draft) ? STATUS[mark] : null;
    const mine = s.personId === meId;
    const shown = s.adventurer ?? s.name;
    const under = s.head ? (standIn?.id === s.personId ? `${gmTitle}, standing in` : gmTitle) : s.adventurer ? (mine ? 'You' : s.name) : mine ? 'You' : null;
    const cls = ['hs-seat', s.head && 'is-head', mark && `is-${mark}`, mine && 'is-me'].filter(Boolean).join(' ');
    const inner = (
      <>
        <span className="hs-avatar hs-seat-medal" aria-hidden="true">{[...shown][0]?.toUpperCase() ?? '?'}</span>
        <span className="hs-seat-plate">
          <b>{shown}</b>
          {under && <small>{under}</small>}
        </span>
        {s.head && !status && <Flame className="hs-seat-flame" strokeWidth={1.6} aria-hidden="true" />}
        {status && <span className="hs-seat-st">{status}</span>}
      </>
    );
    const theirs = slips.get(s.personId) ?? [];
    return (
      <div key={s.personId} className={cls} style={{ left: `${places[i].x}%`, top: `${places[i].y}%` }} role="group" aria-label={`${s.name}’s seat`}>
        {draft ? (
          <button type="button" className="hs-seat-who" aria-pressed={draft.has(s.personId)} onClick={() => toggle(s.personId)}
            aria-label={`${s.adventurer ? `${s.adventurer}, ${s.name}` : s.name}: ${draft.has(s.personId) ? 'came' : 'away'}`}>
            {inner}
          </button>
        ) : (
          <div className="hs-seat-who">{inner}</div>
        )}
        <QuestSlips
          className="hs-seat-slips"
          label={mine ? 'Your quests' : `${s.name}’s quests`}
          quests={theirs}
          now={now}
          canTick={(q) => canTick(q, viewer)}
          ticking={table.ticking}
          onTick={table.tick}
        >
          {adds && (
            <li className="hs-slip-tool">
              {adding === s.personId
                ? <NewQuest name={s.name} onAdd={(title) => table.addQuest(s.personId, title)} onDone={() => setAdding(null)} />
                : <button type="button" className="hs-slip-plus" aria-label={`Add a quest for ${s.name}`} onClick={() => setAdding(s.personId)}>+ quest</button>}
            </li>
          )}
        </QuestSlips>
      </div>
    );
  };

  return (
    <section id="quests" className="hs-sess-table" aria-label="Around the table">
      <div className="hs-table" ref={ringRef}>
        <div className="hs-table-top" aria-hidden="true" />
        <div className="hs-table-mid"><TableCard card={card} isGM={isGM} /></div>
        {seats.map(seat)}
      </div>
      {problems.map((p) => <p key={p} className="hs-alert" role="alert">{p}</p>)}
      {rows.length > 0 && <GildedPanel className="hs-table-strip">{rows}</GildedPanel>}
    </section>
  );
}

/** The card in the middle of the table: its front only (#227). The recording and the cinematic are #199's. */
function TableCard({ card, isGM }: { card: ReturnType<typeof middleCard>; isGM: boolean }) {
  const [head, big, line, link] = ((): [string, string, string | null, string | null] => {
    switch (card.kind) {
      case 'countdown': return ['Coming up', card.when || 'Soon', `Starts in ${card.left}`, null];
      case 'unscheduled': return ['Coming up', 'No night yet', 'The party is still choosing one.', null];
      case 'under-way': return ['At the table', 'Under way', 'The recording goes here afterwards.', null];
      case 'recording': return ['The recording', 'The recording', null, card.url];
      case 'no-recording': return ['The recording', 'No recording yet', isGM ? 'Add its link with Edit.' : null, null];
      case 'cancelled': return ['Cancelled', 'Cancelled', 'Nothing to record.', null];
    }
  })();
  return (
    <div className={`hs-table-card is-${card.kind}`} role="group" aria-label="The middle of the table">
      <span className="hs-table-card-h">{head}</span>
      <div className="hs-table-say">
        {card.kind === 'recording'
          ? <a className="hs-btn-amber" href={link!} target="_blank" rel="noopener noreferrer">Watch the recording ↗</a>
          : <b>{big}</b>}
        {line && <p>{line}</p>}
      </div>
    </div>
  );
}

/** "+ quest" opened: Enter adds it for that player, due when the session starts; Escape, or leaving it empty, closes it. */
function NewQuest({ name, onAdd, onDone }: { name: string; onAdd: (title: string) => Promise<void>; onDone: () => void }) {
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const t = title.trim();
    if (!t) { onDone(); return; }
    setBusy(true);
    setError(null);
    try {
      await onAdd(t);
      onDone();
    } catch (err) {
      setError(errorOf(err, 'The quest didn’t save.'));
      setBusy(false);
    }
  };
  const keys = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onDone(); } };
  return (
    <form className="hs-slip-new" onSubmit={submit}>
      <input
        autoFocus
        className="hs-slip-input"
        value={title}
        maxLength={120}
        disabled={busy}
        enterKeyHint="done"
        placeholder={`A quest for ${name}`}
        aria-label={`New quest for ${name}, Enter to add`}
        onChange={(e) => setTitle(e.target.value)}
        onKeyDown={keys}
        onBlur={() => { if (!title.trim() && !busy) onDone(); }}
      />
      {error && <span className="hs-slip-error" role="alert">{error}</span>}
    </form>
  );
}
