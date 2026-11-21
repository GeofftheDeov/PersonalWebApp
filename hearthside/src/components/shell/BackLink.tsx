"use client";

import Link from 'next/link';
import { createContext, useContext, useEffect } from 'react';

/** Where a page's back link goes. */
export interface BackTarget {
  href: string;
  label: string;
}

/** How a page hands its back link to the shell's phone bar. The shell provides it. */
export const ShellBackContext = createContext<(target: BackTarget | null) => void>(() => {});

/**
 * A page's way back ("← Campaigns"), in the amber button. On wide screens it
 * sits where the page puts it, at the top of the page; under 760px it moves
 * to the right of the shell's row, opposite the menu button. `full` is a
 * longer label for the wide button; the phone bar keeps the short one.
 *
 *   <BackLink href="/campaigns">Campaigns</BackLink>
 *   <BackLink href="/campaigns" full="Back to Campaigns">Campaigns</BackLink>
 */
export default function BackLink({ href, children, full }: { href: string; children: string; full?: string }) {
  const setBack = useContext(ShellBackContext);
  useEffect(() => {
    setBack({ href, label: children });
    return () => setBack(null);
  }, [setBack, href, children]);
  return (
    <Link className="hs-btn-amber hs-back" href={href}>
      ← {full ?? children}
    </Link>
  );
}
