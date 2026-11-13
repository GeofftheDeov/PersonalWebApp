"use client";

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import SignInPage from '@/components/auth/SignInPage';
import { api, errorOf } from '@/lib/api';
import { session } from '@/lib/session';
import { browserStorage, takeReturn, withReturn } from '@/lib/signIn';

type Outcome =
  | { kind: 'checking' }
  /** Verified, and signed in: this is the browser that signed up (#219). */
  | { kind: 'signedIn'; next: string }
  /** Verified; signing in is next. Another browser, or a link over a day old. */
  | { kind: 'verified'; next: string }
  | { kind: 'failed'; message: string };

/** How long the result shows before the page moves on by itself. */
const MOVE_ON_MS = 2500;

/**
 * Each link is posted once per page load, whatever mounts the page (React's
 * development double mount, a remount): the link works once, and a second post
 * would answer "invalid".
 */
const verifying = new Map<string, Promise<Outcome>>();
function verifyOnce(token: string): Promise<Outcome> {
  let outcome = verifying.get(token);
  if (!outcome) {
    outcome = (async (): Promise<Outcome> => {
      try {
        const reply = await api.post<{ message?: string; user?: unknown }>('/api/users/verify-email', { token });
        const back = takeReturn(browserStorage());
        const signedIn = !!reply?.user
          && (await session.refresh().catch(() => session.getState())).status === 'signedIn';
        return signedIn ? { kind: 'signedIn', next: back } : { kind: 'verified', next: withReturn('/login', back) };
      } catch (err) {
        return { kind: 'failed', message: errorOf(err, 'We couldn’t verify your email.') };
      }
    })();
    verifying.set(token, outcome);
  }
  return outcome;
}

/**
 * The verify link from the signup email lands here (#215, #219). The backend
 * verifies the email either way. It also signs the player in, on both sites,
 * but only in the browser that signed up (its signup cookie) and within the
 * day: then the reply carries `user`. Otherwise the reply is just the message,
 * and the page sends the player to sign in. Either way they go on to where
 * they signed up from (an invite, say), kept by the signup page.
 */
function VerifyEmail() {
  const router = useRouter();
  const token = useSearchParams()?.get('token') ?? '';
  const [outcome, setOutcome] = useState<Outcome>({ kind: 'checking' });

  useEffect(() => {
    if (!token) {
      setOutcome({ kind: 'failed', message: 'This link has no token. Use the link in your email as it is.' });
      return;
    }
    let live = true;
    verifyOnce(token).then((o) => { if (live) setOutcome(o); });
    return () => { live = false; };
  }, [token]);

  useEffect(() => {
    if (outcome.kind !== 'signedIn' && outcome.kind !== 'verified') return;
    const t = setTimeout(() => router.replace(outcome.next), MOVE_ON_MS);
    return () => clearTimeout(t);
  }, [outcome, router]);

  if (outcome.kind === 'checking') {
    return (
      <SignInPage title="Checking your link">
        <p className="hs-dialog-text" role="status">One moment while we check your email…</p>
      </SignInPage>
    );
  }
  if (outcome.kind === 'signedIn') {
    return (
      <SignInPage title="Welcome to the table">
        <div className="hs-form">
          <p className="hs-dialog-text" role="status">Your email is confirmed, and you&rsquo;re signed in.</p>
          <div className="hs-signin-actions">
            <Link href={outcome.next} replace className="hs-btn-amber hs-signin-btn">Continue</Link>
          </div>
        </div>
      </SignInPage>
    );
  }
  if (outcome.kind === 'verified') {
    return (
      <SignInPage title="Email confirmed">
        <div className="hs-form">
          <p className="hs-dialog-text" role="status">Your email is confirmed. Sign in to take your seat.</p>
          <div className="hs-signin-actions">
            <Link href={outcome.next} replace className="hs-btn-amber hs-signin-btn">Sign in</Link>
          </div>
        </div>
      </SignInPage>
    );
  }
  return (
    <SignInPage title="That link didn’t work">
      <div className="hs-form">
        <p className="hs-alert" role="alert">{outcome.message}</p>
        <p className="hs-fine">
          A verify link works once. If you&rsquo;ve used it already, your email is confirmed: sign in.
        </p>
        <div className="hs-signin-actions">
          <Link href="/login" className="hs-btn-amber hs-signin-btn">Sign in</Link>
          <Link href="/signup" className="hs-signin-link">Sign up again</Link>
        </div>
      </div>
    </SignInPage>
  );
}

export default function VerifyEmailPage() {
  return <Suspense><VerifyEmail /></Suspense>;
}
