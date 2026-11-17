"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, errorOf } from './api';
import { campaignThreadKey, getLiveClient } from './letters';
import type { Board } from './noticeBoard';

/** How long to wait for more `noticeboard.changed` frames before reading again: one action can send several. */
const LIVE_REFETCH_MS = 250;

/** A campaign's board: loaded, or the reason it couldn't be. Missing while it's first loading. */
export type BoardResult = { board: Board } | { error: string };

/**
 * The Notice Boards of some campaigns (#222): `GET /api/planning/campaigns/:id`
 * for each, kept current. Pass null to wait (say, for the campaign list).
 *
 * Live: when anyone in a campaign's party acts (votes, moves a step on,
 * claims a slot, starts or cancels planning), the live channel sends
 * `noticeboard.changed` on that campaign's thread, and its board is read
 * again; after a reconnect too, since nothing is replayed. A slower read
 * never overwrites a newer one.
 *
 * `reload(campaignId)` reads one board now: a sheet calls it after its own
 * action, rather than waiting for the live frame.
 */
export function useNoticeBoards(campaignIds: readonly string[] | null) {
  const key = campaignIds ? campaignIds.join(',') : null;
  const ids = useMemo(() => (key ? key.split(',') : key === '' ? [] : null), [key]);
  const [results, setResults] = useState<Record<string, BoardResult>>({});
  /** Bumped per request, per campaign. */
  const latest = useRef<Record<string, number>>({});

  const reload = useCallback(async (campaignId: string) => {
    const seq = (latest.current[campaignId] ?? 0) + 1;
    latest.current[campaignId] = seq;
    let result: BoardResult;
    try {
      result = { board: await api.get<Board>(`/api/planning/campaigns/${encodeURIComponent(campaignId)}`) };
    } catch (err) {
      result = { error: errorOf(err, 'The Notice Board couldn’t be read.') };
    }
    if (latest.current[campaignId] !== seq) return;
    setResults((prev) => ({ ...prev, [campaignId]: result }));
  }, []);

  useEffect(() => {
    if (!ids) return;
    // Forget campaigns no longer asked for, and read the rest.
    setResults((prev) => Object.fromEntries(Object.entries(prev).filter(([id]) => ids.includes(id))));
    for (const id of ids) reload(id);
  }, [ids, reload]);

  useEffect(() => {
    if (!ids?.length) return;
    const live = getLiveClient();
    const timers = new Map<string, ReturnType<typeof setTimeout>>();
    const soon = (id: string) => () => {
      clearTimeout(timers.get(id));
      timers.set(id, setTimeout(() => { timers.delete(id); reload(id); }, LIVE_REFETCH_MS));
    };
    const unsubscribes = ids.map((id) => live.subscribe(campaignThreadKey(id), { onNoticeBoard: soon(id), onReconnect: soon(id) }));
    return () => {
      for (const off of unsubscribes) off();
      for (const t of timers.values()) clearTimeout(t);
    };
  }, [ids, reload]);

  const ready = !!ids && ids.every((id) => id in results);
  return {
    /** Each campaign's board, in the order asked, once read; null if it couldn't be. */
    boards: ids ? ids.map((id) => { const r = results[id]; return r && 'board' in r ? r.board : null; }) : [],
    /** Every board has been read (or failed) at least once. */
    ready,
    /** Why each board that failed couldn't be read, by campaign id. */
    errors: Object.fromEntries(Object.entries(results).flatMap(([id, r]) => ('error' in r ? [[id, r.error]] : []))) as Record<string, string>,
    reload,
  };
}

/** One campaign's Notice Board (#225's campaign page): its board, or null until read; `error` if it couldn't be. */
export function useNoticeBoard(campaignId: string | null) {
  const ids = useMemo(() => (campaignId ? [campaignId] : null), [campaignId]);
  const { boards, ready, errors, reload } = useNoticeBoards(ids);
  const reloadThis = useCallback(() => (campaignId ? reload(campaignId) : Promise.resolve()), [campaignId, reload]);
  return { board: boards[0] ?? null, ready, error: campaignId ? errors[campaignId] ?? null : null, reload: reloadThis };
}
