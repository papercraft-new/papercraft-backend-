import { Router, Request, Response, NextFunction } from 'express';
import multer from 'multer';
import { randomUUID } from 'crypto';
import { rateLimit } from 'express-rate-limit';
import { authenticate } from '../middleware/authenticate';
import { asyncHandler } from '../middleware/asyncHandler';
import { uploadImageBuffer } from '../utils/cloudinary';
import { fetchImageForDocx } from '../utils/imageFetch';
import { logger } from '../utils/logger';

const router = Router();
router.use(authenticate);

const MAX_IMAGE_MB = parseFloat(process.env.MAX_IMAGE_MB || '3');
const MAX_IMAGE_BYTES = Math.round(MAX_IMAGE_MB * 1024 * 1024);

// Uploads per user (falls back to IP) per hour
const imageLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: parseInt(process.env.IMAGE_UPLOADS_PER_HOUR || '200'),
  keyGenerator: (req: Request) => (req as any).user?.userId || req.ip || 'anonymous',
  validate: false,
  message: { success: false, error: 'Too many image uploads. Please try again later.' },
});

// Image downloads through the proxy (mobile PDF fallback) per user per hour
const proxyLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: parseInt(process.env.IMAGE_PROXY_PER_HOUR || '1000'),
  keyGenerator: (req: Request) => (req as any).user?.userId || req.ip || 'anonymous',
  validate: false,
  message: { success: false, error: 'Too many image requests. Please try again later.' },
});

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_IMAGE_BYTES, files: 1 },
  fileFilter: (_req, file, cb) => {
    if (file.mimetype === 'image/png' || file.mimetype === 'image/jpeg') cb(null, true);
    else cb(new Error('Only PNG or JPEG images can be attached.'));
  },
});

// Turn multer problems into clear 4xx answers (the global handler would say 500 / "50MB")
function receiveImage(req: Request, res: Response, next: NextFunction) {
  upload.single('image')(req, res, (err: any) => {
    if (!err) return next();
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({ success: false, error: `Image too large. Maximum size is ${MAX_IMAGE_MB}MB.` });
    }
    return res.status(400).json({ success: false, error: err.message || 'Could not read the image.' });
  });
}

// The declared type can be faked, so check the file's own first bytes too.
function looksLikeImage(buf: Buffer, mime: string): boolean {
  if (mime === 'image/png') {
    return buf.length > 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  }
  return buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
}

// ─────────────────────────────────────────
// UPLOAD ONE QUESTION / OPTION IMAGE
// POST /api/images   (multipart, field name: "image")
// Returns { success, image: { id, url, width, height } }
// ─────────────────────────────────────────
router.post(
  '/',
  imageLimiter,
  receiveImage,
  asyncHandler(async (req: Request, res: Response) => {
    if (!req.file) {
      return res.status(400).json({ success: false, error: 'No image uploaded' });
    }
    if (!looksLikeImage(req.file.buffer, req.file.mimetype)) {
      return res.status(400).json({ success: false, error: 'That file is not a valid PNG or JPEG image.' });
    }

    const userId = (req as any).user.userId;
    const uploaded = await uploadImageBuffer(req.file.buffer, `question-images/${userId}`, MAX_IMAGE_BYTES);
    logger.info(`Question image uploaded by ${userId}: ${uploaded.width}x${uploaded.height}, ${req.file.size} bytes`);

    res.status(201).json({
      success: true,
      image: { id: randomUUID(), url: uploaded.url, width: uploaded.width, height: uploaded.height },
    });
  })
);

// ─────────────────────────────────────────
// IMAGE PROXY (used by the mobile PDF when the image host does not allow
// cross-origin use). Same safety rules as the Word export: allow-listed
// host only, https, PNG/JPEG only, size and time limits.
// GET /api/images/proxy?url=<image url>
// ─────────────────────────────────────────
router.get(
  '/proxy',
  proxyLimiter,
  asyncHandler(async (req: Request, res: Response) => {
    const url = typeof req.query.url === 'string' ? req.query.url : '';
    if (!url || url.length > 2000) {
      return res.status(400).json({ success: false, error: 'Missing image address' });
    }
    const img = await fetchImageForDocx(url);
    if (!img) {
      return res.status(502).json({ success: false, error: 'Could not load the image' });
    }
    res
      .set({
        'Content-Type': img.type === 'png' ? 'image/png' : 'image/jpeg',
        'Cache-Control': 'private, max-age=3600',
        'X-Content-Type-Options': 'nosniff',
      })
      .send(img.data);
  })
);

export default router;