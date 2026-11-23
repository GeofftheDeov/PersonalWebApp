"use client";

import { usePathname, useRouter } from 'next/navigation';
import { useCallback, useEffect } from 'react';

/**
 * PROTOTYPE ONLY. The floating bar that flips between a prototype's variants
 * (`?variant=`), from the prototype skill. Arrows (and ← →) cycle, wrapping;
 * the URL carries the choice, so a variant can be linked and survives reload.
 * Never shown in a production build.
 */
export default function PrototypeSwitcher({ variants, current }: {
  variants: { key: string; name: string }[];
  current: string;
}) {
  const router = useRouter();
  const pathname = usePathname() ?? '/';
  const index = Math.max(0, variants.findIndex((v) => v.key === current));

  const go = useCallback((step: number) => {
    const next = variants[(index + step + variants.length) % variants.length];
    router.replace(`${pathname}?variant=${next.key}`, { scroll: false });
  }, [index, variants, pathname, router]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.closest('input, textarea, select, [contenteditable]'))) return;
      if (e.key === 'ArrowLeft') go(-1);
      if (e.key === 'ArrowRight') go(1);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [go]);

  if (process.env.NODE_ENV === 'production') return null;

  const v = variants[index];
  return (
    <div className="hs-proto-switch" role="toolbar" aria-label="Prototype variants">
      <button type="button" onClick={() => go(-1)} aria-label="Previous variant">‹</button>
      <span aria-live="polite"><b>{v.key}</b> {v.name}</span>
      <button type="button" onClick={() => go(1)} aria-label="Next variant">›</button>
    </div>
  );
}
