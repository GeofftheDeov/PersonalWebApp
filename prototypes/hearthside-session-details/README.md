# PROTOTYPE: Hearthside session page

Throwaway. This branch is not meant to be merged. It keeps the prototype as the record of how the decision was made. Build the real page fresh: this code has no tests and stubs every action.

## The question

What should a session's own page look like in the Hearthside design system? It has to keep what the PWA's session page does (`frontend/src/app/game-night/sessions/[id]/page.tsx`): when and where, the table link for online sessions, the torch (a one-session stand-in GM), the ready check, prep notes (agenda), the summary, quests, attendance, the Google Calendar and Discord events, the recording link, the logged date, and Edit for the GM.

It also adds four things:

- **Who came, as adventurers.** Each player shows with their adventurer for this campaign. Attendance follows the rule from the Adventurers prototype: an adventurer was there if their player was. If the player wasn't, the GM says whether the party played the adventurer anyway when confirming who came.
- **The tale.** Room for the summary, written on the page by the GM (or the session's stand-in), in the story face with a drop cap.
- **Accounts.** Summaries anyone in the party uploads: a journal PDF, a document, a text file (readable in place), a photo of handwritten notes, or a voice memo. Hearthside keeps each file as it is.
- **The reel.** A slot for an AI-painted short film of the session's scenes, made from the tale and the party's portraits.

The design system keeps parchment for "one session's own business", so this is the page parchment was meant for. The layouts differ in how much of the page is parchment.

## The layouts

- **A, "The session sheet"** (words first). The whole session is one parchment sheet pinned to the floor, read top to bottom. A played session opens on **Who came**, a row of medallions: the GM with an orange ring, adventurers who sat it out struck through and greyed, and adventurers the party played with a dashed seal-red ring. Then come the tale, the accounts, the reel framed in gold, and the quests beside the GM's prep notes. A session still to come leads with its prep notes and quests, and keeps dashed slots for the tale and the reel. Previous and next session buttons sit above the sheet.
- **B, "The reel"** (pictures first). The reel fills the top of the page with its scene strip under it. Before the session, that space is a countdown over the campaign banner, with Join the table and Add to Google Calendar. When nothing is planned yet, it points at the Notice Board. Below it, the tale and the accounts are on parchment (prep notes before the session). Leather panels follow, two across where they fit: **At the table** (rows with a status pill each), the torch, quests and details. The shell's page column is about 680px at most, so these panels sit under the tale rather than beside it.
- **C, "Around the table"** (people first). A round oak table seen from above, with the GM at its head and each adventurer in a seat on a brass plate. A parchment card in the middle holds the session's name, night and status. The seats show the story: a player who's away leaves a grey seat, an adventurer the party played gets a dashed ring, and during the ready check each seat glows green or red. The GM takes attendance by **tapping seats**. Anyone left out gets the "Was Brass there?" question in the strip under the table. Everything else is in tabs: The tale, Accounts, The reel, Quests, Prep notes, Details.

## What the prototype assumes (to confirm or change)

- **Who writes the tale:** the GM or the session's stand-in, written in place on the page and not in the Edit dialog. Players add accounts instead. Another option would be letting anyone write it if the GM hasn't.
- **Accounts are files, kept as they are.** Nothing reads them into the tale. Text files can be read on the page. The uploader or the GM can remove one.
- **The reel is painted from the tale only,** not the accounts. Only the GM can start it, after a dialog that says what it uses and that AI gets things wrong. The party gets a letter when it's ready. The GM can paint it again or remove it.
- **Attendance shows "Reached level 5"** for adventurers who were there, using the level history the Adventurers prototype asked for.

## The answer

Not decided yet.

## What the data would need

Beyond what the Adventurers prototype already listed (an adventurer's span in a campaign, and adventurers present without their player):

- **The tale:** today's `summary` text, plus who wrote it and when.
- **Accounts:** a table of uploaded files per session (S3, like campaign banners): uploader, name, type, size and date.
- **The reel:** per session, its state (none, painting, ready or failed), the video file, its scenes (caption and time), when it was painted, and from which version of the tale. Painting is a background job that sends a letter when it's done.

## Still open

- **Is an AI reel worth it?** That's the question the slot was left for. Things to weigh:
  - the cost per session;
  - whether players are comfortable with their characters' faces being generated;
  - what happens when the tale is short or vague;
  - whether a few still scenes (cheaper, and closer to what's painted here) would do as well as video.

  B makes the reel the page's hero, so B only makes sense if the reel stays.
- The reel here is a stand-in: five painted stills with a slow pan and captions, 8 seconds each. A real model's output would look different.
- Hearthside has no form styles yet. Fields follow the message composer, as in the earlier prototypes.
- Add quest is stubbed. It would be the PWA's form.
- The medallion, the brass plate and the round table are drawn in this prototype. Whichever survive should go into the design system.

## Running it

From the repo root:

```
python -m http.server 4175 --bind 127.0.0.1 --directory prototypes/hearthside-session-details
```

Then open http://127.0.0.1:4175/hearthside-session-details-prototype.html, or start `session-prototype` from `.claude/launch.json`. It loads `bundle.css` and `bundle.js`, copies of the Hearthside design system's components (https://claude.ai/artifact/4X4uHuC4vyx4Qk6mLR8KoR).

The bar at the bottom switches:

- **The layout** (← → or the arrow keys), with `?variant=A|B|C`.
- **The session** (`?state=`):
  - `told`: Session 6 with attendance, the tale, three accounts, a reel and a recording.
  - `fresh`: Session 6 just played, with nothing written up.
  - `painting`: the reel on its way.
  - `upcoming`: Session 7 next Tuesday.
  - `ready`: Session 7, 22 minutes out, with the ready check sent.
  - `planning`: Session 10, with no night yet.
  - `cancelled`: Session 8.
- **Who is looking** (`?as=geoff|avery`): Geoff, a player (Kestrel Vane), or Avery, the Game Master.

Every control works on made-up data kept in memory: taking attendance (with the "was their adventurer there?" question), writing the tale, uploading and removing accounts, painting, playing and removing the reel, the ready check, passing the torch, ticking quests and editing. Switching the session resets it. "Today" is fixed at Mon Oct 26 2026, and the campaign, sessions and adventurers are the ones from the Adventurers prototype.
