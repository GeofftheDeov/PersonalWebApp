# PROTOTYPE: Hearthside player profile

Throwaway. This branch is not meant to be merged. It keeps the prototype as the record of how the decision was made. Build the real page fresh: this code has no tests and stubs every action.

## The question

What should a player's profile look like in the Hearthside design system? It has to keep every record field the PWA's profile shows (`frontend/src/app/profile/page.tsx`):

- photo (with upload, JPG, PNG, GIF or WEBP up to 5 MB)
- name, handle, unique ID (`@handle#userNumber`), internal ID (`userDigit`, for User records only)
- email (can't be changed), phone, record type
- Discord handle and Discord user ID
- favourite games, characters, campaigns and sessions attended
- the Google Calendar integration, including its `needsReconsent` line

It also adds four things:

- **Which adventurer played each session.** Each session shows the adventurer's medallion, the level they reached there, or "Ran it as Dungeon Master" when you were the GM.
- **Notices:** what Hearthside tells you, and where (the bell, email, Discord).
- **Discord beside Google Calendar** under Integrations, as a card built the same way: name and one status line on the left, one Connect or Disconnect button on the right, and the result line under it.
- **What a campaign-mate sees.** The PWA has a separate public player page (`frontend/src/app/players/[id]/page.tsx`). Here the same page is drawn for both viewers.

The page column is about 680px at most in the shell, so every layout is one column.

## The layouts

- **A, "The ledger"** (the PWA's shape). The head is on the floor: photo, name, handle and unique ID, and counts. Under it is a gilded tab strip: Record, Sessions, Campaigns, Notices and Integrations. One leather panel shows at a time. Sessions are split into "Coming up" and "Played", with a filter for each campaign.
- **B, "The guest book"** (everything showing). One long page. The photo hangs in a gold medallion over a brass name plate, with the record panel beside it. Then come campaigns as banner cards, Coming up, and **sessions played as slips of parchment**: the latest six are pinned to the floor, each with the adventurer's medallion taped on. "All 34 sessions" opens the full list. Notices and Integrations come last. The slips stretch the design system's rule only a little: parchment is for one session's own business, and each slip is one session.
- **C, "The road"** (your story in public, settings in their own room). A Profile/Settings switch at the top.
  - **Profile** is what the party sees: a hero with your adventurers and favourite games, then your campaigns as tiles (pick one to follow its road), then **the road so far**. That's a timeline with upcoming sessions at the top and a "Today" marker. Under it come the sessions played, by month, with missed sessions faded and adventurers changing hands marked ("Pip Thistlewick fell at the bridge", "Mags Ironhollow joined the road").
  - **Settings** is only for you. The record is edited in place there rather than in a dialog. It also holds Notices and Integrations, and says what the party can and can't see.

## The answer

**A, "The ledger".** Picked by Geoff on 2026-10-27. The prototype opens on it. B and C stay in the switcher for comparison.

- **The nav entry is "Your Room"** (decided), the fifth item in the nav.
- **A campaign-mate sees your adventurers, not your campaigns** (decided). Every layout now follows this:
  - **Adventurers:** all of them, including ones from campaigns you don't share (Mags, Pip and Ada for Avery), with class and level or status, and no campaign.
  - **No campaign list or count:** no Campaigns tab in A, no Campaigns section in B, no campaign tiles in C. The head reads "6 adventurers · 5 sessions together · since March 2025".
  - **Sessions together:** the tab is renamed for them, and shows only sessions in campaigns you both belong to. That reveals nothing they don't already know, since they were in those campaigns too.
  - Your own view is unchanged: the Campaigns tab stays.

## What the prototype assumes (to confirm or change)

- **The profile is "Your Room" in the nav** (decided, see above). That makes five nav items, so the phone's 2 × 2 nav grid gets a third row.
- **Connecting Discord fills in the Discord name and user ID.** While Discord is connected, those fields are read-only and marked "from Discord". When it isn't, you can still type them, with the PWA's "Developer Mode › Copy User ID" hint. Disconnecting keeps them on the record.
- **Notices are a grid:** each notice has a row and each place (the bell, email, Discord) has a column.
  - The Discord column needs Discord connected and "Send me notices as Discord messages" turned on.
  - Quest reminders get default lead times: 1 day and 1 hour, up to 5, up to a week. This mirrors `session_tasks.reminder_offsets` (at most 5, at most 14 days).
  - Quiet hours hold email and Discord overnight. The bell still collects them.
  - "When you run a campaign" rows only show for GMs.
- **Google Calendar options:**
  - Which calendar sessions go to.
  - "Count my busy time when the party plans a night", the free/busy use behind the PWA's reconnect line. When `needsReconsent` is set, that switch becomes the line "reconnect once", with a Reconnect link, and the pill says "Reconnect needed" in seal red (it needs you).
- **A campaign-mate sees** what `toPublicPerson` returns: name, handle, unique ID, photo, Discord, favourite games and join date. They also see all your adventurers and the sessions you played together (see the answer above). They never see your campaigns, email, phone, internal ID, record type, Notices or Integrations. They get "Write a letter" and a Friends pill instead of Edit.
- **Availability and the Almanac leave the profile.** The PWA's Availability and Almanac tabs belong to the Almanac page now. The API key vault isn't a Hearthside thing and stays on the main site. A line on the page says so.

## What the data would need

- **The adventurer at each session.** `/api/users/profile/sessions` returns the session, its date and campaign, but not who you played. The Adventurers prototype's rule (an adventurer's span in their campaign, plus "the party played them without you") gives it, along with the level reached at each session (level history).
- **The public player view changes shape.** `GET /api/users/players/:id` returns `sharedCampaigns` today. It would drop that, and add the person's adventurers (name, class, level, status and art, without their campaign) and the sessions both people were at. The adventurer page a campaign-mate opens from here must hide the campaign too: the Adventurers prototype's page shows it, in the banner and on the road.
- **Sessions you ran.** Today, attendance (`player_sessions`) is what lists your sessions. Sessions where you were the GM (or stood in with the torch) need to come from the campaign's GM, not attendance.
- **Notice preferences:** a per-person table of (notice, channel) → on/off, default reminder offsets, and quiet hours with a time zone. Today `notifications` only feeds the bell, with four types (`friend_request`, `campaign_invite`, `message`, `system`), so most of these notices are new events too.
- **Discord as an integration:** an OAuth link (identify scope) that stores the Discord user ID and name, plus a bot or DM path for sending notices. Today `discord_id` and `discord_handle` are typed by hand.
- **Google Calendar:** the target calendar per person (today it's implied), alongside the existing connected and `needsReconsent` status.

## Still open

- Is a notices grid too much? A shorter version could be one choice per group (Sessions, Quests, Letters, The party) instead of a row per notice.
- Should a campaign-mate see the sessions you played together at all? Each one names its campaign, though only a campaign you both belong to. Dropping them would leave the public view as the record and the adventurers.
- A player who's only your friend (not a campaign-mate) sees no sessions, since you share none. The prototype doesn't draw that viewer.
- Hearthside has no form styles, toggles or checkboxes yet. The fields follow the message composer, as in the earlier prototypes. The checkboxes follow Your Quests' boxes (moss when on). The switch is new. Whichever survive should go into the design system.
- The integration marks are drawn glyphs (a calendar and a speech bubble), not the services' logos, since the design system has no icon set. The real cards may want the official marks.

## Running it

From the repo root:

```
python -m http.server 4176 --bind 127.0.0.1 --directory prototypes/hearthside-player-profile
```

Then open http://127.0.0.1:4176/hearthside-player-profile-prototype.html, or start `profile-prototype` from `.claude/launch.json`. It loads `bundle.css` and `bundle.js`, copies of the Hearthside design system's components (https://claude.ai/artifact/4X4uHuC4vyx4Qk6mLR8KoR).

The bar at the bottom switches:

- **The layout** (← → or the arrow keys), with `?variant=A|B|C`. A is the default.
- **The state** (`?state=`):
  - `seasoned`: five campaigns, 34 sessions, Google connected, Discord not.
  - `linked`: both connected. Discord has filled in the handle and ID, and the Discord column is on.
  - `reconnect`: Google connected but `needsReconsent`, so busy time can't count yet.
  - `newcomer`: just joined. No campaigns, sessions, adventurers, photo or quests, and nothing connected.
- **Who is looking** (`?as=geoff|avery`): Geoff on his own profile, or Avery, a campaign-mate (Game Master of Starfall Salvage).

Every control works on made-up data kept in memory:

- editing the record (a dialog in A and B, in place in C) and uploading a photo
- adding and removing favourite games
- filtering sessions by campaign
- ticking notices, adding and removing reminder times, and quiet hours
- connecting and disconnecting both integrations, which stands in for the round trip to Google's or Discord's sign-in page

Switching the state resets it. "Today" is fixed at Tue Oct 27 2026. The campaigns, sessions and adventurers are the ones from the Adventurers and Session prototypes.
