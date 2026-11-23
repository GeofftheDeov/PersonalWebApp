"use client";

import Link from 'next/link';
import NoticeSheet from '@/components/design-system/NoticeSheet';

/**
 * A — The notice. The whole page is one sheet of parchment pinned to the
 * floor, written as a tavern notice: what Hearthside does, told through the
 * Notice Board's own three steps, with an example vote in the first. Sign in
 * and Create an account sit at the sheet's foot. The other places get one
 * quiet line each, on the floor under it.
 */
export default function VariantA() {
  return (
    <div className="hs-shell-wrap">
      <main className="hs-ha">
        <p className="hs-brand hs-ha-brand">Hearthside<small>The Party Gathers</small></p>

        <NoticeSheet seed="hearthside-signed-out-home" className="hs-ha-sheet" aria-labelledby="hs-ha-title">
          <p className="hs-kicker">Posted by the hearth</p>
          <h1 className="hs-sheet-title hs-ha-title" id="hs-ha-title">Wanted: one night the whole party can make</h1>
          <p className="hs-ha-lede">
            Hearthside plans your game nights. The GM calls the session, and the party settles the night,
            the table and the food here, instead of in a group chat that scrolls away.
          </p>

          <ol className="hs-steps">
            <li className="hs-step is-live">
              <span className="hs-step-n" aria-hidden="true">1</span>
              <div className="hs-step-body">
                <h4>The night <span className="hs-step-status">the party votes</span></h4>
                <p>Everyone ticks the nights they can make, picked from when the party is free. Most votes wins; a tie goes to the GM.</p>
                <figure className="hs-ha-example">
                  <figcaption>For example</figcaption>
                  <ul className="hs-votes">
                    <li className="hs-vote is-lead">
                      <span>Friday, 7 pm</span><span className="hs-vote-who">4 of 5</span>
                      <span className="hs-vote-bar"><i style={{ width: '80%' }} /></span>
                    </li>
                    <li className="hs-vote">
                      <span>Saturday, 2 pm</span><span className="hs-vote-who">2 of 5</span>
                      <span className="hs-vote-bar"><i style={{ width: '40%' }} /></span>
                    </li>
                  </ul>
                </figure>
              </div>
            </li>
            <li className="hs-step">
              <span className="hs-step-n" aria-hidden="true">2</span>
              <div className="hs-step-body">
                <h4>The table</h4>
                <p>Online at the campaign’s table link, or in person at a place the party has played before or suggests.</p>
              </div>
            </li>
            <li className="hs-step">
              <span className="hs-step-n" aria-hidden="true">3</span>
              <div className="hs-step-body">
                <h4>The food</h4>
                <p>Potluck or provided. Whoever’s bringing something gets a reminder in Your Quests.</p>
              </div>
            </li>
          </ol>

          <div className="hs-ha-foot">
            <Link href="/login" className="hs-btn is-primary hs-ha-btn">Sign in</Link>
            <Link href="/signup" className="hs-btn hs-ha-btn">Create an account</Link>
          </div>
        </NoticeSheet>

        <ul className="hs-ha-places" aria-label="Also at Hearthside">
          <li><b>Letters</b> Your campaigns’ group chats and messages between players.</li>
          <li><b>The Almanac</b> Every session, past and coming, on one calendar.</li>
          <li><b>Adventurers</b> Your characters, across every campaign they’ve played in.</li>
        </ul>
        <p className="hs-note hs-ha-invite">Got an invite to a campaign? Open its link and you’ll be asked to sign in there.</p>
      </main>
    </div>
  );
}
