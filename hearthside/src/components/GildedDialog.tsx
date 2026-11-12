"use client";

import { useEffect, useId, useRef, type ReactNode } from 'react';
import GildedPanel from '@/components/design-system/GildedPanel';

export interface GildedDialogProps {
  /** The dialog's heading, and its accessible name. */
  title: string;
  /** Closing: the ✕, Escape, or a click on the dimmed room around it. */
  onClose: () => void;
  /** 720px wide rather than 480px (the banner cropper). */
  wide?: boolean;
  children: ReactNode;
}

/**
 * A dialog on gilded leather over a dimmed room, as the prototypes draw them
 * (new campaign, the banner cropper, confirmations; no `window.confirm`).
 * Mount it to open it and unmount it to close it:
 *
 *   {open && <GildedDialog title="New campaign" onClose={() => setOpen(false)}>…</GildedDialog>}
 *
 * It's a native modal `<dialog>`, so focus stays inside, Escape closes it and
 * it sits above everything. Only the content scrolls, and only when it must:
 * the frame's corner flourishes reach past the panel.
 */
export default function GildedDialog({ title, onClose, wide = false, children }: GildedDialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const close = useRef(onClose);
  close.current = onClose;

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (!d.open) d.showModal();
    return () => { if (d.open) d.close(); };
  }, []);

  return (
    <dialog
      ref={ref}
      className={wide ? 'hs-dialog is-wide' : 'hs-dialog'}
      aria-labelledby={titleId}
      // Escape: the parent decides, by unmounting.
      onCancel={(e) => { e.preventDefault(); close.current(); }}
      // A click on the dialog itself, not its panel, is on the dimmed room.
      onClick={(e) => { if (e.target === e.currentTarget) close.current(); }}
    >
      <GildedPanel className="hs-dialog-panel">
        <div className="hs-dialog-pad">
          <div className="hs-dialog-head">
            <h2 id={titleId}>{title}</h2>
            <button type="button" className="hs-dialog-x" aria-label="Close" onClick={() => close.current()}>✕</button>
          </div>
          {children}
        </div>
      </GildedPanel>
    </dialog>
  );
}
