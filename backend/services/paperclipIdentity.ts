import { query } from "../db/index.js";
import { pcFetch, paperclipConfigured, PAPERCLIP_COMPANY_ID } from "./paperclipClient.js";

/**
 * Who someone is in Paperclip (#36, plan §4.6; endpoint shape from #29).
 *
 * Access to /api/paperclip used to be "was loaded from the Salesforce User
 * table", which said nothing about Paperclip and 403'd a Paperclip member who
 * signed in any other way. It now follows Paperclip's own company membership:
 * an account is linked to the member whose email matches its own, and the
 * link (`accounts.paperclip_user_id`, the member's principalId) is what the
 * gate reads. Email is how a link is found; the id is what's kept, so a
 * changed email doesn't break it. An admin can set or clear a link by hand for
 * a member whose Paperclip email differs.
 *
 * The member list is read at most once per MEMBERS_TTL_MS for everybody, and a
 * failed read is remembered for as long, so a Paperclip outage costs one slow
 * request per window rather than one per page load.
 */

export interface PaperclipMember {
    principalType?: string;
    principalId?: string;
    status?: string;
    membershipRole?: string;
    user?: { id?: string; email?: string | null } | null;
    removal?: unknown;
}

export interface PaperclipIdentity {
    userId: string;
    role: string | null;
}

export const MEMBERS_TTL_MS = 5 * 60_000;
const LOOKUP_TIMEOUT_MS = 3_000;
/** Membership states that no longer grant anything. */
const GONE = new Set(["archived", "removed", "revoked", "suspended"]);

type MemberList = PaperclipMember[] | null;   // null: Paperclip couldn't be read
let cached: { at: number; members: Promise<MemberList> } | null = null;

/** Injected by tests in place of the control plane. */
let fetchMembers = async (): Promise<MemberList> => {
    if (!paperclipConfigured() || !PAPERCLIP_COMPANY_ID) return null;
    const result = await pcFetch<PaperclipMember[] | { members?: PaperclipMember[] }>(
        `/api/companies/${PAPERCLIP_COMPANY_ID}/members`,
        { signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS) });
    if (result.error) {
        console.warn(`[paperclip] member list unavailable: ${result.error}`);
        return null;
    }
    const data = result.data;
    return Array.isArray(data) ? data : data?.members ?? [];
};

export function setMemberSourceForTests(source: () => Promise<MemberList>) {
    fetchMembers = source;
    cached = null;
}

function companyMembers(now = Date.now()): Promise<MemberList> {
    if (!cached || now - cached.at >= MEMBERS_TTL_MS) {
        cached = { at: now, members: fetchMembers().catch(() => null) };
    }
    return cached.members;
}

const isCurrent = (m: PaperclipMember) =>
    (m.principalType ?? "user") === "user" && !m.removal && !GONE.has(String(m.status ?? "").toLowerCase());

const memberId = (m: PaperclipMember) => m.principalId ?? m.user?.id ?? null;

/**
 * The account's Paperclip identity, or null. Links an unlinked account whose
 * email matches a current member, and unlinks one whose member has left, but
 * only on a member list that was actually read: when Paperclip is down, a
 * stored link stands and nothing new is linked.
 */
export async function resolvePaperclipIdentity(accountId: string): Promise<PaperclipIdentity | null> {
    const { rows: [account] } = await query<{ email: string | null; paperclip_user_id: string | null; paperclip_role: string | null }>(
        `SELECT email, paperclip_user_id, paperclip_role FROM accounts WHERE id = $1`, [accountId]);
    if (!account) return null;
    const stored = account.paperclip_user_id ? { userId: account.paperclip_user_id, role: account.paperclip_role } : null;

    const members = await companyMembers();
    if (!members) return stored;

    if (stored) {
        const member = members.find((m) => memberId(m) === stored.userId);
        if (!member || !isCurrent(member)) {
            await query(`UPDATE accounts SET paperclip_user_id = NULL, paperclip_role = NULL
                          WHERE id = $1 AND paperclip_user_id = $2`, [accountId, stored.userId]);
            return null;
        }
        const role = member.membershipRole ?? null;
        if (role !== stored.role) {
            await query(`UPDATE accounts SET paperclip_role = $2 WHERE id = $1`, [accountId, role]);
        }
        return { userId: stored.userId, role };
    }

    const email = account.email?.toLowerCase();
    if (!email) return null;
    const member = members.find((m) => isCurrent(m) && m.user?.email?.toLowerCase() === email && memberId(m));
    if (!member) return null;
    const userId = memberId(member)!;
    // ux_accounts_paperclip_user: one account per Paperclip user. If another
    // account already holds this one (an admin linked it by hand), leave it.
    const { rowCount } = await query(
        `UPDATE accounts SET paperclip_user_id = $2, paperclip_role = $3
          WHERE id = $1 AND paperclip_user_id IS NULL
            AND NOT EXISTS (SELECT 1 FROM accounts WHERE paperclip_user_id = $2)`,
        [accountId, userId, member.membershipRole ?? null]);
    return rowCount ? { userId, role: member.membershipRole ?? null } : null;
}

/** Admin override: link an account to a Paperclip user by hand, or clear it (null). */
export async function setPaperclipIdentity(accountId: string, userId: string | null, role: string | null = null) {
    const { rows: [row] } = await query<{ id: string }>(
        `UPDATE accounts SET paperclip_user_id = $2, paperclip_role = CASE WHEN $2::text IS NULL THEN NULL ELSE $3 END
          WHERE id = $1 RETURNING id`, [accountId, userId, role]);
    return Boolean(row);
}
