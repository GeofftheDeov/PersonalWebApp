/**
 * Cropping an image in the browser before it's uploaded: campaign banners
 * (#81, 4:1) and an adventurer's art (#273, 3:4) share it.
 */

/** A rectangle of the source image, in its natural pixels. */
export interface CropRect { sx: number; sy: number; sw: number; sh: number }

/** Image types the croppers open. The crop re-encodes to WebP (or JPEG). */
export const CROP_INPUT_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
/** The biggest source file a cropper will open (it's re-encoded far smaller). */
export const CROP_SOURCE_MAX_BYTES = 25 * 1024 * 1024;

const toBlob = (canvas: HTMLCanvasElement, type: string, quality: number) =>
  new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, quality));

/**
 * Draws `crop` of `img` onto a canvas of `aspect` (width : height), at most
 * `maxWidth` wide, and encodes it: WebP where the browser can, else JPEG,
 * stepping the quality down until it fits in `maxBytes`.
 */
export async function cropImage(
  img: HTMLImageElement,
  crop: CropRect,
  { aspect, maxWidth, maxBytes }: { aspect: number; maxWidth: number; maxBytes: number },
): Promise<Blob> {
  const width = Math.max(1, Math.round(Math.min(maxWidth, crop.sw)));
  const height = Math.max(1, Math.round(width / aspect));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('This browser can’t crop images.');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, crop.sx, crop.sy, crop.sw, crop.sh, 0, 0, width, height);

  for (const quality of [0.85, 0.7, 0.5]) {
    let blob = await toBlob(canvas, 'image/webp', quality);
    // Browsers that can't encode WebP hand back a PNG instead.
    if (!blob || blob.type !== 'image/webp') blob = await toBlob(canvas, 'image/jpeg', quality);
    if (blob && blob.size <= maxBytes) return blob;
  }
  throw new Error(`The cropped image is still over ${Math.round(maxBytes / (1024 * 1024))} MB. Try a smaller image.`);
}
