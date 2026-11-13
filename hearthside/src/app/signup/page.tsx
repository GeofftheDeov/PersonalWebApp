"use client";

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState, type FormEvent } from 'react';
import { ApiError } from '@gtd/shared/api';
import GoogleButton from '@/components/auth/GoogleButton';
import SignInPage from '@/components/auth/SignInPage';
import { api, errorOf } from '@/lib/api';
import { session, useSession } from '@/lib/session';
import { browserStorage, rememberReturn, returnTarget, withReturn } from '@/lib/signIn';

/**
 * Create an account on Hearthside (#219), without ever visiting the
 * portfolio. Signing up doesn't sign in: the email gets a verify link back to
 * this site (#215), and following it in this browser signs the player in
 * (the backend's signup cookie, #219). The return URL is kept for the verify
 * page, so a signup from an invite comes back to it.
 */
function SignupForm() {
  const router = useRouter();
  const target = returnTarget(useSearchParams()?.toString() ?? '');
  const { status } = useSession();
  const [form, setForm] = useState({ name: '', email: '', password: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (status === 'signedIn') router.replace(target);
  }, [status, target, router]);

  const set = (key: keyof typeof form) => (e: { target: { value: string } }) =>
    setForm((f) => ({ ...f, [key]: e.target.value }));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api.post('/api/users/register', { name: form.name.trim(), email: form.email.trim(), password: form.password });
      rememberReturn(browserStorage(), target);
      router.push('/check-email');
    } catch (err) {
      setError(errorOf(err, 'We couldn’t create your account. Try again.'));
      setBusy(false);
    }
  };

  const google = async (idToken: string) => {
    setBusy(true);
    setError('');
    try {
      // Google's email is already verified: this signs in, creating the account if it's new.
      await session.loginWithGoogle(idToken);
    } catch (err) {
      setError(err instanceof ApiError ? errorOf(err, 'Google sign-up failed. Try again.') : 'Google sign-up failed. Try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <SignInPage title="Join the party" intro="Make an account, then follow the link we email you.">
      <form className="hs-form" onSubmit={submit}>
        <label className="hs-field"><span>Your name</span>
          <input className="hs-input" name="name" autoComplete="name" required maxLength={120}
            value={form.name} onChange={set('name')} />
        </label>
        <label className="hs-field"><span>Email</span>
          <input className="hs-input" type="email" name="email" autoComplete="email" required
            value={form.email} onChange={set('email')} />
        </label>
        <label className="hs-field"><span>Password</span>
          <input className="hs-input" type="password" name="password" autoComplete="new-password" required
            value={form.password} onChange={set('password')} />
        </label>
        {error && <p className="hs-alert" role="alert">{error}</p>}
        <div className="hs-signin-actions">
          <button type="submit" className="hs-btn-amber" disabled={busy}>{busy ? 'Creating…' : 'Create my account'}</button>
        </div>
      </form>
      <GoogleButton onCredential={google} text="signup_with" />
      <p className="hs-signin-foot">
        Already at the table? <Link href={withReturn('/login', target)}>Sign in</Link>
      </p>
    </SignInPage>
  );
}

export default function SignupPage() {
  return <Suspense><SignupForm /></Suspense>;
}
