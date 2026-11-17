/**
 * A campaign's page (#224, spec #69): who is in the party and what the viewer
 * may do to it, the torch, the details as the page states them, the edit
 * form, and the words of every confirmation. The rules are the portfolio's
 * (`frontend/src/app/game-night/campaigns/[id]/page.tsx`); the server enforces
 * all of them, so these are display only. Framework-free, so they're tested on
 * their own (test/campaign-page.test.ts).
 */
import type { CampaignStatus, CampaignSummary } from "./campaigns";

/** What a campaign calls its Game Master until the owner names the role (the backend's default). */
export const DEFAULT_GM_TITLE = "Dungeon Master";

/** A campaign as `GET /api/campaigns/:id` sends it (the fields the page reads). */
export interface CampaignDetail extends CampaignSummary {
  createdAt?: string | null;
  gmTitle?: string | null;
  /** How many of the party a night needs; null means the whole party. */
  quorum?: number | null;
  tableLink?: string | null;
  discordGuildId?: string | null;
  discordChannelId?: string | null;
}

/** The account behind a member, as `GET /api/campaigns/:id/members` populates it. */
export interface MemberPerson {
  handle?: string | null;
  name?: string | null;
  firstName?: string | null;
  lastName?: string | null;
}

/** A membership row from `GET /api/campaigns/:id/members`. Only GMs and admins are sent inactive ones. */
export interface Member {
  _id: string;
  /** "Game Master", "Player" or "Invited". */
  status?: string | null;
  /** The member's account; null for an invite nobody has taken up. */
  playerId?: string | null;
  person?: MemberPerson | null;
  /** False once a GM has made them inactive here (#37). */
  isActive?: boolean | null;
  email?: string | null;
  firstName?: string | null;
  lastName?: string | null;
}

export interface Viewer { id: string; email: string | null }
export interface ViewerCaps { appRole: string | null }

const GAME_MASTER = "Game Master";

export const gmTitleOf = (c: { gmTitle?: string | null } | null | undefined): string => c?.gmTitle || DEFAULT_GM_TITLE;

/**
 * What to call a member: their account's handle, then name, then first and
 * last name (the backend's `personDisplayName` order), then the row's own
 * name, then the part of an email before the @, never the whole address.
 */
export function memberName(m: Pick<Member, "person" | "firstName" | "lastName" | "email">): string {
  const p = m.person;
  if (p?.handle) return p.handle;
  if (p?.name) return p.name;
  const personName = [p?.firstName, p?.lastName].filter(Boolean).join(" ");
  if (personName) return personName;
  const rowName = [m.firstName, m.lastName].filter(Boolean).join(" ");
  if (rowName) return rowName;
  if (m.email) return m.email.split("@")[0];
  return "Unknown Player";
}

/** Under a party row's name: the GM title and Owner, or Invited; empty for a plain player. */
export function roleLine(m: Member, c: Pick<CampaignDetail, "owner" | "gmTitle">): string {
  const role = m.status === GAME_MASTER ? gmTitleOf(c) : m.status === "Player" ? "" : m.status || "";
  const owner = !!c.owner && m.playerId === c.owner ? "Owner" : "";
  return [role, owner].filter(Boolean).join(" · ");
}

/** The party as one viewer sees it, and what they may do. */
export interface PartyView {
  /** A GM of this campaign, or an admin. */
  isGM: boolean;
  isAdmin: boolean;
  /** The campaign's owner, or an admin: the planning settings and the banner are theirs. */
  isOwner: boolean;
  active: Member[];
  /** Only GMs and admins are sent these. */
  inactive: Member[];
  /** The GMs with an account. */
  gameMasters: Member[];
  /** The viewer's own membership. */
  mine: Member | null;
  /** The only GM, with others in the party: they pass the torch before they leave. */
  isLastGm: boolean;
  /** Who the torch can pass to: active members with an account who aren't a GM already. */
  torchCandidates: Member[];
  /** The viewer may pass the torch (a GM or an admin, with someone to pass it to). */
  canPassTorch: boolean;
  /** An admin who isn't a GM names who steps down when there's more than one. */
  torchNeedsFrom: boolean;
  /** An admin-managed campaign with nobody holding the torch: a party member may claim it. */
  canClaimTorch: boolean;
  canDeactivate(m: Member): boolean;
  canRemove(m: Member): boolean;
}

export function partyView(c: Pick<CampaignDetail, "owner">, members: readonly Member[], me: Viewer | null, caps: ViewerCaps | null): PartyView {
  const viewerId = me?.id ?? null;
  const isAdmin = caps?.appRole === "admin";
  const email = me?.email?.toLowerCase() ?? null;
  const isMe = (m: Member) => (!!viewerId && m.playerId === viewerId) || (!!email && !!m.email && m.email.toLowerCase() === email);
  const isGM = !!me && (isAdmin || members.some((m) => m.status === GAME_MASTER && isMe(m)));
  const isOwner = !!me && (isAdmin || (!!c.owner && c.owner === viewerId));
  const active = members.filter((m) => m.isActive !== false);
  const inactive = members.filter((m) => m.isActive === false);
  const gameMasters = members.filter((m) => m.status === GAME_MASTER && m.playerId);
  const mine = (viewerId && members.find((m) => m.playerId === viewerId)) || null;
  const isLastGm = mine?.status === GAME_MASTER
    && !members.some((m) => m.status === GAME_MASTER && m.playerId !== viewerId)
    && members.some((m) => m.playerId !== viewerId);
  const torchCandidates = active.filter((m) => m.playerId && m.status !== GAME_MASTER);
  const viewerIsGm = gameMasters.some((m) => m.playerId === viewerId);
  return {
    isGM, isAdmin, isOwner, active, inactive, gameMasters, mine, isLastGm, torchCandidates,
    canPassTorch: isGM && torchCandidates.length > 0,
    torchNeedsFrom: gameMasters.length > 1 && !viewerIsGm,
    canClaimTorch: !c.owner && gameMasters.length === 0 && !isGM && !!viewerId && members.some((m) => m.playerId === viewerId),
    // A GM can't be made inactive (pass the torch first), and an invite has nobody to make inactive.
    canDeactivate: (m) => isGM && m.status !== GAME_MASTER && !!m.playerId,
    // A GM removes players; another GM is an admin's call. Nobody removes themselves: that's leaving.
    canRemove: (m) => (m.playerId ?? null) !== viewerId && (isAdmin || (isGM && m.status !== GAME_MASTER)),
  };
}

