"use client";

import Link from 'next/link';
import { useState, type FormEvent } from 'react';
import { ApiError } from '@gtd/shared/api';
import SignInPage, { SignInForm } from '@/components/auth/SignInPage';
import { api, errorOf } from '@/lib/api';

/**
 * Ask for a password reset (#219). The link comes back to Hearthside's
 * /reset-password (#215). The reply is the same whether or not the email has
 * an account, so the page never says which.
 */
export default function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState('');

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api.post('/api/users/forgot-password', { email: email.trim() });
      setSent(true);
    } catch (err) {
      // The backend answers 404 for an email with no account; the page doesn't say so.
      if (err instanceof ApiError && err.status === 404) setSent(true);
      else setError(errorOf(err, 'We couldn’t send the reset link. Try again.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <SignInPage title="Forgot your password?" intro="We’ll email you a link to set a new one.">
      {sent ? (
        <div className="hs-form">
          <p className="hs-dialog-text" role="status">
            If an account goes by {email.trim()}, a reset link is on its way. It works for an hour.
          </p>
          <div className="hs-signin-actions">
            <Link href="/login" className="hs-btn-amber hs-signin-btn">Back to sign in</Link>
          </div>
        </div>
      ) : (
        <SignInForm onSubmit={submit}>
          <label className="hs-field"><span>Email</span>
            <input className="hs-input" type="email" name="email" autoComplete="email" required
              value={email} onChange={(e) => setEmail(e.target.value)} />
          </label>
          {error && <p className="hs-alert" role="alert">{error}</p>}
          <div className="hs-signin-actions">
            <button type="submit" className="hs-btn-amber" disabled={busy}>{busy ? 'Sending…' : 'Send the link'}</button>
            <Link href="/login" className="hs-signin-link">Back to sign in</Link>
          </div>
        </SignInForm>
      )}
    </SignInPage>
  );
}
