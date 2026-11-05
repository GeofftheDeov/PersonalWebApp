import type { Request } from "express";

/**
 * The frontend sites this backend sends people back to (#215, part of #69).
 *
 * The portfolio and Hearthside both proxy /api to this one backend, so a link
 * the backend builds (a password reset, an email verification, the end of
 * Google Calendar Connect) should land on the site the person started from.
 * The site is taken from the request, but only ever used when it is on this
 * environment's allowlist, so a forged header can never put another host in a
 * link. Anything unknown falls back to the portfolio.
 *
 * The allowlist, per environment, from:
 *   FRONTEND_URL       the portfolio's own origin, and the fallback
 *                      (https://geoffthedeov.net, https://deov.geoffthedeov.net)
 *   PORTFOLIO_ORIGINS  other origins serving the portfolio, comma-separated
 *                      (https://www.geoffthedeov.net in prod; none in dev)
 *   HEARTHSIDE_URL     Hearthside's origin (https://hearthside.geoffthedeov.net,
 *                      https://deov.hearthside.geoffthedeov.net). Unset until
 *                      Hearthside is deployed, and then no host counts as
 *                      Hearthside.
 *
 * Read per call, not at import: route modules load before server.ts runs
 * dotenv.config().
 */

export type SiteName = "portfolio" | "hearthside";

export interface FrontendSite {
    name: SiteName;
    /** Scheme, host and any port, with no trailing slash: what links start with. */
    origin: string;
    /** Lowercase host[:port], as it arrives in Host / X-Forwarded-Host. */
    host: string;
}

const DEFAULT_FRONTEND_URL = "http://localhost:3000";

function toSite(name: SiteName, value: string | undefined): FrontendSite | null {
    const raw = value?.trim();
    if (!raw) return null;
    try {
        const url = new URL(raw);
        return { name, origin: url.origin, host: url.host.toLowerCase() };
    } catch {
        console.warn(`[sites] ignoring ${name} origin that isn't a URL: ${raw}`);
        return null;
    }
}

/** The portfolio at FRONTEND_URL: where anything unknown is sent. */
export function portfolioSite(): FrontendSite {
    return toSite("portfolio", process.env.FRONTEND_URL)
        ?? (toSite("portfolio", DEFAULT_FRONTEND_URL) as FrontendSite);
}

/** Hearthside at HEARTHSIDE_URL, or null in an environment that doesn't have it yet. */
export function hearthsideSite(): FrontendSite | null {
    return toSite("hearthside", process.env.HEARTHSIDE_URL);
}

/** Every site on this environment's allowlist, the portfolio's own origin first. */
export function frontendSites(): FrontendSite[] {
    const sites = [portfolioSite()];
    for (const origin of (process.env.PORTFOLIO_ORIGINS ?? "").split(",")) {
        const site = toSite("portfolio", origin);
        if (site) sites.push(site);
    }
    const hearthside = hearthsideSite();
    if (hearthside) sites.push(hearthside);
    return sites;
}

/**
 * Game Night pages as the backend links to them (#214): in bell notifications,
 * the quest-reminder email, Table Talk posts and calendar events.
 *
 * With HEARTHSIDE_URL set, an absolute link on Hearthside, on Hearthside's
 * paths. Without it, the portfolio's relative /game-night/... path, as before
 * Hearthside, which the portfolio's 308 redirects (#234) later send on.
 */
function gameNightLink(path: string): string {
    const hearthside = hearthsideSite();
    return hearthside ? `${hearthside.origin}${path}` : `/game-night${path}`;
}

export const gameNightLinks = {
    campaign: (campaignId: string) => gameNightLink(`/campaigns/${campaignId}`),
    noticeBoard: (campaignId: string) => gameNightLink(`/campaigns/${campaignId}#notice-board`),
    session: (sessionId: string) => gameNightLink(`/sessions/${sessionId}`),
    sessionQuests: (sessionId: string) => gameNightLink(`/sessions/${sessionId}#quests`),
    /**
     * A campaign invite's page on Hearthside. Undefined without Hearthside:
     * the invite's bell entry had no link before, and is answered in the bell.
     */
    invite: (campaignId: string): string | undefined => {
        const hearthside = hearthsideSite();
        return hearthside ? `${hearthside.origin}/join/${campaignId}` : undefined;
    },
};

/**
 * What a session's Discord and Google Calendar events (and its shareable
 * Google link's `details`) say: the session's Hearthside page. Undefined
 * without Hearthside, so the events carry no description, as since #213.
 */
export function sessionEventDescription(sessionId: string): string | undefined {
    return hearthsideSite() ? gameNightLinks.session(sessionId) : undefined;
}

/**
 * Whether a description is exactly what sessionEventDescription writes on
 * this environment: its Hearthside session page and nothing else. The calendar
 * link scrub (utils/prepNotes.ts) keeps only that, so an agenda, which could
 * contain anything, is never mistaken for it.
 */
export function isSessionEventDescription(description: string): boolean {
    const hearthside = hearthsideSite();
    if (!hearthside || !description.startsWith(`${hearthside.origin}/sessions/`)) return false;
    return /^[0-9a-f-]{36}$/i.test(description.slice(`${hearthside.origin}/sessions/`.length));
}

/** The allowed site serving `host`, or null when the host isn't on the allowlist. */
export function siteForHost(host: unknown): FrontendSite | null {
    if (typeof host !== "string") return null;
    const want = host.trim().toLowerCase();
    if (!want) return null;
    return frontendSites().find((site) => site.host === want) ?? null;
}

/**
 * The host the browser asked for. Behind a site's Next rewrite proxy that is
 * X-Forwarded-Host (the proxy replaces Host with the backend's own); a request
 * made straight to the backend has only Host. Only the first of a chain counts.
 */
export function requestHost(req: Pick<Request, "headers">): string | undefined {
    const forwarded = req.headers["x-forwarded-host"];
    const first = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(",")[0]?.trim();
    return first || req.headers.host;
}

/** The site a request came from, or the portfolio when its host isn't allowed. */
export function originSite(req: Pick<Request, "headers">): FrontendSite {
    return siteForHost(requestHost(req)) ?? portfolioSite();
}

/** Where a site keeps the person's own page: /profile on the portfolio, /room on Hearthside. */
export function profilePath(site: FrontendSite): string {
    return site.name === "hearthside" ? "/room" : "/profile";
}
