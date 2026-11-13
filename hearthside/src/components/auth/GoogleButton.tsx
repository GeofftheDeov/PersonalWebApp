"use client";

import { useEffect, useRef } from 'react';
import { GOOGLE_CLIENT_ID } from '@/lib/config';

const GSI_SRC = 'https://accounts.google.com/gsi/client';

type Gsi = {
  accounts: {
    id: {
      initialize(options: { client_id: string; callback: (r: { credential?: string }) => void }): void;
      renderButton(el: HTMLElement, options: Record<string, unknown>): void;
    };
  };
};

/** Google Identity Services, loaded once per page load. */
let loading: Promise<Gsi> | null = null;
function loadGsi(): Promise<Gsi> {
  const ready = () => (window as unknown as { google?: Gsi }).google;
  if (ready()) return Promise.resolve(ready()!);
  loading ??= new Promise<Gsi>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = GSI_SRC;
    script.async = true;
    script.onload = () => (ready() ? resolve(ready()!) : reject(new Error('Google sign-in did not load')));
    script.onerror = () => { loading = null; reject(new Error('Google sign-in did not load')); };
    document.head.appendChild(script);
  });
  return loading;
}

export interface GoogleButtonProps {
  /** Called with Google's ID token; sign in with `session.loginWithGoogle`. */
  onCredential: (idToken: string) => void;
  /** "Sign in with Google" or "Sign up with Google". */
  text?: 'signin_with' | 'signup_with';
}

/**
 * Google's own sign-in button (#219). It needs NEXT_PUBLIC_GOOGLE_CLIENT_ID at
 * build time and this host among the client's JavaScript origins (#217's
 * wizard adds both Hearthside hosts). Without a client id it renders nothing
 * and loads nothing from Google, so local dev and the E2E stack never depend
 * on it.
 */
export default function GoogleButton({ onCredential, text = 'signin_with' }: GoogleButtonProps) {
  const host = useRef<HTMLDivElement>(null);
  const handler = useRef(onCredential);
  handler.current = onCredential;

  useEffect(() => {
    if (!GOOGLE_CLIENT_ID) return;
    let live = true;
    loadGsi().then((google) => {
      const el = host.current;
      if (!live || !el) return;
      google.accounts.id.initialize({
        client_id: GOOGLE_CLIENT_ID,
        callback: (r) => { if (r.credential) handler.current(r.credential); },
      });
      // Google's width is in pixels, 200 to 400.
      const width = Math.max(200, Math.min(400, Math.floor(el.getBoundingClientRect().width)));
      google.accounts.id.renderButton(el, { theme: 'filled_black', size: 'large', shape: 'rectangular', text, width });
    }).catch(() => { /* the form still works; the button just doesn't show */ });
    return () => { live = false; };
  }, [text]);

  if (!GOOGLE_CLIENT_ID) return null;
  return (
    <>
      <p className="hs-signin-or"><span>or</span></p>
      <div ref={host} className="hs-signin-google" />
    </>
  );
}
