import crypto from "crypto";
import { query } from "../db/index.js";
import type { MessageAttachment } from "../events/events.js";
import { integrations, UploadsNotConfiguredError } from "../utils/integrations.js";
import { canAccessThread, parseThreadKey, type ThreadKey, type ThreadPerson } from "./threads.js";

/**
 * Letters attachments (#104, spec #58): images and PDFs on a thread message.
 *
 *   1. requestAttachmentUpload  checks the person can see the thread and that
 *                               the file is an accepted type within 10 MB,
 *                               mints a key under the thread's prefix, records
 *                               it as issued to this sender for this thread,
 *                               and returns a presigned PUT. The browser
 *                               uploads straight to S3.
 *   2. issuedAttachments        at send time, turns the keys a sender names into
 *                               attachment metadata, or refuses if any key
 *                               wasn't issued to that sender for that thread.
 *   3. withAttachmentUrls       adds a short-lived presigned GET to each one,
 *                               for history and live frames. Only ever called
 *                               for people who can see the thread.
 *
 * S3 is reached only through integrations().uploads, the service #81 built for
 * banners. Attachment reads always use `private: true`, so they're presigned
 * GETs that expire even when a CloudFront origin fronts the bucket.
 *
 * Keys are built by the server, never taken from the client:
 *   message-attachments/campaign/<campaignId>/<uuid>.<ext>
 *   message-attachments/dm/<idA>/<idB>/<uuid>.<ext>
 */

/** The types an attachment may be, and the extension each is stored under. */
export const ATTACHMENT_TYPES: Record<string, string> = {
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
    "image/gif": "gif",
    "application/pdf": "pdf",
};

/** 10 MB. */
export const ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;

/** At most this many attachments on one message. */
export const MAX_ATTACHMENTS_PER_MESSAGE = 10;

/** How long the browser has to start the upload. */
const UPLOAD_URL_SECONDS = 300;

/** How long a read URL in history or a live frame works. */
export const ATTACHMENT_URL_SECONDS = 3600;

const PREFIX = "message-attachments";
const MAX_NAME = 200;
/** Larger than any real image; anything else is dropped rather than refused, since it's only a layout hint. */
const MAX_DIMENSION = 100_000;

/** An attachment as stored on messages.attachments and carried on the bus: no URL. */
export type AttachmentMeta = MessageAttachment;

/** An attachment as clients get it: the metadata plus a URL that expires. */
export interface Attachment extends AttachmentMeta {
    url: string | null;
    expiresAt: string | null;
}

export interface AttachmentUpload {
    url: string;
    method: "PUT";
    headers: Record<string, string>;
    key: string;
    expiresAt: Date;
    maxBytes: number;
}

export type UploadRequestResult =
    | { ok: true; upload: AttachmentUpload }
    | { ok: false; status: 400 | 403 | 503; error: string };

const isImage = (contentType: string) => contentType.startsWith("image/");

/** A display name: no path, no control characters, at most 200 characters. */
function cleanName(raw: unknown, ext: string): string {
    const base = typeof raw === "string" ? raw.split(/[\\/]/).pop() ?? "" : "";
    const name = base.replace(/[\u0000-\u001f\u007f]/g, "").replace(/\s+/g, " ").trim().slice(0, MAX_NAME).trim();
    return name || `attachment.${ext}`;
}

const dimension = (n: unknown): number | null =>
    Number.isInteger(n) && (n as number) > 0 && (n as number) <= MAX_DIMENSION ? (n as number) : null;

/** The thread's key prefix: `campaign/<id>` or `dm/<a>/<b>`. Thread ids are uuids, so this is path-safe. */
const threadPrefix = (threadKey: ThreadKey) => `${PREFIX}/${threadKey.split(":").join("/")}`;

/**
 * An upload URL for one file in a thread. `body` is { name, contentType, size,
 * width?, height? } (width and height for images, as the browser measured them).
 */
