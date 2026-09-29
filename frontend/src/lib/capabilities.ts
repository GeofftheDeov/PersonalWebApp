"use client";

import { useEffect, useState } from "react";

/**
 * What the signed-in person may do (#35, plan §3.4).
 *
 * The nav and the Paperclip pages used to gate on `type === 'User'`, read from
 * the `user` object in localStorage. Two problems, both of which the cutover
 * would have turned into visible breakage:
 *
 *   1. After the merge everyone is an account, so `type` is either absent or
 *      "Account" for every person alive. Every one of those gates would have
 *      closed to everybody — including the admin link, which is the only route
 *      into /admin the UI offers.
 *   2. localStorage outlives the token. A JWT expires in an hour, but a stored
 *      `user` object sits there until the next login, so a stale copy can lie
 *      about capability indefinitely.
 *
 * Capability is therefore asked of the server, which reads it from the columns
 * that mean it: `app_role` for authorization, `account_tier` for entitlement,
 * and `sf_object` as provenance. This is for DISPLAY only — deciding what to
 * render. Every one of these surfaces is also gated server-side, and that gate
 * is the one that matters.
 */
export interface Capabilities {
    appRole: "user" | "admin" | null;
    accountTier: "free" | "member" | "patron" | null;
    recordType: string | null;
    handle: string | null;
    profilePicture: string | null;
}

const EMPTY: Capabilities = {
    appRole: null, accountTier: null, recordType: null, handle: null, profilePicture: null,
};

/** Admin portal, /db, and campaign-wide visibility. */
export const canAdmin = (c: Capabilities | null) => c?.appRole === "admin";

/**
 * Paperclip. Geoff's ruling: an admin of Paperclip may hold that access through
 * either Salesforce or the web app, and both get in — so this is the union of
 * the two, matching `paperclipOnly` on the server. Never the tier: what somebody
 * has paid for must not move their access.
 */
export const canPaperclip = (c: Capabilities | null) =>
    c?.appRole === "admin" || c?.recordType === "User";

export async function fetchCapabilities(token: string): Promise<Capabilities | null> {
    try {
        const res = await fetch("/api/users/me/capabilities", {
            headers: { Authorization: `Bearer ${token}` },
        });
        if (!res.ok) return null;
        return { ...EMPTY, ...(await res.json()) };
    } catch {
        return null;
    }
}

/**
 * Capability for the current session, or null while unknown.
 *
 * Null means "not established yet", not "denied" — render nothing capability-
 * gated until it resolves, rather than flashing an admin link at everybody and
 * then removing it.
 */
export function useCapabilities(token: string | null): Capabilities | null {
    const [caps, setCaps] = useState<Capabilities | null>(null);

    useEffect(() => {
        let cancelled = false;
        if (!token) { setCaps(null); return; }
        fetchCapabilities(token).then((c) => { if (!cancelled) setCaps(c); });
        return () => { cancelled = true; };
    }, [token]);

    return caps;
}
