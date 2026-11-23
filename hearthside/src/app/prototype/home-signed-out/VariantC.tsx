"use client";

import Link from 'next/link';
import GildedPanel from '@/components/design-system/GildedPanel';
import NoticeSheet from '@/components/design-system/NoticeSheet';

/**
 * C — The week. One session's week, told down a road on the floor: the GM
 * calls it on Monday, and by Friday the party's at the table. Each day shows
 * the piece of Hearthside that does that job, drawn in its own material
 * (leather for Letters and Quests, parchment for the Notice Board). The days
 * really are a sequence, so they're marked as one. Sign-in sits at the top
 * and again at the road's end.
 */
export default function VariantC() {
  return (
    <div className="hs-shell-wrap">
      <main className="hs-hc">
        <header className="hs-hc-head">
          <p className="hs-brand">Hearthside<small>The Party Gathers</small></p>
          <h1 className="hs-hc-title">From “are we playing this week?” to dice on the table</h1>
          <p className="hs-hc-lede">Here’s how one session comes together.</p>
          <div className="hs-hc-acts">
            <Link href="/login" className="hs-btn-amber hs-hc-btn">Sign in</Link>
            <Link href="/signup" className="hs-ghost hs-hc-btn">Create an account</Link>
          </div>
        </header>

        <ol className="hs-hc-road">
          <li className="hs-hc-day">
            <div className="hs-hc-when"><span className="hs-hc-dayname">Monday</span><h2>The GM calls the session</h2>
              <p>It goes up on the Notice Board, and the campaign’s Letters let everyone know.</p></div>
            <GildedPanel className="hs-hc-frag">
              <div className="hs-hc-letter">
                <div className="hs-msg"><span className="hs-msg-by">Mara (GM)</span>Session 12 is on the board. Vote on a night by Wednesday.</div>
                <div className="hs-msg is-me"><span className="hs-msg-by">You</span>On it.</div>
              </div>
            </GildedPanel>
          </li>

          <li className="hs-hc-day">
            <div className="hs-hc-when"><span className="hs-hc-dayname">Tuesday</span><h2>The party votes on a night</h2>
              <p>The choices come from when everyone is free. Most votes wins; a tie goes to the GM.</p></div>
            <NoticeSheet seed="hs-hc-tuesday" className="hs-hc-frag hs-hc-paper">
              <p className="hs-kicker">The night</p>
              <ul className="hs-votes">
                <li className="hs-vote is-lead"><span>Friday, 7 pm</span><span className="hs-vote-who">4 of 5</span>
                  <span className="hs-vote-bar"><i style={{ width: '80%' }} /></span></li>
                <li className="hs-vote"><span>Saturday, 2 pm</span><span className="hs-vote-who">2 of 5</span>
                  <span className="hs-vote-bar"><i style={{ width: '40%' }} /></span></li>
              </ul>
            </NoticeSheet>
          </li>

          <li className="hs-hc-day">
            <div className="hs-hc-when"><span className="hs-hc-dayname">Wednesday</span><h2>You settle the table</h2>
              <p>Online at the campaign’s table link, or in person somewhere the party picks.</p></div>
            <NoticeSheet seed="hs-hc-wednesday" className="hs-hc-frag hs-hc-paper">
              <p className="hs-kicker">The table</p>
              <ul className="hs-ledger">
                <li><span>Mara’s place</span><span>3 votes</span></li>
                <li><span>The game store on 5th</span><span>1 vote</span></li>
                <li><span className="is-open">Suggest a place</span><span /></li>
              </ul>
            </NoticeSheet>
          </li>

          <li className="hs-hc-day">
            <div className="hs-hc-when"><span className="hs-hc-dayname">Thursday</span><h2>Food gets sorted</h2>
              <p>Potluck or provided. Whatever you’ve signed up for lands in Your Quests, with a reminder.</p></div>
            <GildedPanel className="hs-hc-frag">
              <ul className="hs-quests">
                <li><span className="hs-box" aria-hidden="true" /><div><div className="hs-quest-name">Bring drinks</div><div className="hs-quest-time">Friday, 6 pm</div></div></li>
                <li className="is-done"><span className="hs-box" aria-hidden="true" data-done="" /><div><div className="hs-quest-name">Vote on the night</div><div className="hs-quest-time">Done</div></div></li>
              </ul>
            </GildedPanel>
          </li>

          <li className="hs-hc-day is-last">
            <div className="hs-hc-when"><span className="hs-hc-dayname">Friday</span><h2>Everyone’s at the table</h2>
              <p>Ready checks go round, and the session goes into the Almanac with the rest of the campaign.</p></div>
            <div className="hs-hc-end">
              <div className="hs-hc-table" aria-hidden="true" />
              <div className="hs-hc-acts">
                <Link href="/signup" className="hs-btn-amber hs-hc-btn">Create an account</Link>
                <Link href="/login" className="hs-ghost hs-hc-btn">Sign in</Link>
              </div>
            </div>
          </li>
        </ol>
      </main>
    </div>
  );
}
