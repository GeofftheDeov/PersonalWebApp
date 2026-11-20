"use client";

import Link from 'next/link';
import { useEffect, useId, useState, type FormEvent, type ReactNode } from 'react';
import GildedPanel from '@/components/design-system/GildedPanel';

export interface SignInPageProps {
  /** The panel's heading, and the page's name. */
  title: string;
  /** A line under the heading. */
  intro?: ReactNode;
  /** A small line above the heading (the invite page's "A summons for the party"). */
  kicker?: ReactNode;
  /** Across the top of the panel, above the heading (the invite page's banner). */
  banner?: ReactNode;
  children: ReactNode;
}

/**
 * A signing-in page's form. Its controls stay disabled until React has
 * hydrated the page: submitted before, the browser would send the form itself,
 * as a GET, with the password in the URL.
 */
export function SignInForm({ onSubmit, children }: { onSubmit: (e: FormEvent) => void; children: ReactNode }) {
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => setHydrated(true), []);
  return (
    <form className="hs-form" onSubmit={onSubmit}>
      <fieldset className="hs-signin-fields" disabled={!hydrated}>{children}</fieldset>
    </form>
  );
}

/**
 * A signing-in page (#219, spec #69): under the top bar, on the floor, with no
 * rail or Letters; the Hearthside name, then one gilded panel holding the
 * form. Login, signup, forgot and reset password, check email and verify
 * email all use it, and so does the invite page (#232), with its banner.
 */
export default function SignInPage({ title, intro, kicker, banner, children }: SignInPageProps) {
  const titleId = useId();
  return (
    <div className="hs-shell-wrap">
      <main className="hs-signin">
        <Link href="/" className="hs-brand hs-signin-brand">Hearthside<small>The Party Gathers</small></Link>
        <GildedPanel as="section" className="hs-signin-panel" aria-labelledby={titleId}>
          {banner && <div className="hs-signin-banner">{banner}</div>}
          <div className="hs-signin-pad">
            {kicker && <p className="hs-signin-kicker">{kicker}</p>}
            <h1 id={titleId}>{title}</h1>
            {intro && <p className="hs-signin-intro">{intro}</p>}
            {children}
          </div>
        </GildedPanel>
      </main>
    </div>
  );
}
