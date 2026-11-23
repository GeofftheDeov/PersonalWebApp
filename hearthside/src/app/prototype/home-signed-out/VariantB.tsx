"use client";

import Link from 'next/link';
import { useState, type FormEvent } from 'react';
import GildedPanel from '@/components/design-system/GildedPanel';

/**
 * B — At the door. Built for the returning player: the sign-in form is on
 * the home page itself, in a gilded panel on the right, so getting back in
 * is one step. On the left, on the floor, a large line and the four places
 * that matter to someone deciding whether to join. On a phone the form comes
 * straight after the headline, and the places follow it.
 *
 * The form is a stub: nothing is sent.
 */
export default function VariantB() {
  const [stubbed, setStubbed] = useState(false);
  const submit = (e: FormEvent) => { e.preventDefault(); setStubbed(true); };

  return (
    <div className="hs-shell-wrap">
      <main className="hs-hb">
        <header className="hs-hb-head">
          <p className="hs-brand">Hearthside<small>The Party Gathers</small></p>
          <h1 className="hs-hb-title">Get the party to the table.</h1>
          <p className="hs-hb-lede">
            Hearthside is where your tabletop group plans each session, keeps talking between them, and
            remembers who played what.
          </p>
        </header>

        <GildedPanel as="section" className="hs-hb-door" aria-labelledby="hs-hb-signin">
          <div className="hs-signin-pad">
            <h2 id="hs-hb-signin" className="hs-hb-door-title">Take your seat</h2>
            <form className="hs-form" onSubmit={submit}>
              <label className="hs-field"><span>Email</span>
                <input className="hs-input" type="email" name="email" autoComplete="email" required />
              </label>
              <label className="hs-field"><span>Password</span>
                <input className="hs-input" type="password" name="password" autoComplete="current-password" required />
              </label>
              {stubbed && <p className="hs-alert" role="status">Prototype: sign-in isn’t wired up here.</p>}
              <div className="hs-signin-actions">
                <button type="submit" className="hs-btn-amber">Sign in</button>
                <Link href="/forgot-password" className="hs-signin-link">Forgot your password?</Link>
              </div>
            </form>
            <p className="hs-signin-foot">New to the table? <Link href="/signup">Create an account</Link></p>
          </div>
        </GildedPanel>

        <dl className="hs-hb-places">
          <div>
            <dt>The Notice Board</dt>
            <dd>The GM calls a session; the party votes on the night, then settles where you’ll play and who brings food.</dd>
          </div>
          <div>
            <dt>Letters</dt>
            <dd>A group chat for each campaign, and messages between players, live as they’re typed.</dd>
          </div>
          <div>
            <dt>The Almanac</dt>
            <dd>Every session your campaigns have had or have coming, on one calendar.</dd>
          </div>
          <div>
            <dt>Adventurers</dt>
            <dd>Your characters, with the campaigns and sessions they’ve been through.</dd>
          </div>
        </dl>
      </main>
    </div>
  );
}
