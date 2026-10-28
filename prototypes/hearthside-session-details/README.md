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
- **C, "Around the table"** (people first). A round oak table seen from above, with the GM at its head and each adventurer in a seat on a brass plate. In round 1, a parchment card in the middle held the session's name, night and status. The seats show the story: a player who's away leaves a grey seat, an adventurer the party played gets a dashed ring, and during the ready check each seat glows green or red. The GM takes attendance by **tapping seats**. Anyone left out gets the "Was Brass there?" question in the strip under the table. In round 1, everything else was in tabs: The tale, Accounts, The reel, Quests, Prep notes, Details. Round 2 changed C (see the answer below); round 1 is in this branch's first commit.

## What the prototype assumes (to confirm or change)

- **Who writes the tale:** the GM or the session's stand-in, written in place on the page and not in the Edit dialog. Players add accounts instead. Another option would be letting anyone write it if the GM hasn't.
- **Accounts are files, kept as they are.** Nothing reads them into the tale. Text files can be read on the page. The uploader or the GM can remove one.
- **The reel is painted from the tale only,** not the accounts. Only the GM can start it, after a dialog that says what it uses and that AI gets things wrong. The party gets a letter when it's ready. The GM can paint it again or remove it.
- **Attendance shows "Reached level 5"** for adventurers who were there, using the level history the Adventurers prototype asked for.

## The answer

**C, "Around the table", revised.** Picked by Geoff on 2026-10-27. The prototype now opens on it. A and B stay in the switcher for comparison, and they still show round 1's reel, quests and prep notes.

- **The session's card moves above the table.** It's a parchment sheet with the name, night, place and status, plus Edit for the GM. It also holds the torch, the Notice Board line while the session is being planned, and Join the table and Add to Google Calendar before an online session.
- **The middle of the table is a two-sided card:**
  - **Front: the recording.** The GM uploads the session's recording here: audio or video. It plays in place (a waveform for audio), with "Watch large" (or "Listen large") for a bigger view, and Replace and Remove for the GM. "Or link to one" keeps the PWA's recording URL as a fallback. Before the session the front shows the countdown, and players see "No recording yet" until there is one.
  - **Back: the AI cinematic.** "The cinematic ↻" flips the card. The cinematic is made from the tale. Only the GM can make it, after the same "what this uses" dialog that the reel had, and the card flips to show its progress. It plays in place, and can be popped out to full screen (round 3).
- **The tale can be drafted from the recording.** With a recording in, the GM's Tale tab offers "Draft it from the recording". Hearthside listens to it, works out who said what, picks out the scenes and writes a draft. The draft opens in the editor with a note to fix what the AI got wrong before saving, since the party reads it and the cinematic is made from it. The byline then says "from an AI draft of the recording". **Only the GM writes or edits the tale.** Players read it, and can still add accounts.
- **Quests sit by each player's seat** as paper slips, and the Quests tab is gone. Players tick their own quests, and the GM can tick anyone's. Before the session, the GM adds a quest from the seat with "+ quest": it goes to that player and is due when the session starts. The GM's own quests sit beside the head of the table.
- **The tabs under the table open on a time-gated default:**

  | | Before the session | After it |
  |---|---|---|
  | The GM | Prep notes | Details |
  | A player | Details | The tale |

  The tabs are The tale, Accounts (after the session), Details and Prep notes (GM only). **Players never see the GM's prep notes,** before or after. The GM edits prep notes in place in their tab.
- Seats are anchored on their portrait, so a seat with more quest slips doesn't move. The middle card, the seats and the slips stay clear of each other at phone and desktop widths.

Round 3 (Geoff, 2026-10-27):

- **The card turns over.** Flipping turns the existing card over in place: it lifts off the table, rotates and settles. Focus moves to the flip button on the side now showing. With reduced motion, the card switches without animating.
- **On phones** (when the table is under 520px across), the flip button is just its icon, with the label kept for screen readers.
- **The table is a real table.** It's painted as one image:
  - eight oak boards with their seams, grain that bends round knots, and pegs where the boards meet the battens;
  - a bent-wood rim in four joined pieces, bevelled at both edges;
  - cup rings and scratches, and a d20 and a d6 left at the foot;
  - varnish that catches the hearth's light from the lower left.

  Shadows under it give it an edge and lift it off the floor.