/** The heading's line: "5 in the party · Geoff is Dungeon Master". */
export function partyLine(c: Pick<CampaignDetail, "gmTitle">, v: PartyView): string {
  const playing = v.active.filter((m) => m.playerId).length;
  const gms = v.active.filter((m) => m.status === GAME_MASTER);
  const title = gmTitleOf(c);
  const who = gms.length
    ? `${gms.map(memberName).join(", ")} ${gms.length > 1 ? "are" : "is"} ${title}`
    : `no ${title} yet`;
  return `${playing} in the party · ${who}`;
}

/** Passing the torch: who steps down, and whether the campaign gets an owner. */
export function torchPassQuestion(
  c: Pick<CampaignDetail, "owner" | "gmTitle">,
  { to, from, viewerIsGm }: { to: Member; from: Member | null; viewerIsGm: boolean },
): string {
  const stepsDown = viewerIsGm ? "you become a player" : from ? `${memberName(from)} becomes a player` : "no one steps down";
  // An admin-managed campaign is owned by whoever first holds the torch.
  const ownership = c.owner ? "Ownership doesn’t change." : "They become its owner, too.";
  return `Pass the torch to ${memberName(to)}? They become the ${gmTitleOf(c)} and ${stepsDown}. ${ownership}`;
}

export const claimQuestion = (c: Pick<CampaignDetail, "title" | "gmTitle">): string =>
  `You become the ${gmTitleOf(c)} and owner of ${c.title}, and plan its sessions.`;

export const leaveQuestion = (c: Pick<CampaignDetail, "title">): string =>
  `You’ll need the invite link to rejoin ${c.title}.`;

export const removeQuestion = (c: Pick<CampaignDetail, "title">, m: Member): string =>
  `${memberName(m)} leaves ${c.title}.`;

export const inactiveQuestion = (m: Member): string =>
  `The campaign leaves ${memberName(m)}’s list and they can’t read or post in Table Talk. Their characters and history stay, and you can bring them back.`;

// Campaign dates are calendar days stored at midnight UTC: read in UTC so they don't slip a day west of it.
const LONG_DAY = new Intl.DateTimeFormat("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });
const LONG_LOCAL = new Intl.DateTimeFormat("en-US", { month: "long", day: "numeric", year: "numeric" });

function longDay(iso: string | null | undefined, utc = true): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : (utc ? LONG_DAY : LONG_LOCAL).format(d);
}

/** The details panel's facts, as the page states them. */
export function campaignFacts(c: CampaignDetail) {
  return {
    started: longDay(c.startDate),
    ended: longDay(c.endDate),
    /** When it was set up: a moment, so in the reader's own time zone. */
    created: longDay(c.createdAt, false),
    quorum: c.quorum ? `${c.quorum} of the party` : "Whole party",
    /** The table link without its scheme, or null when there's none. */
    table: c.tableLink ? c.tableLink.replace(/^https?:\/\//, "") : null,
    discord: c.discordGuildId ? `Linked${c.discordChannelId ? " (voice channel)" : ""}` : "Not linked",
  };
}

/** The edit form's fields, all strings. */
export interface CampaignForm {
  title: string;
  description: string;
  status: CampaignStatus;
  startDate: string;
  endDate: string;
  discordGuildId: string;
  discordChannelId: string;
  quorum: string;
  tableLink: string;
  gmTitle: string;
}

const dateInput = (iso: string | null | undefined): string => (iso ? new Date(iso).toISOString().slice(0, 10) : "");

export function campaignForm(c: CampaignDetail): CampaignForm {
  return {
    title: c.title,
    description: c.description ?? "",
    status: c.status,
    startDate: dateInput(c.startDate),
    endDate: dateInput(c.endDate),
    discordGuildId: c.discordGuildId ?? "",
    discordChannelId: c.discordChannelId ?? "",
    quorum: c.quorum == null ? "" : String(c.quorum),
    tableLink: c.tableLink ?? "",
    gmTitle: gmTitleOf(c),
  };
}

/**
 * What saving sends: the details any party member may change
 * (`PUT /api/campaigns/:id`), and the owner's planning settings
 * (`PATCH /api/campaigns/:id/settings`), which go only for the owner.
 */
export function formPayload(f: CampaignForm) {
  return {
    details: {
      title: f.title.trim(),
      description: f.description,
      status: f.status,
      startDate: f.startDate || null,
      endDate: f.endDate || null,
      discordGuildId: f.discordGuildId.trim(),
      discordChannelId: f.discordChannelId.trim(),
    },
    settings: {
      quorum: f.quorum.trim() === "" ? null : Number(f.quorum),
      tableLink: f.tableLink.trim(),
      gmTitle: f.gmTitle.trim(),
    },
  };
}

/** The link that lets someone join: Hearthside's invite page (#232). */
export const inviteLink = (origin: string, campaignId: string): string => `${origin}/join/${campaignId}`;
