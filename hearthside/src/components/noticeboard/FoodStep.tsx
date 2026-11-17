"use client";

import { useState } from 'react';
import { nameIn, unclaimedSlots, type Member, type PlanningState } from '@/lib/noticeBoard';
import type { Act } from './NoticeBoardSheet';

const DEFAULT_SLOTS = 'Main, Snacks, Drinks';

/**
 * The food step (#93), in person, once the venue is set. A potluck: the
 * slots on a ledger, the unclaimed ones in the seal's red; the party claims
 * one, backs out of one, or adds their own, and the GM lists what's needed.
 * Food provided: who's on it. Either way the GM schedules the session when
 * the food's sorted, and the step closes by itself when the session starts.
 */
export default function FoodStep({ state, busy, act }: { state: PlanningState; busy: boolean; act: Act }) {
  const { food, viewer, campaign } = state;
  const gm = viewer.isGameMaster;
  const inParty = state.party.some((p) => p.id === viewer.id);
  const quests = food?.quests ?? [];
  const [seed, setSeed] = useState(quests.length ? '' : DEFAULT_SLOTS);
  const [own, setOwn] = useState('');
  const who = (m: Member) => (m.id === viewer.id ? 'You' : m.name);
  const titles = seed.split(',').map((t) => t.trim()).filter(Boolean);
  const open = unclaimedSlots(state);

  if (!food) return null;

  const confirm = gm ? (
    <>
      <div className="hs-btn-row">
        <button type="button" className="hs-btn is-primary" disabled={busy} onClick={() => act('confirm-food')}>Food’s sorted: schedule it</button>
      </div>
      <p className="hs-board-fine">{open ? 'Unclaimed slots won’t hold it up. ' : ''}Otherwise the food step closes when the session starts.</p>
    </>
  ) : (
    <p className="hs-board-fine">The {campaign.gmTitle} will confirm the food (or it closes when the session starts), and then it’s on.</p>
  );

  if (food.mode === 'provided') {
    const q = quests[0];
    return (
      <>
        {q ? (
          <ul className="hs-ledger" aria-label="The food">
            <li><span>{q.title} · {q.assignee ? who(q.assignee) : 'nobody yet'}</span><span>{q.status === 'done' ? 'Done' : 'On it'}</span></li>
          </ul>
        ) : (
          <p className="hs-board-line">Food provided by {nameIn(state)(food.ownerId)}.</p>
        )}
        {q?.assignee?.id === viewer.id && <p className="hs-board-fine">It’s in Your Quests: tick it off there when the food’s sorted.</p>}
        {confirm}
      </>
    );
  }

  return (
    <>
      {quests.length === 0 ? (
        <p className="hs-board-line">
          {gm ? 'List what’s needed and the party can claim it.' : `The ${campaign.gmTitle} hasn’t listed what’s needed yet: you can add what you’ll bring.`}
        </p>
      ) : (
        <>
          <ul className="hs-ledger" aria-label="The potluck">
            {quests.map((q) => {
              const unclaimed = q.status === 'open' && !q.assignee;
              const mine = q.assignee?.id === viewer.id;
              return (
                <li key={q.id}>
                  <span className="hs-board-slot">{q.title}</span>
                  <span className="hs-board-slot-who">
                    {unclaimed ? <span className="is-open">Unclaimed</span>
                      : q.assignee ? `${who(q.assignee)}${q.status === 'done' ? ' · done' : ''}` : q.status}
                    {unclaimed && inParty && (
                      <button type="button" className="hs-btn" disabled={busy} onClick={() => act(`food/${q.id}/claim`)}
                        aria-label={`I’ll bring ${q.title}`}>I’ll bring it</button>
                    )}
                    {mine && q.status === 'open' && (
                      <button type="button" className="hs-btn" disabled={busy} onClick={() => act(`food/${q.id}/unclaim`)}
                        aria-label={`Back out of ${q.title}`}>Back out</button>
                    )}
                  </span>
                </li>
              );
            })}
          </ul>
          <p className="hs-board-fine">{quests.length - open} of {quests.length} claimed{open ? ` · ${open} still open` : ' · all covered'}</p>
        </>
      )}

      {inParty && (
        <form className="hs-board-row" onSubmit={async (e) => { e.preventDefault(); if (await act('food/add', { title: own })) setOwn(''); }}>
          <input className="hs-paper-input" maxLength={120} value={own} onChange={(e) => setOwn(e.target.value)}
            placeholder="Something else you’ll bring" aria-label="Something else you’ll bring" />
          <button type="submit" className="hs-btn" disabled={busy || !own.trim()}>I’ll bring this</button>
        </form>
      )}

      {gm && (
        <form className="hs-board-row" onSubmit={async (e) => { e.preventDefault(); if (await act('food/seed', { titles })) setSeed(''); }}>
          <input className="hs-paper-input" value={seed} onChange={(e) => setSeed(e.target.value)} placeholder={DEFAULT_SLOTS}
            aria-label="What’s needed (comma-separated)" />
          <button type="submit" className="hs-btn" disabled={busy || titles.length === 0 || titles.length > 10}>
            Add {titles.length > 1 ? `${titles.length} slots` : 'slot'}
          </button>
        </form>
      )}

      {confirm}
    </>
  );
}
