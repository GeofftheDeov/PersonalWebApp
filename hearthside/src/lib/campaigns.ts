/**
 * Campaigns as Hearthside shows them (#223, spec #69): the status filters, a
 * card's dates, the dyed-cloth fallback for a campaign without a banner, and
 * who may change a banner. Framework-free, so the rules are tested on their
 * own (test/campaigns.test.ts).
 */

/** A campaign's status, as the backend stores it. */
export type CampaignStatus = "Not Started" | "In Progress" | "Completed";

/** A campaign as `GET /api/campaigns` lists it (the fields Hearthside reads). */
export interface CampaignSummary {
  _id: string;
  title: string;
  description?: string | null;
  status: CampaignStatus;
  /** Calendar days, stored at midnight UTC (ISO strings). */
  startDate?: string | null;
  endDate?: string | null;
  /** Who set the campaign up (#57): they control its banner. Null when admin-managed. */
  owner?: string | null;
  /** Set when the campaign has a banner, even if it can't be shown right now. */
  bannerKey?: string | null;
  /** Where to read the banner from; null with no banner, or when uploads are off. */
  bannerUrl?: string | null;
}

export type StatusFilter = "All" | CampaignStatus;

/** The Campaigns page's filter tabs, in order. */
export const STATUS_FILTERS: readonly StatusFilter[] = ["All", "In Progress", "Not Started", "Completed"];

/** The statuses a campaign can be given, in the order a form offers them. */
export const CAMPAIGN_STATUSES: readonly CampaignStatus[] = ["Not Started", "In Progress", "Completed"];

/** A status (or All) as the page says it: sentence case. */
export function statusLabel(s: StatusFilter): string {
  return s === "In Progress" ? "In progress" : s === "Not Started" ? "Not started" : s;
}

export function countByStatus(campaigns: readonly CampaignSummary[]): Record<StatusFilter, number> {
  const counts: Record<StatusFilter, number> = { All: campaigns.length, "In Progress": 0, "Not Started": 0, Completed: 0 };
  for (const c of campaigns) if (CAMPAIGN_STATUSES.includes(c.status)) counts[c.status]++;
  return counts;
}

export function filterByStatus<T extends Pick<CampaignSummary, "status">>(campaigns: readonly T[], filter: StatusFilter): T[] {
  return filter === "All" ? [...campaigns] : campaigns.filter((c) => c.status === filter);
}

// Campaign dates are calendar days the form sent as YYYY-MM-DD, which the
// backend stores at midnight UTC: read in UTC so they don't slip a day west of it.
const DAY = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });

function day(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : DAY.format(d);
}

/** A card's dates: "Starts Nov 7, 2026", "Since Mar 14, 2026", or "Sep 6, 2025 – Feb 21, 2026". Empty with no start. */
export function campaignDates(c: Pick<CampaignSummary, "status" | "startDate" | "endDate">): string {
  const start = day(c.startDate);
  if (!start) return "";
  const end = day(c.endDate);
  if (end) return `${start} – ${end}`;
  return c.status === "Not Started" ? `Starts ${start}` : `Since ${start}`;
}

const ARTICLE = /^(the|a|an)$/i;
const SMALL_WORD = /^(of|the|and|a|an)$/i;

/**
 * The initials stitched on a campaign's dyed cloth: the first letter of its
 * first two words, skipping a leading article and small words
 * ("Curse of the Ashen Crown" → "CA").
 */
export function campaignInitials(title: string): string {
  const words = title.split(/\s+/).map((w) => w.replace(/[^\p{L}\p{N}]/gu, "")).filter(Boolean);
  if (words.length > 1 && ARTICLE.test(words[0])) words.shift();
  const kept = words.length > 1 ? words.filter((w, i) => i === 0 || !SMALL_WORD.test(w)) : words;
  const initials = kept.slice(0, 2).map((w) => [...w][0].toUpperCase()).join("");
  return initials || "?";
}

/** Hearthside's dyes for the cloth: verdigris, madder, walnut and moss, each light to dark. */
const CLOTHS: readonly (readonly [string, string])[] = [
  ["#1f4a44", "#0f2422"],
  ["#5a2416", "#2a0f0a"],
  ["#4a3218", "#22160b"],
  ["#2c3a24", "#141c10"],
];

/** A campaign's own cloth, the same every time: pass its id. */
export function clothFor(seed: string): readonly [string, string] {
  let h = 0;
  for (const ch of seed) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return CLOTHS[h % CLOTHS.length];
}

/**
 * Does the viewer see a campaign's banner controls? Its owner and admins do,
 * as the server allows (`requireCampaignOwner`). Display only: the server checks.
 */
export function canManageBanner(
  c: Pick<CampaignSummary, "owner">,
  me: { id: string } | null,
  caps: { appRole: string | null } | null,
): boolean {
  if (!me) return false;
  if (caps?.appRole === "admin") return true;
  return !!c.owner && c.owner === me.id;
}
