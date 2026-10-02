/**
 * Campaign settings (#57): the knobs planning reads. All of them belong to the
 * campaign's owner -- not its Game Master, who may change with a torch pass
 * -- or to an admin, which is also who manages a campaign with no owner.
 *
 *   quorum     headcount a night needs; null = the whole party
 *   tableLink  where online sessions happen (Foundry, Roll20, a Discord voice link)
 *   gmTitle    what the Game Master is called ("Dungeon Master", "Host", ...)
 *
 * The banner joins these in its own slice.
 */
import { query } from "../db/index.js";
import { isUuid } from "../db/model.js";
import { bus } from "../events/index.js";

export class SettingsError extends Error {
    constructor(public status: number, message: string) { super(message); }
}

export interface CampaignSettings {
    owner: string | null;
    gmTitle: string;
    quorum: number | null;
    tableLink: string | null;
}

const toSettings = (r: any): CampaignSettings => ({
    owner: r.owner_id, gmTitle: r.gm_title, quorum: r.quorum, tableLink: r.table_link,
});

function clean(body: any): Record<string, unknown> {
    if (!body || typeof body !== "object") throw new SettingsError(400, "Send the settings to change.");
    const out: Record<string, unknown> = {};
    if ("quorum" in body) {
        const q = body.quorum;
        if (q === null || q === "") out.quorum = null;
        else if (Number.isInteger(q) && q >= 1 && q <= 50) out.quorum = q;
        else throw new SettingsError(400, "Quorum is a headcount from 1 to 50, or empty for the whole party.");
    }
    if ("tableLink" in body) {
        const link = typeof body.tableLink === "string" ? body.tableLink.trim() : body.tableLink;
        if (link === null || link === "") out.table_link = null;
        else if (typeof link === "string" && link.length <= 500 && /^https?:\/\/\S+$/i.test(link)) out.table_link = link;
        else throw new SettingsError(400, "The table link must be an http(s) URL of up to 500 characters.");
    }
    if ("gmTitle" in body) {
        const title = typeof body.gmTitle === "string" ? body.gmTitle.trim() : "";
        if (!title || title.length > 40) throw new SettingsError(400, "The Game Master title must be 1 to 40 characters.");
        out.gm_title = title;
    }
    if (!Object.keys(out).length) throw new SettingsError(400, "Nothing to change: send quorum, tableLink or gmTitle.");
    return out;
}

export async function updateCampaignSettings(actorId: string, campaignId: string, body: unknown): Promise<CampaignSettings> {
    if (!isUuid(campaignId)) throw new SettingsError(404, "Campaign not found.");
    const changes = clean(body);
    const [{ rows: [c] }, { rows: [acct] }] = await Promise.all([
        query(`SELECT owner_id FROM campaigns WHERE id = $1`, [campaignId]),
        query(`SELECT app_role FROM accounts WHERE id = $1`, [actorId]),
    ]);
    if (!c) throw new SettingsError(404, "Campaign not found.");
    if (acct?.app_role !== "admin" && (!c.owner_id || c.owner_id !== actorId)) {
        throw new SettingsError(403, "Only the campaign's owner can change its settings.");
    }
    const cols = Object.keys(changes);
    const { rows: [row] } = await query(
        `UPDATE campaigns SET ${cols.map((col, i) => `${col} = $${i + 2}`).join(", ")} WHERE id = $1 RETURNING *`,
        [campaignId, ...cols.map((col) => changes[col])]);
    bus.publish("campaign.changed", { campaignId, action: "updated" }).catch(() => { /* non-fatal */ });
    return toSettings(row);
}
