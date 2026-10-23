/**
 * Letters attachments (#104), client side: the limits, a check that runs when
 * a file is picked (so a bad file is refused before any upload starts), and
 * the upload itself:
 *
 *   1. POST /api/threads/:threadKey/attachments { name, contentType, size, width?, height? }
 *      → { url, method: "PUT", headers, key }
 *   2. PUT the file straight to S3 at `url` with `headers`
 *   3. the caller sends the message with `attachments: [key]`
 *
 * The server checks the same limits (backend/services/attachments.ts); these
 * are here only so the error shows at once.
 */

export const ATTACHMENT_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'application/pdf'];
export const ATTACHMENT_ACCEPT = ATTACHMENT_TYPES.join(',');
export const ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;
export const MAX_ATTACHMENTS_PER_MESSAGE = 10;

/** Why this file can't be attached, or null if it can. */
export function attachmentProblem(file: File): string | null {
    if (!ATTACHMENT_TYPES.includes(file.type)) return `${file.name}: attach a JPEG, PNG, WebP or GIF image, or a PDF.`;
    if (file.size > ATTACHMENT_MAX_BYTES) return `${file.name} is over 10 MB.`;
    if (file.size === 0) return `${file.name} is empty.`;
    return null;
}

export const isImageType = (contentType: string) => contentType.startsWith('image/');

export function formatBytes(n: number): string {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
    return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** An image's pixel size, so the log can reserve its space; null for PDFs or if the browser can't tell. */
async function imageSize(file: File): Promise<{ width: number; height: number } | null> {
    if (!isImageType(file.type) || typeof createImageBitmap !== 'function') return null;
    try {
        const bitmap = await createImageBitmap(file);
        const size = { width: bitmap.width, height: bitmap.height };
        bitmap.close();
        return size;
    } catch {
        return null;
    }
}

/** Uploads one file for a thread and returns its key. Throws an Error with a message fit to show. */
export async function uploadAttachment(threadKey: string, file: File, token: string | null): Promise<string> {
    const problem = attachmentProblem(file);
    if (problem) throw new Error(problem);
    const size = await imageSize(file);
    const res = await fetch(`/api/threads/${encodeURIComponent(threadKey)}/attachments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ name: file.name, contentType: file.type, size: file.size, ...(size ?? {}) }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data?.url || !data?.key) throw new Error(data?.error || `Couldn't upload ${file.name} (${res.status})`);

    const put = await fetch(data.url, { method: data.method || 'PUT', headers: data.headers ?? {}, body: file });
    if (!put.ok) throw new Error(`Couldn't upload ${file.name} (storage answered ${put.status})`);
    return data.key as string;
}
