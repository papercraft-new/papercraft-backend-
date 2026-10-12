import http from 'http';
import https from 'https';
import { logger } from './logger';

/**
 * Fetches a question/option image on the server (Word export, and the mobile-PDF image proxy).
 *
 * The URL comes from saved paper data, so it is never trusted:
 *  - only hosts in IMAGE_HOST_ALLOWLIST (default: res.cloudinary.com) are contacted
 *  - https only (plain http is allowed outside production, for local testing)
 *  - redirects are not followed, so an allowed host cannot bounce us somewhere else
 *  - PNG or JPEG only (checked by content type AND by the file's own bytes)
 *  - size and time limits
 */

const MAX_BYTES = 5 * 1024 * 1024;
const timeoutMs = () => parseInt(process.env.IMAGE_FETCH_TIMEOUT_MS || '10000', 10);

export interface FetchedImage {
  data: Buffer;
  width: number;
  height: number;
  type: 'png' | 'jpg';
}

export function allowedImageHosts(): string[] {
  return (process.env.IMAGE_HOST_ALLOWLIST || 'res.cloudinary.com')
    .split(',')
    .map(s => s.trim().toLowerCase())
    .filter(Boolean);
}

/** Pixel size and type read from the file's own header; null if it is not a valid PNG/JPEG. */
export function imageInfo(buf: Buffer): { width: number; height: number; type: 'png' | 'jpg' } | null {
  // PNG: 8-byte signature, then the IHDR chunk holding width and height
  if (
    buf.length >= 24 &&
    buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) &&
    buf.toString('ascii', 12, 16) === 'IHDR'
  ) {
    const width = buf.readUInt32BE(16);
    const height = buf.readUInt32BE(20);
    return width > 0 && height > 0 ? { width, height, type: 'png' } : null;
  }
  // JPEG: walk the markers until a "start of frame" gives the size
  if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let off = 2;
    while (off + 9 < buf.length) {
      if (buf[off] !== 0xff) return null;
      const marker = buf[off + 1];
      if (marker === 0xff) { off += 1; continue; } // fill byte
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { off += 2; continue; }
      const len = buf.readUInt16BE(off + 2);
      const isFrame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (isFrame) {
        const height = buf.readUInt16BE(off + 5);
        const width = buf.readUInt16BE(off + 7);
        return width > 0 && height > 0 ? { width, height, type: 'jpg' } : null;
      }
      if (len < 2) return null;
      off += 2 + len;
    }
  }
  return null;
}

function get(url: URL): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const lib = url.protocol === 'https:' ? https : http;
    const req = lib.get(url, { headers: { Accept: 'image/png,image/jpeg' } }, res => {
      const status = res.statusCode || 0;
      if (status !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${status}`)); // includes redirects: deliberately not followed
      }
      const type = String(res.headers['content-type'] || '').toLowerCase();
      if (!type.startsWith('image/png') && !type.startsWith('image/jpeg')) {
        res.resume();
        return reject(new Error(`unexpected content type "${type}"`));
      }
      const declared = parseInt(String(res.headers['content-length'] || '0'), 10);
      if (declared > MAX_BYTES) {
        res.resume();
        return reject(new Error('image too large'));
      }
      const chunks: Buffer[] = [];
      let total = 0;
      res.on('data', (c: Buffer) => {
        total += c.length;
        if (total > MAX_BYTES) {
          req.destroy(new Error('image too large'));
          return;
        }
        chunks.push(c);
      });
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    });
    req.setTimeout(timeoutMs(), () => req.destroy(new Error('timed out')));
    req.on('error', reject);
  });
}

/** Returns the image, or null (and logs why) if it is not allowed or cannot be loaded. */
export async function fetchImageForDocx(rawUrl: string): Promise<FetchedImage | null> {
  try {
    const url = new URL(rawUrl);
    const production = process.env.NODE_ENV === 'production';
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && !production)) {
      throw new Error(`protocol ${url.protocol} not allowed`);
    }
    if (url.username || url.password) throw new Error('credentials in URL not allowed');
    if (!allowedImageHosts().includes(url.hostname.toLowerCase())) {
      throw new Error(`host ${url.hostname} is not in IMAGE_HOST_ALLOWLIST`);
    }
    const data = await get(url);
    const info = imageInfo(data);
    if (!info) throw new Error('not a valid PNG or JPEG file');
    return { data, ...info };
  } catch (err: any) {
    logger.warn(`Image skipped (${err?.message || err}): ${String(rawUrl).slice(0, 120)}`);
    return null;
  }
}