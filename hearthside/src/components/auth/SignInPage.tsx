"use client";

import Link from 'next/link';
import { useId, type ReactNode } from 'react';
import GildedPanel from '@/components/design-system/GildedPanel';

export interface SignInPageProps {
  /** The panel's heading, and the page's name. */
  title: string;
  /** A line under the heading. */
  intro?: ReactNode;
  children: ReactNode;
}

/**
 * A signing-in page (#219, spec #69): under the top bar, on the floor, with no
 * rail or Letters; the Hearthside name, then one gilded panel holding the
 * form. Login, signup, forgot and reset password, check email and verify
 * email all use it; so can the invite page (#232).
 */
export default function SignInPage({ title, intro, children }: SignInPageProps) {
  const titleId = useId();
  return (
    <div className="hs-shell-wrap">
      <main className="hs-signin">
        <Link href="/" className="hs-brand hs-signin-brand">Hearthside<small>The Party Gathers</small></Link>
        <GildedPanel as="section" className="hs-signin-panel" aria-labelledby={titleId}>
          <div className="hs-signin-pad">
            <h1 id={titleId}>{title}</h1>
            {intro && <p className="hs-signin-intro">{intro}</p>}
            {children}
          </div>
        </GildedPanel>
      </main>
    </div>
  );
}
