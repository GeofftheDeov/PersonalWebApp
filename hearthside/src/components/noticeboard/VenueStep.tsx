"use client";

import Link from 'next/link';
import { useEffect, useId, useState } from 'react';
import { nameIn, voteTally, waitingOn, type PlanningState, type Venue } from '@/lib/noticeBoard';
import VoteTally from './VoteTally';
import type { Act } from './NoticeBoardSheet';

/** What a venue is: "Isolde Varga’s home", "a store", "a venue". */
export const venueKind = (v: Venue, name: (id: string) => string) =>
  v.kind === 'home' ? (v.hostId ? `${name(v.hostId)}’s home` : 'a home') : v.kind === 'store' ? 'a store' : 'a venue';

/** A venue's name, what it is, and its address when the party may see it. */
export function VenueLine({ venue, name, note }: { venue: Venue; name: (id: string) => string; note?: string }) {
  return (
    <span className="hs-board-venue">
      <span className="hs-board-venue-name">{venue.name}</span>
      <span className="hs-board-venue-sub">{[venueKind(venue, name), note].filter(Boolean).join(' · ')}</span>
      {venue.address && <span className="hs-board-venue-sub">{venue.address}</span>}
    </span>
  );
}

/**
 * The venue step (#92), in person, once the night is set: the vote opens
 * with the campaign's recent venues; anyone can suggest another (say, to
 * host), and each player picks one. Most votes wins; a tie goes to the GM.
 * Re-shortlisting the venues is the GM's, on the campaign's Notice Board
 * (#225): the campaign's saved venues as a checklist; the Hearth links there.
 */
