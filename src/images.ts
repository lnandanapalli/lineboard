/**
 * Preparing a picture for the board: big photos are scaled down (longest side 2000 px) so notes
 * stay quick to load and sync; pictures that may be transparent stay PNG, the rest become JPEG.
 */
const MAX_SIDE = 2000;
export const IMAGE_TYPES = 'image/png,image/jpeg,image/gif,image/webp,image/svg+xml,image/bmp,image/avif';

export interface PreparedImage {
  blob: Blob;
  type: string;
  width: number;
  height: number;
}

export async function prepareImage(file: Blob): Promise<PreparedImage> {
  if (!file.type.startsWith('image/')) throw new Error('That file is not a picture.');
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new Error('This picture could not be read. Try a PNG or JPEG.');
  }
  const { width, height } = bitmap;
  const k = Math.min(1, MAX_SIDE / Math.max(width, height));
  const keep = k === 1 && (file.type === 'image/png' || file.type === 'image/jpeg') && file.size < 4_000_000;
  if (keep) {
    bitmap.close();
    return { blob: file, type: file.type, width, height };
  }
  const w = Math.max(1, Math.round(width * k));
  const h = Math.max(1, Math.round(height * k));
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  c.getContext('2d')!.drawImage(bitmap, 0, 0, w, h);
  bitmap.close();
  const transparent = /png|gif|webp|svg|avif/.test(file.type);
  const type = transparent ? 'image/png' : 'image/jpeg';
  const blob = await new Promise<Blob>((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('Could not prepare the picture'))), type, 0.85));
  return { blob, type, width: w, height: h };
}