- **The cinematic pops out.** "Full screen" under the card, or the icon at the right of its controls, opens it over the whole window and asks the browser for real full screen. It plays on from where it was. The × button, the icon again, or Escape brings it back. The app's own browser pane refuses full-screen permission, so there it fills the window instead. A normal browser should go truly full screen, but that hasn't been checked.

## What the data would need

Beyond what the Adventurers prototype already listed (an adventurer's span in a campaign, and adventurers present without their player):

- **The recording:** an uploaded audio or video file per session (S3, and large: three to four hours of video can be gigabytes, so uploads need to be resumable). Store its kind, length, size, who uploaded it and when. The existing `vodUrl` stays as the link alternative.
- **Drafting the tale from the recording:** a background job: speech to text, telling the speakers apart, then a summary written as a tale. It returns a draft for the GM to edit. Nothing is saved until the GM saves it.
- **The tale:** today's `summary` text, plus who wrote it, when, and whether it began as an AI draft.
- **Accounts:** a table of uploaded files per session (S3, like campaign banners): uploader, name, type, size and date.
- **The cinematic** (the reel, in A and B): per session, its state (none, being made, ready or failed), the video file, its scenes (caption and time), when it was made, and from which version of the tale. Making it is a background job that sends a letter when it's done.

## Still open

- **Is an AI cinematic worth it?** Things to weigh:
  - the cost per session;
  - whether players are comfortable with their characters' faces being generated;
  - what happens when the tale is short or vague;
  - whether a few still scenes (cheaper, and closer to what's painted here) would do as well as video.
- **The recording is the most sensitive thing on the page.** It's the party's voices, and maybe their faces, for hours. Who can play it (the party only?), whether a player can ask to be left out, and how long it's kept all need deciding. So does whether sending it to an AI service to draft the tale needs everyone's agreement first.
- The prototype assumes a quest's due time defaults to the session's start, as the PWA's does. The "+ quest" slip only takes a title. Notes and a different due time would need the full form.
- The cinematic here is a stand-in: five painted stills with a slow pan and captions, 8 seconds each. The drafted tale is the same tale as the sample. A real model's output would differ in both.
- Hearthside has no form styles yet. Fields follow the message composer, as in the earlier prototypes.
- The medallion, the brass plate, the painted table, the two-sided card and the quest slips are drawn in this prototype. The real table should be a designed asset rather than painted by the page. Whichever survive should go into the design system.

## Running it

From the repo root:

```
python -m http.server 4175 --bind 127.0.0.1 --directory prototypes/hearthside-session-details
```

Then open http://127.0.0.1:4175/hearthside-session-details-prototype.html, or start `session-prototype` from `.claude/launch.json`. It loads `bundle.css` and `bundle.js`, copies of the Hearthside design system's components (https://claude.ai/artifact/4X4uHuC4vyx4Qk6mLR8KoR).

The bar at the bottom switches:

- **The layout** (← → or the arrow keys), with `?variant=A|B|C`. C is the default.
- **The session** (`?state=`):
  - `told`: Session 6 with attendance, a video recording, the tale (from an AI draft), three accounts and a cinematic.
  - `fresh`: Session 6 just played, with nothing uploaded or written up.
  - `recorded`: Session 6 with an audio recording in and no tale yet. As Avery, open The tale and choose "Draft it from the recording".
  - `painting`: the cinematic (or reel) on its way.
  - `upcoming`: Session 7 next Tuesday.
  - `ready`: Session 7, 22 minutes out, with the ready check sent.
  - `planning`: Session 10, with no night yet.
  - `cancelled`: Session 8.
- **Who is looking** (`?as=geoff|avery`): Geoff, a player (Kestrel Vane), or Avery, the Game Master.

Every control works on made-up data kept in memory: taking attendance (with the "was their adventurer there?" question), uploading a recording (a real audio or video file plays in place), drafting and writing the tale, uploading and removing accounts, making, flipping to, playing and removing the cinematic, the ready check, passing the torch, adding and ticking quests at the seats, prep notes and editing. Switching the session resets it. "Today" is fixed at Mon Oct 26 2026, and the campaign, sessions and adventurers are the ones from the Adventurers prototype.
