"use client";

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense } from 'react';
import SignInPage from '@/components/auth/SignInPage';
import { returnTarget, withReturn } from '@/lib/signIn';

/**
 * After signing up (#219): the verify link is in the post. "Go to sign in"
 * carries the signup's return along (`?redirect=`), so someone who signed up
 * from an invite and signs in here still comes back to it (#232).
 */
function CheckEmail() {
  const target = returnTarget(useSearchParams()?.toString() ?? '');
  return (
    <SignInPage title="Check your email" intro="A letter is on its way with a link to confirm your address.">
      <div className="hs-form">
        <p className="hs-dialog-text">
          Open the link within a day. Open it in this browser and you&rsquo;ll be signed in straight away;
          anywhere else, it confirms your email and you sign in after.
        </p>
        <p className="hs-fine">Nothing there? Look in your spam folder.</p>
        <div className="hs-signin-actions">
          <Link href={withReturn('/login', target)} className="hs-btn-amber hs-signin-btn">Go to sign in</Link>
        </div>
      </div>
    </SignInPage>
  );
}

export default function CheckEmailPage() {
  return <Suspense><CheckEmail /></Suspense>;
}
