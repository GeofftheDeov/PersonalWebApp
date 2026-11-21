"use client";

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useState } from 'react';
import SignInPage from '@/components/auth/SignInPage';
import CampaignBanner from '@/components/campaigns/CampaignBanner';
import StatusPill from '@/components/campaigns/StatusPill';
import { errorOf } from '@/lib/api';
import { hasSeat, inviterName, joinPath, partyCount } from '@/lib/invite';
import { withReturn } from '@/lib/signIn';
import { useInvite } from '@/lib/useInvite';

const SUMMONS = 'A summons for the party';

/**
 * A campaign invite (#232, spec #69): `/join/:id`, `:id` being the campaign's
 * id. Under the top bar, on the floor without the rail or Letters, like the
 * signing-in pages: the campaign's banner (or its dyed cloth) and name above
 * Accept and Decline. Signed out, it offers signing in or up, and both come
 * back here. Accepting lands on the campaign's page.
 */
export default function JoinPage() {
  const params = useParams();
  const id = String(params?.id ?? '');
  // A fresh page per campaign, so nothing (a declined summons, an error) carries over.
  return <Invite key={id} id={id} />;
}

function Invite({ id }: { id: string }) {
  const router = useRouter();
  const { state, viewerId, reload, accept, decline } = useInvite(id);
  const [busy, setBusy] = useState<'accept' | 'decline' | null>(null);
  const [declined, setDeclined] = useState(false);
  const [error, setError] = useState('');

  if (state.status === 'loading') {
    return (
      <SignInPage title={SUMMONS}>
        <p className="hs-dialog-text" role="status">Unrolling the summons…</p>
      </SignInPage>
    );
  }

  if (state.status === 'signedOut') {
    const back = joinPath(id);
    return (
      <SignInPage kicker={SUMMONS} title="You’re called to the table" intro="Sign in to see which campaign, and answer.">
        <div className="hs-form">
          <div className="hs-signin-actions">
            <Link href={withReturn('/login', back)} className="hs-btn-amber hs-signin-btn">Sign in</Link>
            <Link href={withReturn('/signup', back)} className="hs-signin-link">New here? Create an account</Link>
          </div>
        </div>
      </SignInPage>
    );
  }

  if (state.status === 'missing') {
    return (
      <SignInPage title="This summons has faded">
        <div className="hs-form">
          <p className="hs-dialog-text">There&rsquo;s no campaign at this link. Ask whoever sent it for a fresh one.</p>
          <div className="hs-signin-actions">
            <Link href="/" className="hs-btn-amber hs-signin-btn">Back to the Hearth</Link>
          </div>
        </div>
      </SignInPage>
    );
  }

  if (state.status === 'error') {
    return (
      <SignInPage title={SUMMONS}>
        <div className="hs-form">
          <p className="hs-alert" role="alert">{state.error}</p>
          <div className="hs-signin-actions">
            <button type="button" className="hs-btn-amber" onClick={reload}>Try again</button>
          </div>
        </div>
      </SignInPage>
    );
  }

  const { campaign, invite, members } = state;
  const from = inviterName(invite);
  const count = partyCount(members);
  const seated = hasSeat(members, viewerId);

  const onAccept = async () => {
    setBusy('accept');
    setError('');
    try {
      await accept();
      router.replace(`/campaigns/${encodeURIComponent(id)}`);
    } catch (err) {
      setError(errorOf(err, 'Your seat couldn’t be taken. Try again.'));
      setBusy(null);
    }
  };

  const onDecline = async () => {
    setBusy('decline');
    setError('');
    try {
      await decline();
      setDeclined(true);
    } catch (err) {
      setError(errorOf(err, 'The summons couldn’t be declined. Try again.'));
    } finally {
      setBusy(null);
    }
  };

  return (
    <SignInPage
      kicker={SUMMONS}
      title={campaign.title}
      banner={<CampaignBanner id={campaign._id} title={campaign.title} url={campaign.bannerUrl} />}
    >
      <div className="hs-form">
        <div className="hs-join-meta">
          <StatusPill status={campaign.status} />
          {from && <span>Sent by {from}</span>}
          {count && <span>{count}</span>}
        </div>
        {campaign.description && <p className="hs-join-desc">{campaign.description}</p>}

        {seated ? (
          <>
            <p className="hs-dialog-text" role="status">You already have a seat at this table.</p>
            <div className="hs-signin-actions">
              <Link href={`/campaigns/${encodeURIComponent(id)}`} className="hs-btn-amber hs-signin-btn">Go to the campaign</Link>
            </div>
          </>
        ) : declined ? (
          <>
            <p className="hs-dialog-text" role="status">You&rsquo;ve declined the summons.</p>
            <p className="hs-fine">Change your mind and this link still works.</p>
            <div className="hs-signin-actions">
              <Link href="/" className="hs-btn-amber hs-signin-btn">Back to the Hearth</Link>
            </div>
          </>
        ) : (
          <>
            <p className="hs-dialog-text">
              {from ? `${from} calls you to their table.` : 'You’re called to this table.'} Will you take a seat?
            </p>
            {error && <p className="hs-alert" role="alert">{error}</p>}
            <div className="hs-signin-actions hs-join-acts">
              <button type="button" className="hs-btn-amber" disabled={!!busy} onClick={onAccept}>
                {busy === 'accept' ? 'Taking your seat…' : 'Accept'}
              </button>
              <button type="button" className="hs-ghost" disabled={!!busy} onClick={onDecline}>
                {busy === 'decline' ? 'Declining…' : 'Decline'}
              </button>
            </div>
          </>
        )}
      </div>
    </SignInPage>
  );
}
