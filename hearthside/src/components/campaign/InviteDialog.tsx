"use client";

import { useEffect, useRef, useState } from 'react';
import GildedDialog from '@/components/GildedDialog';
import { api, errorOf, getOrNull } from '@/lib/api';
import { inviteLink } from '@/lib/campaignPage';

/** A friend as `GET /api/friends/list` sends them (the public fields). */
interface Friend {
  _id: string;
  handle?: string | null;
  name?: string | null;
  userNumber?: number | string | null;
}

type Sent = 'sending' | 'sent' | { error: string };

/**
 * Inviting players, in a gilded dialog (#224): the campaign's invite link to
 * copy (Hearthside's `/join/:id`, #232), or a friend invited directly
 * (`POST /api/campaign-invites {campaignId, toUserId}`), which rings their bell.
 */
export default function InviteDialog({ campaignId, onClose }: { campaignId: string; onClose: () => void }) {
  const [friends, setFriends] = useState<Friend[] | null>(null);
  const [sent, setSent] = useState<Record<string, Sent>>({});
  const [copied, setCopied] = useState(false);
  const link = typeof window === 'undefined' ? '' : inviteLink(window.location.origin, campaignId);
  const linkRef = useRef<HTMLInputElement>(null);
  const copiedTimer = useRef<ReturnType<typeof setTimeout>>();

  useEffect(() => {
    getOrNull<Friend[]>('/api/friends/list').then((list) => setFriends(list ?? []));
    return () => clearTimeout(copiedTimer.current);
  }, []);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(link);
    } catch {
      // No clipboard (an insecure page, or refused): select it, so it's one keystroke to copy.
      linkRef.current?.select();
      return;
    }
    setCopied(true);
    clearTimeout(copiedTimer.current);
    copiedTimer.current = setTimeout(() => setCopied(false), 2000);
  };

  const invite = async (friend: Friend) => {
    setSent((s) => ({ ...s, [friend._id]: 'sending' }));
    try {
      await api.post('/api/campaign-invites', { campaignId, toUserId: friend._id });
      setSent((s) => ({ ...s, [friend._id]: 'sent' }));
    } catch (err) {
      setSent((s) => ({ ...s, [friend._id]: { error: errorOf(err, 'The invite couldn’t be sent.') } }));
    }
  };

  return (
    <GildedDialog title="Invite players" onClose={onClose}>
      <div className="hs-form">
        <p className="hs-fine">Share this link and they can join the campaign.</p>
        <div className="hs-cp-copy">
          <input ref={linkRef} className="hs-input" readOnly value={link} aria-label="Invite link" onFocus={(e) => e.target.select()} />
          <button type="button" className="hs-btn-amber" onClick={copy}>{copied ? 'Copied' : 'Copy link'}</button>
        </div>

        <fieldset className="hs-cp-group">
          <legend>Or invite a friend</legend>
          {friends === null ? (
            <p className="hs-fine">Fetching your friends…</p>
          ) : friends.length === 0 ? (
            <p className="hs-fine">No friends yet. Add some from the social menu in the top bar.</p>
          ) : (
            <ul className="hs-cp-friends" aria-label="Your friends">
              {friends.map((f) => {
                const s = sent[f._id];
                const who = f.handle ? `@${f.handle}` : f.name || 'A friend';
                return (
                  <li key={f._id}>
                    <div className="hs-cp-friend">
                      <div className="hs-cp-name">{who}</div>
                      {f.userNumber != null && <div className="hs-fine">#{f.userNumber}</div>}
                      {s && typeof s === 'object' && <p className="hs-alert" role="alert">{s.error}</p>}
                    </div>
                    <button
                      type="button"
                      className={s === 'sent' ? 'hs-ghost' : 'hs-btn-amber'}
                      disabled={s === 'sending' || s === 'sent'}
                      aria-label={s === 'sent' ? `${who} invited` : `Invite ${who}`}
                      onClick={() => invite(f)}
                    >
                      {s === 'sent' ? 'Invited' : s === 'sending' ? 'Sending…' : 'Invite'}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </fieldset>
      </div>
    </GildedDialog>
  );
}
