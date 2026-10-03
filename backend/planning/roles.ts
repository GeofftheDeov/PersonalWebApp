/**
 * Who someone is to a campaign (#57): the Game Master, a party member, or
 * neither. Shared by the planner and the quests module so the two can't drift
 * on who counts as the Game Master.
 */
import type pg from "pg";

type Db = Pick<pg.PoolClient, "query">;

export interface Role {
    admin: boolean;
    /** The campaign's Game Master, this session's stand-in GM, or an admin. */
    gm: boolean;
    /** In the party, or GM by any of the routes above. */
    member: boolean;
}

/** What this person may do in this campaign (and, for a one-session torch pass, this session). */
export async function roleIn(db: Db, actorId: string, campaignId: string, gmOverrideId: string | null = null): Promise<Role> {
    // Sequential: `db` may be a transaction's single client.
    const { rows: [acct] } = await db.query(`SELECT app_role FROM accounts WHERE id = $1`, [actorId]);
    const { rows: memberships } = await db.query(
        `SELECT status FROM campaign_members WHERE campaign_id = $1 AND person_id = $2`, [campaignId, actorId]);
    const admin = acct?.app_role === "admin";
    const gm = admin || gmOverrideId === actorId || memberships.some((m) => m.status === "Game Master");
    return { admin, gm, member: gm || memberships.length > 0 };
}
