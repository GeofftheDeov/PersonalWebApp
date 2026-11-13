import Link from 'next/link';
import SignInPage from '@/components/auth/SignInPage';

/** After signing up (#219): the verify link is in the post. */
export default function CheckEmailPage() {
  return (
    <SignInPage title="Check your email" intro="A letter is on its way with a link to confirm your address.">
      <div className="hs-form">
        <p className="hs-dialog-text">
          Open the link within a day. Open it in this browser and you&rsquo;ll be signed in straight away;
          anywhere else, it confirms your email and you sign in after.
        </p>
        <p className="hs-fine">Nothing there? Look in your spam folder.</p>
        <div className="hs-signin-actions">
          <Link href="/login" className="hs-btn-amber hs-signin-btn">Go to sign in</Link>
        </div>
      </div>
    </SignInPage>
  );
}