export default function VenueStep({ state, busy, act, onCampaignPage = false }: {
  state: PlanningState;
  busy: boolean;
  act: Act;
  /** On the campaign's own Notice Board: the GM re-shortlists here. */
  onCampaignPage?: boolean;
}) {
  const { venue: poll, viewer, campaign } = state;
  const gm = viewer.isGameMaster;
  const name = nameIn(state);
  const open = poll?.status === 'open';
  const tie = poll?.status === 'closed' && poll.result === 'tie';
  const eligible = !!poll?.eligibleIds.includes(viewer.id);
  const mine = poll?.options.find((o) => o.approvals.includes(viewer.id))?.id ?? null;
  const [pick, setPick] = useState<string | null>(mine);
  useEffect(() => setPick(mine), [mine]);
  const [suggesting, setSuggesting] = useState(false);
  /** The venues ticked while the GM re-shortlists; null when they aren't. */
  const [reshortlist, setReshortlist] = useState<Set<string> | null>(null);
  const radios = useId();
  const waiting = waitingOn(poll).map(name);
  const who = (id: string) => (id === viewer.id ? 'you' : name(id));

  const rows = (ids?: string[]) => voteTally(poll!, name, viewer.id).filter((r) => !ids || ids.includes(r.id));

  return (
    <>
      {open && (
        <form onSubmit={(e) => { e.preventDefault(); if (pick) act('vote', { optionIds: [pick] }); }}>
          {poll!.options.length === 0 ? (
            <p className="hs-board-line">No venues yet. {gm ? 'Add one, or wait for a suggestion.' : 'Suggest one: say, if you can host.'}</p>
          ) : (
            <>
              <p className="hs-board-line">{eligible ? 'Pick one. Most votes wins.' : 'The party is picking one of these.'}</p>
              <VoteTally
                label="The venues"
                items={rows().map((row) => {
                  const o = poll!.options.find((x) => x.id === row.id)!;
                  const line = o.venue
                    ? <VenueLine venue={o.venue} name={name} note={o.suggestedBy ? `suggested by ${who(o.suggestedBy)}` : 'recent'} />
                    : 'A venue';
                  return {
                    row,
                    label: eligible ? (
                      <label className="hs-board-pick">
                        <input type="radio" name={radios} checked={pick === o.id} onChange={() => setPick(o.id)} aria-label={`Pick ${o.venue?.name ?? 'this venue'}`} />
                        {line}
                      </label>
                    ) : line,
                    count: `${row.count} ${row.count === 1 ? 'vote' : 'votes'}`,
                    note: row.voters.join(', ') || undefined,
                  };
                })}
              />
            </>
          )}
          <p className="hs-board-fine">Closes when everyone has voted{waiting.length ? ` · waiting on ${waiting.join(', ')}` : ''}</p>
          <div className="hs-btn-row">
            {eligible && poll!.options.length > 0 && (
              <button type="submit" className="hs-btn is-primary" disabled={busy || !pick || pick === mine}>{mine ? 'Change my vote' : 'Vote'}</button>
            )}
            {!suggesting && (
              <button type="button" className="hs-btn" onClick={() => { setSuggesting(true); setReshortlist(null); }}>{gm ? 'Add a venue' : 'Suggest a venue'}</button>
            )}
            {gm && (
              <button type="button" className="hs-btn" disabled={busy || poll!.options.length === 0} onClick={() => act('advance')}>Move forward now</button>
            )}
            {gm && onCampaignPage && state.venues.length > 0 && (
              <button type="button" className="hs-btn" aria-expanded={!!reshortlist} disabled={busy}
                onClick={() => { setSuggesting(false); setReshortlist((r) => (r ? null : new Set(poll!.options.flatMap((o) => (o.venueId ? [o.venueId] : []))))); }}>
                Re-shortlist
              </button>
            )}
          </div>
          {mine && <p className="hs-board-done" role="status">You’ve voted. You can change it until the vote closes.</p>}
        </form>
      )}

      {open && suggesting && (
        <SuggestVenue state={state} busy={busy} submit={(body) => act('suggest-venue', body)} onDone={() => setSuggesting(false)} />
      )}

      {tie && (
        <>
          <p className="hs-board-line">The vote tied. {gm ? 'Pick the venue:' : `The ${campaign.gmTitle} will pick between:`}</p>
          <VoteTally
            label="The tied venues"
            items={rows(poll!.tiedOptionIds).map((row) => {
              const o = poll!.options.find((x) => x.id === row.id)!;
              return {
                row,
                label: o.venue ? <VenueLine venue={o.venue} name={name} /> : 'A venue',
                count: `${row.count} ${row.count === 1 ? 'vote' : 'votes'}`,
                action: gm && (
                  <button type="button" className="hs-btn" disabled={busy} onClick={() => act('tiebreak', { optionId: o.id })}>Pick this venue</button>
                ),
              };
            })}
          />
          {gm && !onCampaignPage && (
            <p className="hs-board-fine">
              Or shortlist again: <Link className="hs-sess-link" href={`/campaigns/${campaign.id}#notice-board`}>on the campaign’s Notice Board →</Link>
            </p>
          )}
          {gm && onCampaignPage && !reshortlist && (
            <div className="hs-btn-row"><button type="button" className="hs-btn" onClick={() => setReshortlist(new Set())}>Or shortlist again</button></div>
          )}
        </>
      )}

      {gm && onCampaignPage && reshortlist && (open || tie) && (
        <VenueShortlist state={state} busy={busy} open={open} chosen={reshortlist} onChange={setReshortlist}
          submit={async (venueIds) => { if (await act(open ? 'reshortlist' : 'shortlist', { venueIds })) setReshortlist(null); }}
          onDone={() => setReshortlist(null)} />
      )}

      {!open && !tie && <p className="hs-board-line">The {campaign.gmTitle} is putting some venues to the party.</p>}
    </>
  );
}

