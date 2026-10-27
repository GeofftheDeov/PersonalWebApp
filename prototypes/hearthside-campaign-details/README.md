# PROTOTYPE: Hearthside campaign page

Throwaway. This branch is not meant to be merged. It keeps the prototype as the record of how the decision was made. Build the real page fresh: this code has no tests and stubs every action.

## The question

What should a campaign's own page look like in the Hearthside design system? It has to keep everything the PWA's campaign page does (`frontend/src/app/game-night/campaigns/[id]/page.tsx`: the details, the Notice Board, the party, Table Talk, sessions and characters). Its layout was already settled, so this was about applying Hearthside's style to that layout. It wasn't about choosing between layouts, so there is one design rather than variants.

## The answer

**The PWA's layout, in Hearthside materials, as revised by Geoff on 2026-10-25 and 2026-10-26.**

- **On the floor:** an amber "← Back to Campaigns" button, the banner in a gilded frame (with Change banner for the owner), the campaign's title as the page heading with its status pill, and the section headings.
- **Gilded leather:** the campaign's details (and the edit form), the party, Table Talk, the Sessions | Characters tabs, Coming up and Previous sessions.
- **Parchment:** each Notice Board sheet and its numbered steps (night, venue, food), the overlap picker, and the kick-off form for a new notice.
- **Dialogs:** gilded panels for Invite, Add a session, the banner cropper and every confirmation (no `window.confirm`).

Decisions made while revising:

- **Availability grid:** rows are start times and columns are days, as in the design system's AvailabilityGrid. Each column shows the weekday over the date.
- **The torch:** keeps the PWA's flame and orange wherever the Game Master's role changes hands: Pass the torch, Claim the torch, Pass it, the session stand-in line, and "ran it as" in Previous sessions. The flame is a hairline icon drawn for this, and the orange is `#f07b2c` on leather and `#9a4a12` on parchment. Neither is in the design system yet.
- **The party:** compact rows. The buttons are icon-only and sit under the name, so long names keep their width:
  - Make inactive: CirclePause. The PWA has no icon for this.
  - Remove: UserMinus, from the PWA.
  - Reactivate: UserCheck, which the PWA uses for attendance.
  - Leave the campaign: LogOut, from the PWA.

  The inactive list shows only names. "Can't read or post in Table Talk" moved into a tooltip on the "Inactive (n)" header.
- **Sessions:** Coming up and Previous sessions sit side by side on desktop (1100px and up), and stack on tablets and phones.
- **Phones (under 760px):** the menu folds behind a hamburger on the left, with "← Campaigns" on the right of the same row. This replaces the design system's 2 × 2 nav grid. Every page section spans the full width (the shell's column was shrinking the banner and Table Talk).
- **Dialogs:** only the content scrolls, and only when it must. The frame's corner flourishes reach past the panel and were causing scrollbars.

Still open:

- Table Talk is the same campaign chat that Letters lists on the right, so it appears twice on this page.
- Hearthside has no form styles yet. Fields here follow its message composer (`surface`, `line`, `radius`) on leather, and a translucent paper field on parchment.
- The flame icon, the torch orange and the party's Lucide icons should go into the design system if they stay.

## Running it

Open `hearthside-campaign-details-prototype.html` in a browser. It loads `bundle.css` and `bundle.js`, copies of the Hearthside design system's components (https://claude.ai/artifact/4X4uHuC4vyx4Qk6mLR8KoR). The published version is https://claude.ai/artifact/M9PpyFf55v3SwHjdmBmSbh.

The bar at the bottom (or ← →) switches what the Notice Board is doing: night vote, tie, shortlisting, venue vote, potluck, food provided, online with a stand-in, and nothing pinned. It also switches:

- who is looking: Geoff (Dungeon Master and owner), Priya (a player), or Avery (an admin outside the party);
- whether anyone holds the torch (admin-managed, so a player can claim it);
- whether the campaign has a banner.

Every control works on made-up data kept in memory: voting, moving forward, tie-breaks, suggesting venues, claiming food, scheduling, changing the night, editing, passing and claiming the torch, the party actions, invites, adding a session, chat and the banner cropper. The planning rules are a rough copy of the server's, enough to walk a session from first notice to Coming up. Typing a message containing "fail" shows the not-sent state.
