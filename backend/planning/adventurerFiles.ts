/**
 * An adventurer's art (#273) and their full sheet (#274), from spec #198.
 *
 * Art: any number of pieces, one of them the portrait.
 *   1. requestArtUpload  checks the type and size, mints a key under this
 *                        character's prefix, and returns a presigned PUT the
 *                        browser uploads the 3:4 crop to.
 *   2. addArt            saves that key as a new piece (the first becomes the portrait).
 *   3. setPortrait       makes another piece the portrait.
 *   4. removeArt         deletes a piece; the portrait moves to the next one.
 *
 * The full sheet: a link (`sheetUrl`, set through PUT /characters/:id; see
 * sheetUrlProblem) and/or an uploaded copy, a PDF or picture kept exactly as
 * uploaded and never read into fields.
 *   1. requestSheetUpload  checks type and size, returns a presigned PUT.
 *   2. setSheet            saves the key with the file's name and size,
 *                          replacing (and deleting) any earlier copy.
 *   3. clearSheet          removes the copy.
 *
 * Writes are the player's or an admin's (requireOwner); reads go to whoever
 * may read the character (tabletopRoutes' canSeeCharacter). Art is read like
 * campaign banners (CloudFront when configured); a sheet copy always through
 * a presigned GET that expires and keeps the file's name.
 *
 * As with banners (#81), keys are built by the server and a save accepts only
 * a key of exactly the shape minted for the same character:
 *   character-art/<characterId>/<uuid>.<jpg|png|webp>
 *   character-sheets/<characterId>/<uuid>.<pdf|jpg|png|webp|gif>
 */
import crypto from "crypto";
import { query } from "../db/index.js";
import { isUuid } from "../db/model.js";
import { integrations, UploadsNotConfiguredError } from "../utils/integrations.js";
import { getAuthorizedCampaignIds } from "../utils/gameNightPlannerUtils.js";

export class AdventurerFileError extends Error {
    constructor(public status: number, message: string) { super(message); }
}

/** The image types art may be, and the extension each is stored under. */
export const ART_TYPES: Record<string, string> = {
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
};
/** 5 MB, as banners. */
export const ART_MAX_BYTES = 5 * 1024 * 1024;
/** More than anyone needs on one adventurer, few enough to list in one go. */
export const MAX_ART_PIECES = 40;

/** What an uploaded sheet may be: a PDF or a picture, as Letters attachments. */
export const SHEET_TYPES: Record<string, string> = {
    "application/pdf": "pdf",
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
    "image/gif": "gif",
};
const SHEET_TYPE_OF_EXT: Record<string, string> = Object.fromEntries(Object.entries(SHEET_TYPES).map(([t, e]) => [e, t]));
/** 10 MB, as Letters attachments. */
export const SHEET_MAX_BYTES = 10 * 1024 * 1024;
export const MAX_SHEET_URL = 2000;
const MAX_SHEET_NAME = 200;

const UPLOAD_URL_SECONDS = 300;
/** How long the link to a sheet copy works. */
const SHEET_URL_SECONDS = 3600;

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const ART_KEY_RE = new RegExp(`^character-art/([0-9a-f-]{36})/${UUID}\\.(jpg|png|webp)$`);
const SHEET_KEY_RE = new RegExp(`^character-sheets/([0-9a-f-]{36})/${UUID}\\.(pdf|jpg|png|webp|gif)$`);

const keyOf = (re: RegExp, key: unknown, characterId: string) => {
    const m = typeof key === "string" ? re.exec(key) : null;
    return m && m[1] === characterId.toLowerCase() ? m : null;
};

function notConfigured(err: unknown): never {
    if (err instanceof UploadsNotConfiguredError) {
        throw new AdventurerFileError(503, "Uploads aren't set up on this server yet.");
    }
    throw err;
}

/** Best effort: a failure leaves an orphan object, never a broken adventurer. */
function deleteQuietly(key: string | null | undefined) {
    if (!key) return;
    integrations().uploads.deleteObject(key).catch((err) => {
        console.warn(`Could not delete ${key}:`, err?.message ?? err);
    });
}

/** The character, if the actor is its player or an admin; 404 or 403 otherwise. */
async function requireOwner(actor: { id: string }, characterId: string): Promise<{ id: string }> {
    if (!isUuid(characterId)) throw new AdventurerFileError(404, "Character not found");
    const { rows: [c] } = await query(`SELECT id, player_id FROM characters WHERE id = $1`, [characterId]);
    if (!c) throw new AdventurerFileError(404, "Character not found");
    if (String(c.player_id) !== String(actor.id) && (await getAuthorizedCampaignIds(actor)) !== null) {
        throw new AdventurerFileError(403, "Only the character's player can change it");
    }
    return { id: String(c.id) };
}