/** Suggest a venue for the open vote: one of the campaign's, or somewhere new (the GM can name any host). */
function SuggestVenue({ state, busy, submit, onDone }: {
  state: PlanningState; busy: boolean; submit: (body: unknown) => Promise<boolean>; onDone: () => void;
}) {
  const gm = state.viewer.isGameMaster;
  const name = nameIn(state);
  const onVote = new Set(state.venue?.options.map((o) => o.venueId) ?? []);
  const saved = state.venues.filter((v) => !onVote.has(v.id));
  const [mode, setMode] = useState<'saved' | 'new'>(saved.length ? 'saved' : 'new');
  const [venueId, setVenueId] = useState(saved[0]?.id ?? '');
  // A home's host must be in the party; a stand-in GM or an admin may not be.
  const defaultHost = state.party.some((p) => p.id === state.viewer.id) ? state.viewer.id : state.party[0]?.id ?? '';
  const [draft, setDraft] = useState({ name: '', address: '', kind: 'other' as Venue['kind'], hostId: defaultHost });
  const id = useId();

  const send = async (e: React.FormEvent) => {
    e.preventDefault();
    const body = mode === 'saved' ? { venueId }
      : { name: draft.name, address: draft.address, kind: draft.kind, ...(draft.kind === 'home' && gm ? { hostId: draft.hostId } : {}) };
    if (await submit(body)) onDone();
  };

  return (
    <form className="hs-board-form" onSubmit={send} aria-label={gm ? 'Add a venue' : 'Suggest a venue'}>
      {saved.length > 0 && (
        <div className="hs-board-choice" role="radiogroup" aria-label="Which venue">
          <label><input type="radio" name={`${id}-mode`} checked={mode === 'saved'} onChange={() => setMode('saved')} /> One of ours</label>
          <label><input type="radio" name={`${id}-mode`} checked={mode === 'new'} onChange={() => setMode('new')} /> Somewhere new</label>
        </div>
      )}
      {mode === 'saved' ? (
        <select className="hs-paper-input" value={venueId} onChange={(e) => setVenueId(e.target.value)} aria-label="Saved venue">
          {saved.map((v) => <option key={v.id} value={v.id}>{v.name} ({venueKind(v, name)})</option>)}
        </select>
      ) : (
        <>
          <input className="hs-paper-input" required maxLength={120} value={draft.name} placeholder="Name"
            aria-label="Venue name" onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
          <input className="hs-paper-input" maxLength={300} value={draft.address} placeholder="Address (only the party sees it)"
            aria-label="Address" onChange={(e) => setDraft({ ...draft, address: e.target.value })} />
          <div className="hs-board-row">
            <select className="hs-paper-input" value={draft.kind} aria-label="Kind of venue"
              onChange={(e) => setDraft({ ...draft, kind: e.target.value as Venue['kind'] })}>
              <option value="home">{gm ? 'Someone’s home' : 'My home (I’ll host)'}</option>
              <option value="store">A store</option>
              <option value="other">Somewhere else</option>
            </select>
            {gm && draft.kind === 'home' && (
              <select className="hs-paper-input" value={draft.hostId} aria-label="Host" onChange={(e) => setDraft({ ...draft, hostId: e.target.value })}>
                {state.party.map((p) => <option key={p.id} value={p.id}>{p.id === state.viewer.id ? 'Me' : p.name}</option>)}
              </select>
            )}
          </div>
        </>
      )}
      <div className="hs-btn-row">
        <button type="submit" className="hs-btn is-primary" disabled={busy || (mode === 'saved' ? !venueId : !draft.name.trim())}>
          {gm ? 'Add to the vote' : 'Suggest it'}
        </button>
        <button type="button" className="hs-btn" onClick={onDone}>Never mind</button>
      </div>
    </form>
  );
}

const DAY_Y = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
/** At most this many venues go to one vote (the server's limit). */
const MAX_VENUES = 6;

/** The GM puts some of the campaign's saved venues to the party: a new round of the venue vote. */
function VenueShortlist({ state, busy, open, chosen, onChange, submit, onDone }: {
  state: PlanningState;
  busy: boolean;
  /** A vote is open: its votes are discarded. */
  open: boolean;
  chosen: Set<string>;
  onChange: (next: Set<string>) => void;
  submit: (venueIds: string[]) => void;
  onDone: () => void;
}) {
  const name = nameIn(state);
  const toggle = (id: string, on: boolean) => {
    const next = new Set(chosen);
    if (on) next.add(id); else next.delete(id);
    onChange(next);
  };
  return (
    <form className="hs-board-form" aria-label="Shortlist venues" onSubmit={(e) => { e.preventDefault(); submit([...chosen]); }}>
      <p className="hs-board-line">Put these to the party{open ? ' (this round’s votes are discarded)' : ''}:</p>
      <ul className="hs-board-checks">
        {state.venues.map((v) => (
          <li key={v.id}>
            <label className="hs-board-pick">
              <input type="checkbox" checked={chosen.has(v.id)} onChange={(e) => toggle(v.id, e.target.checked)} aria-label={`Shortlist ${v.name}`} />
              <VenueLine venue={v} name={name} note={v.lastUsedAt ? `last used ${DAY_Y.format(new Date(v.lastUsedAt))}` : 'new'} />
            </label>
          </li>
        ))}
      </ul>
      <div className="hs-btn-row">
        <button type="submit" className="hs-btn is-primary" disabled={busy || chosen.size === 0 || chosen.size > MAX_VENUES}>
          Send {chosen.size || ''} to the party
        </button>
        <button type="button" className="hs-btn" onClick={onDone}>Never mind</button>
      </div>
    </form>
  );
}
