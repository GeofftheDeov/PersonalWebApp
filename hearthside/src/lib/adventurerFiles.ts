/**
 * An adventurer's art (#273) and their uploaded sheet (#274), from Hearthside.
 * As with campaign banners (#81): ask the backend for a presigned S3 PUT, send
 * the file straight to S3, then save the key it gave. The server checks every
 * step is the player's (or an admin's).
 *
 *   POST   /api/tabletop/characters/:id/art/upload-url   then POST …/art { key }
 *   PUT    /api/tabletop/characters/:id/portrait         { artId }
 *   DELETE /api/tabletop/characters/:id/art/:artId
 *   POST   /api/tabletop/characters/:id/sheet/upload-url then PUT …/sheet { key, name, size }
 *   DELETE /api/tabletop/characters/:id/sheet
 */
import { api } from './api';
import { cropImage, type CropRect } from './crop';
import type { AdventurerArt, AdventurerSheetCopy } from './adventurers';

/** Width : height of every piece of art: a portrait. */
export const ART_ASPECT = 3 / 4;
const ART_OUT_WIDTH = 1200;
const ART_MAX_BYTES = 5 * 1024 * 1024;

/** What a sheet copy may be, as the server allows. */
export const SHEET_INPUT_TYPES = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'image/gif'];
export const SHEET_MAX_BYTES = 10 * 1024 * 1024;

export interface ArtReply { art: AdventurerArt[]; portraitUrl: string | null }

const base = (id: string) => `/api/tabletop/characters/${encodeURIComponent(id)}`;

async function putToStorage(path: string, file: Blob, extra: Record<string, unknown> = {}) {
  const put = await api.post<{ url: string; method: 'PUT'; headers: Record<string, string>; key: string }>(
    `${path}/upload-url`, { contentType: file.type, size: file.size, ...extra });
  // Straight to S3 with a plain fetch: the presigned URL is its own credential.
  const res = await fetch(put.url, { method: put.method, headers: put.headers, body: file });
  if (!res.ok) throw new Error(`The upload to storage failed (${res.status}).`);
  return put.key;
}

/** Crops a piece of art to 3:4, uploads it and adds it (the first becomes the portrait). */
export async function uploadArt(characterId: string, img: HTMLImageElement, crop: CropRect): Promise<ArtReply> {
  const blob = await cropImage(img, crop, { aspect: ART_ASPECT, maxWidth: ART_OUT_WIDTH, maxBytes: ART_MAX_BYTES });
  const key = await putToStorage(`${base(characterId)}/art`, blob);
  return api.post<ArtReply>(`${base(characterId)}/art`, { key });
}

export const makePortrait = (characterId: string, artId: string) =>
  api.put<ArtReply>(`${base(characterId)}/portrait`, { artId });

export const removeArt = (characterId: string, artId: string) =>
  api.delete<ArtReply>(`${base(characterId)}/art/${encodeURIComponent(artId)}`);

/** What's wrong with a sheet file before it's sent, or null. */
export function sheetFileProblem(file: Pick<File, 'type' | 'size'>): string | null {
  if (!SHEET_INPUT_TYPES.includes(file.type)) return 'A sheet must be a PDF, or a JPEG, PNG, WebP or GIF image.';
  if (file.size > SHEET_MAX_BYTES) return 'That file is over 10 MB. Pick a smaller one.';
  if (file.size < 1) return 'That file is empty.';
  return null;
}

/** Uploads a copy of the sheet exactly as it is, replacing any earlier copy. */
export async function uploadSheet(characterId: string, file: File): Promise<{ sheet: AdventurerSheetCopy | null }> {
  const problem = sheetFileProblem(file);
  if (problem) throw new Error(problem);
  const key = await putToStorage(`${base(characterId)}/sheet`, file);
  return api.put(`${base(characterId)}/sheet`, { key, name: file.name, size: file.size });
}

export const removeSheet = (characterId: string) =>
  api.delete<{ sheet: AdventurerSheetCopy | null }>(`${base(characterId)}/sheet`);

/** "2.1 MB", "340 KB". */
export function fileSizeLabel(bytes: number | null | undefined): string | null {
  if (!bytes || bytes < 1) return null;
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