function checkUpload(body: any, types: Record<string, string>, maxBytes: number, what: string) {
    const contentType = typeof body?.contentType === "string" ? body.contentType.trim().toLowerCase() : "";
    const ext = types[contentType];
    if (!ext) {
        throw new AdventurerFileError(400, what === "art"
            ? "Art must be a JPEG, PNG or WebP image."
            : "A sheet must be a PDF, or a JPEG, PNG, WebP or GIF image.");
    }
    const size = body?.size;
    if (!Number.isInteger(size) || size < 1) throw new AdventurerFileError(400, "Send the file's size in bytes.");
    if (size > maxBytes) throw new AdventurerFileError(400, `${what === "art" ? "A piece of art" : "A sheet"} can be at most ${maxBytes / (1024 * 1024)} MB.`);
    return { contentType, ext, size: size as number };
}

async function presign(key: string, contentType: string, size: number, maxBytes: number) {
    const put = await integrations().uploads
        .presignPut({ key, contentType, contentLength: size, expiresInSeconds: UPLOAD_URL_SECONDS })
        .catch(notConfigured);
    return { ...put, maxBytes };
}

// ---------------------------------------------------------------- art

export interface ArtPiece { _id: string; url: string | null; isPortrait: boolean; createdAt: string }

/** Where the browser can read a piece of art, or null (uploads switched off). Never throws. */
export async function artUrlFor(key: string | null | undefined): Promise<string | null> {
    if (!key) return null;
    try {
        return (await integrations().uploads.readUrl({ key })).url;
    } catch {
        return null;
    }
}

/** Each character's portrait URL, by character id, in one query. */
export async function portraitUrls(characterIds: string[]): Promise<Map<string, string | null>> {
    const out = new Map<string, string | null>();
    if (!characterIds.length) return out;
    const { rows } = await query(
        `SELECT c.id, a.file_key FROM characters c JOIN character_art a ON a.id = c.portrait_art_id
          WHERE c.id = ANY($1::uuid[])`, [characterIds]);
    await Promise.all(rows.map(async (r: any) => out.set(String(r.id), await artUrlFor(r.file_key))));
    return out;
}

/** A character's art, in order, the portrait marked. */
export async function artOf(characterId: string): Promise<ArtPiece[]> {
    const { rows } = await query(
        `SELECT a.id, a.file_key, a.created_at, (c.portrait_art_id = a.id) AS is_portrait
           FROM character_art a JOIN characters c ON c.id = a.character_id
          WHERE a.character_id = $1 ORDER BY a.position, a.created_at`, [characterId]);
    return Promise.all(rows.map(async (r: any) => ({
        _id: String(r.id),
        url: await artUrlFor(r.file_key),
        isPortrait: !!r.is_portrait,
        createdAt: new Date(r.created_at).toISOString(),
    })));
}

/** The art and portrait as a write's reply. */
async function artReply(characterId: string) {
    const art = await artOf(characterId);
    return { art, portraitUrl: art.find((a) => a.isPortrait)?.url ?? null };
}

export async function requestArtUpload(actor: { id: string }, characterId: string, body: any) {
    const c = await requireOwner(actor, characterId);
    const { contentType, ext, size } = checkUpload(body, ART_TYPES, ART_MAX_BYTES, "art");
    return presign(`character-art/${c.id}/${crypto.randomUUID()}.${ext}`, contentType, size, ART_MAX_BYTES);
}

export async function addArt(actor: { id: string }, characterId: string, body: any) {
    const c = await requireOwner(actor, characterId);
    const key = body?.key;
    if (!keyOf(ART_KEY_RE, key, c.id)) {
        throw new AdventurerFileError(400, "That isn't art uploaded for this adventurer. Request an upload URL first.");
    }
    const { rows: [{ n }] } = await query(`SELECT count(*)::int AS n FROM character_art WHERE character_id = $1`, [c.id]);
    if (n >= MAX_ART_PIECES) throw new AdventurerFileError(400, `An adventurer can have at most ${MAX_ART_PIECES} pieces of art.`);
    // A key saved twice is one piece (a retried save), not two.
    const { rows: [piece] } = await query(
        `INSERT INTO character_art (character_id, file_key, position)
         VALUES ($1, $2, (SELECT coalesce(max(position), -1) + 1 FROM character_art WHERE character_id = $1))
         ON CONFLICT (file_key) DO NOTHING RETURNING id`, [c.id, key]);
    // The first piece becomes the portrait; so does any piece added while there's none.
    if (piece) await query(`UPDATE characters SET portrait_art_id = $2 WHERE id = $1 AND portrait_art_id IS NULL`, [c.id, piece.id]);
    return artReply(c.id);
}

export async function setPortrait(actor: { id: string }, characterId: string, body: any) {
    const c = await requireOwner(actor, characterId);
    const artId = body?.artId;
    if (typeof artId !== "string" || !isUuid(artId)) throw new AdventurerFileError(400, "Name the piece of art to make the portrait.");
    const { rowCount } = await query(
        `UPDATE characters SET portrait_art_id = a.id FROM character_art a
          WHERE characters.id = $1 AND a.id = $2 AND a.character_id = $1`, [c.id, artId]);
    if (!rowCount) throw new AdventurerFileError(404, "That piece of art isn't this adventurer's.");
    return artReply(c.id);
}