export async function requestAttachmentUpload(
    person: ThreadPerson,
    threadKey: unknown,
    body: any,
): Promise<UploadRequestResult> {
    if (!parseThreadKey(threadKey)) return { ok: false, status: 400, error: "Invalid thread key" };
    const key = threadKey as ThreadKey;
    if (!(await canAccessThread(person, key))) return { ok: false, status: 403, error: "You can't send to this thread" };

    const contentType = typeof body?.contentType === "string" ? body.contentType.trim().toLowerCase() : "";
    const ext = ATTACHMENT_TYPES[contentType];
    if (!ext) return { ok: false, status: 400, error: "Attach a JPEG, PNG, WebP or GIF image, or a PDF." };
    const size = body?.size;
    if (!Number.isInteger(size) || size < 1) return { ok: false, status: 400, error: "Send the file's size in bytes." };
    if (size > ATTACHMENT_MAX_BYTES) return { ok: false, status: 400, error: "An attachment can be at most 10 MB." };

    const name = cleanName(body?.name, ext);
    const width = isImage(contentType) ? dimension(body?.width) : null;
    const height = isImage(contentType) ? dimension(body?.height) : null;

    const objectKey = `${threadPrefix(key)}/${crypto.randomUUID()}.${ext}`;
    let put;
    try {
        put = await integrations().uploads.presignPut({
            key: objectKey, contentType, contentLength: size, expiresInSeconds: UPLOAD_URL_SECONDS,
        });
    } catch (err) {
        if (err instanceof UploadsNotConfiguredError) {
            return { ok: false, status: 503, error: "Attachments aren't set up on this server yet." };
        }
        throw err;
    }
    // Recorded only once there's a URL to go with it.
    await query(
        `INSERT INTO message_attachment_uploads (key, thread_key, sender_id, name, content_type, size, width, height)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [objectKey, key, String(person.id), name, contentType, size, width, height]);
    return { ok: true, upload: { ...put, maxBytes: ATTACHMENT_MAX_BYTES } };
}

export type IssuedResult =
    | { ok: true; attachments: AttachmentMeta[] }
    | { ok: false; reason: "invalid-attachments" | "too-many-attachments" | "unknown-attachment" };

/**
 * The metadata for the keys a send names, in the order named, or a refusal.
 * Every key must have been issued to this sender for this thread. A key may be
 * named again in a later message by the same sender in the same thread (a
 * resend, or sharing the map again): the audience is the same.
 */
export async function issuedAttachments(senderId: string, threadKey: ThreadKey, keys: unknown): Promise<IssuedResult> {
    if (keys === undefined || keys === null) return { ok: true, attachments: [] };
    if (!Array.isArray(keys) || keys.some((k) => typeof k !== "string" || !k)) return { ok: false, reason: "invalid-attachments" };
    const unique = [...new Set(keys as string[])];
    if (unique.length > MAX_ATTACHMENTS_PER_MESSAGE) return { ok: false, reason: "too-many-attachments" };
    if (!unique.length) return { ok: true, attachments: [] };

    const { rows } = await query<{
        key: string; name: string; size: number; content_type: string; width: number | null; height: number | null;
    }>(
        `SELECT key, name, size, content_type, width, height FROM message_attachment_uploads
          WHERE key = ANY($1::text[]) AND sender_id = $2 AND thread_key = $3`,
        [unique, senderId, threadKey]);
    const byKey = new Map(rows.map((r) => [r.key, r]));
    if (byKey.size !== unique.length) return { ok: false, reason: "unknown-attachment" };

    return {
        ok: true,
        attachments: unique.map((k) => {
            const r = byKey.get(k)!;
            return {
                key: r.key,
                name: r.name,
                size: Number(r.size),
                contentType: r.content_type,
                ...(r.width ? { width: r.width } : {}),
                ...(r.height ? { height: r.height } : {}),
            };
        }),
    };
}

/** `inline; filename="…"; filename*=UTF-8''…`, so a PDF opens in the browser under its own name. */
function inlineDisposition(name: string): string {
    const ascii = name.replace(/[^\x20-\x7e]|["\\]/g, "_");
    return `inline; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

/**
 * Adds a short-lived read URL to each attachment. The caller must already know
 * the reader can see the thread. A URL that can't be made right now (uploads
 * switched off) is null rather than an error, so the message still shows.
 */
export async function withAttachmentUrls(attachments: readonly AttachmentMeta[] | null | undefined): Promise<Attachment[]> {
    if (!attachments?.length) return [];
    return Promise.all(attachments.map(async (a) => {
        try {
            const read = await integrations().uploads.readUrl({
                key: a.key,
                private: true,
                expiresInSeconds: ATTACHMENT_URL_SECONDS,
                contentDisposition: inlineDisposition(a.name),
            });
            return { ...a, url: read.url, expiresAt: read.expiresAt ? read.expiresAt.toISOString() : null };
        } catch {
            return { ...a, url: null, expiresAt: null };
        }
    }));
}
