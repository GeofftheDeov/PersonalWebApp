"use client";

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState, type FormEvent } from 'react';
import { ApiError } from '@gtd/shared/api';
import GoogleButton from '@/components/auth/GoogleButton';
import SignInPage, { SignInForm } from '@/components/auth/SignInPage';
import { errorOf } from '@/lib/api';
import { session, useSession } from '@/lib/session';
import { returnTarget, withReturn } from '@/lib/signIn';

/**
 * Sign in (#219). Comes back to `?redirect=`, a path on this site, or the
 * Hearth; someone already signed in (on either site: the cookie is shared)
 * goes straight there.
 */
function LoginForm() {
  const router = useRouter();
  const target = returnTarget(useSearchParams()?.toString() ?? '');
  const { status } = useSession();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [needsReset, setNeedsReset] = useState(false);

  // Signed in, by this form, Google, or already: on to where they were going.
  useEffect(() => {
    if (status === 'signedIn') router.replace(target);
  }, [status, target, router]);

  const fail = (err: unknown, fallback: string) => {
    const body = err instanceof ApiError ? (err.body as { requiresReset?: boolean; message?: string } | undefined) : undefined;
    if (err instanceof ApiError && err.status === 403 && body?.requiresReset) {
      setNeedsReset(true);
      setError(body.message || 'This account has no password yet. Set one to sign in.');
    } else if (err instanceof ApiError && err.status === 401) {
      setError('That email and password don’t match an account.');
    } else {
      setError(err instanceof ApiError ? errorOf(err, fallback) : (err as Error)?.message || fallback);
    }
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    setNeedsReset(false);
    try {
      // The session cookie carries the login (both sites); nothing is stored here.
      await session.login(email.trim(), password);
    } catch (err) {
      fail(err, 'Signing in failed. Try again.');
    } finally {
      setBusy(false);
    }
  };

  const google = async (idToken: string) => {
    setBusy(true);
    setError('');
    try {
      await session.loginWithGoogle(idToken);
    } catch (err) {
      fail(err, 'Google sign-in failed. Try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <SignInPage title="Sign in" intro="Take your seat at the table.">
      <SignInForm onSubmit={submit}>
        <label className="hs-field"><span>Email</span>
          <input className="hs-input" type="email" name="email" autoComplete="email" required
            value={email} onChange={(e) => setEmail(e.target.value)} />
        </label>
        <label className="hs-field"><span>Password</span>
          <input className="hs-input" type="password" name="password" autoComplete="current-password" required
            value={password} onChange={(e) => setPassword(e.target.value)} />
        </label>
        {error && (
          <p className="hs-alert" role="alert">
            {error}{needsReset && <> <Link href="/forgot-password">Set a password</Link></>}
          </p>
        )}
        <div className="hs-signin-actions">
          <button type="submit" className="hs-btn-amber" disabled={busy || status === 'signedIn'}>
            {busy ? 'Signing in…' : 'Sign in'}
          </button>
          <Link href="/forgot-password" className="hs-signin-link">Forgot your password?</Link>
        </div>
      </SignInForm>
      <GoogleButton onCredential={google} />
      <p className="hs-signin-foot">
        New to the table? <Link href={withReturn('/signup', target)}>Create an account</Link>
      </p>
    </SignInPage>
  );
}

export default function LoginPage() {
  return <Suspense><LoginForm /></Suspense>;
}