export async function removeArt(actor: { id: string }, characterId: string, artId: string) {
    const c = await requireOwner(actor, characterId);
    if (!isUuid(artId)) throw new AdventurerFileError(404, "That piece of art isn't this adventurer's.");
    const { rows: [gone] } = await query(
        `DELETE FROM character_art WHERE id = $2 AND character_id = $1 RETURNING file_key`, [c.id, artId]);
    if (!gone) throw new AdventurerFileError(404, "That piece of art isn't this adventurer's.");
    // The FK cleared the portrait if it was this piece; the next piece takes its place.
    await query(
        `UPDATE characters SET portrait_art_id =
           (SELECT id FROM character_art WHERE character_id = $1 ORDER BY position, created_at LIMIT 1)
          WHERE id = $1 AND portrait_art_id IS NULL`, [c.id]);
    deleteQuietly(gone.file_key);
    return artReply(c.id);
}

// ---------------------------------------------------------------- the sheet

export interface SheetCopy { name: string; contentType: string; size: number | null; url: string | null }

/**
 * What's wrong with a sheet link, or null: an http(s) URL of at most 2,000
 * characters. Nothing else is a link a party member should be sent to.
 */
export function sheetUrlProblem(value: unknown): string | null {
    if (value === null) return null;
    if (typeof value !== "string") return "sheetUrl must be a link";
    if (value.length > MAX_SHEET_URL) return `sheetUrl can be at most ${MAX_SHEET_URL} characters`;
    let url: URL;
    try { url = new URL(value); } catch { return "sheetUrl must be a full link, starting with https://"; }
    if (url.protocol !== "https:" && url.protocol !== "http:") return "sheetUrl must be an http or https link";
    return null;
}

/** A character's uploaded sheet as a reader gets it, with a URL that expires; null when there's none. */
export async function sheetCopyOf(row: { sheetKey?: string | null; sheetName?: string | null; sheetType?: string | null; sheetSize?: number | null }): Promise<SheetCopy | null> {
    if (!row.sheetKey) return null;
    const name = row.sheetName || "sheet";
    let url: string | null = null;
    try {
        url = (await integrations().uploads.readUrl({
            key: row.sheetKey,
            private: true,
            expiresInSeconds: SHEET_URL_SECONDS,
            contentDisposition: `inline; filename*=UTF-8''${encodeURIComponent(name)}`,
        })).url;
    } catch { /* uploads switched off: the copy shows without a link */ }
    return { name, contentType: row.sheetType ?? "application/octet-stream", size: row.sheetSize ?? null, url };
}

/** The file name as given, without a path or control characters; "sheet.<ext>" when there's nothing left. */
function cleanName(name: unknown, ext: string): string {
    const base = typeof name === "string" ? name.split(/[\\/]/).pop()!.replace(/[\u0000-\u001f\u007f]/g, "").trim() : "";
    return (base || `sheet.${ext}`).slice(0, MAX_SHEET_NAME);
}

export async function requestSheetUpload(actor: { id: string }, characterId: string, body: any) {
    const c = await requireOwner(actor, characterId);
    const { contentType, ext, size } = checkUpload(body, SHEET_TYPES, SHEET_MAX_BYTES, "sheet");
    return presign(`character-sheets/${c.id}/${crypto.randomUUID()}.${ext}`, contentType, size, SHEET_MAX_BYTES);
}

export async function setSheet(actor: { id: string }, characterId: string, body: any) {
    const c = await requireOwner(actor, characterId);
    const m = keyOf(SHEET_KEY_RE, body?.key, c.id);
    if (!m) throw new AdventurerFileError(400, "That isn't a sheet uploaded for this adventurer. Request an upload URL first.");
    const ext = m[2];
    const size = Number.isInteger(body?.size) && body.size > 0 && body.size <= SHEET_MAX_BYTES ? body.size : null;
    return saveSheet(c.id, { key: body.key, name: cleanName(body?.name, ext), type: SHEET_TYPE_OF_EXT[ext], size });
}

export async function clearSheet(actor: { id: string }, characterId: string) {
    const c = await requireOwner(actor, characterId);
    return saveSheet(c.id, null);
}

async function saveSheet(characterId: string, copy: { key: string; name: string; type: string; size: number | null } | null) {
    // Read the key being replaced under a row lock, in the same statement as the
    // write, so two saves at once each delete what they really replaced.
    const { rows: [row] } = await query(
        `UPDATE characters c SET sheet_key = $2, sheet_name = $3, sheet_type = $4, sheet_size = $5
           FROM (SELECT id, sheet_key FROM characters WHERE id = $1 FOR UPDATE) old
          WHERE c.id = old.id
         RETURNING old.sheet_key AS previous`,
        [characterId, copy?.key ?? null, copy?.name ?? null, copy?.type ?? null, copy?.size ?? null]);
    const previous: string | null = row?.previous ?? null;
    if (previous && previous !== (copy?.key ?? null) && keyOf(SHEET_KEY_RE, previous, characterId)) deleteQuietly(previous);
    return {
        sheet: copy ? await sheetCopyOf({ sheetKey: copy.key, sheetName: copy.name, sheetType: copy.type, sheetSize: copy.size }) : null,
    };
}
