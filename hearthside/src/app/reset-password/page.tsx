"use client";

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState, type FormEvent } from 'react';
import SignInPage, { SignInForm } from '@/components/auth/SignInPage';
import { api, errorOf } from '@/lib/api';

/**
 * Set a new password from the reset email's link (#215, #219). It doesn't
 * sign in: the player signs in next with the new password.
 */
function ResetPassword() {
  const router = useRouter();
  const token = useSearchParams()?.get('token') ?? '';
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState('');
  /** The server refused the link: offer a new one. */
  const [stale, setStale] = useState(false);

  useEffect(() => {
    if (!done) return;
    const t = setTimeout(() => router.replace('/login'), 2500);
    return () => clearTimeout(t);
  }, [done, router]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    setStale(false);
    if (password !== confirm) {
      setError('The two passwords don’t match.');
      return;
    }
    setBusy(true);
    try {
      await api.post('/api/users/reset-password', { token, newPassword: password });
      setDone(true);
    } catch (err) {
      setError(errorOf(err, 'We couldn’t set your password.'));
      setStale(true);
    } finally {
      setBusy(false);
    }
  };

  if (!token) {
    return (
      <SignInPage title="That link didn’t work">
        <div className="hs-form">
          <p className="hs-alert" role="alert">This reset link is missing its token.</p>
          <div className="hs-signin-actions">
            <Link href="/forgot-password" className="hs-btn-amber hs-signin-btn">Send a new link</Link>
          </div>
        </div>
      </SignInPage>
    );
  }

  if (done) {
    return (
      <SignInPage title="Password set">
        <div className="hs-form">
          <p className="hs-dialog-text" role="status">Your new password is set. Sign in with it.</p>
          <div className="hs-signin-actions">
            <Link href="/login" replace className="hs-btn-amber hs-signin-btn">Sign in</Link>
          </div>
        </div>
      </SignInPage>
    );
  }

  return (
    <SignInPage title="Set a new password">
      <SignInForm onSubmit={submit}>
        <label className="hs-field"><span>New password</span>
          <input className="hs-input" type="password" name="password" autoComplete="new-password" required
            value={password} onChange={(e) => setPassword(e.target.value)} />
        </label>
        <label className="hs-field"><span>The same again</span>
          <input className="hs-input" type="password" name="confirm" autoComplete="new-password" required
            value={confirm} onChange={(e) => setConfirm(e.target.value)} />
        </label>
        {error && (
          <p className="hs-alert" role="alert">
            {error}{stale && <> <Link href="/forgot-password">Send a new link</Link></>}
          </p>
        )}
        <div className="hs-signin-actions">
          <button type="submit" className="hs-btn-amber" disabled={busy}>{busy ? 'Saving…' : 'Set my password'}</button>
        </div>
      </SignInForm>
    </SignInPage>
  );
}

export default function ResetPasswordPage() {
  return <Suspense><ResetPassword /></Suspense>;
}
