// routes/users.ts
import { Router, Request, Response } from 'express';
import { body, validationResult } from 'express-validator';
import bcrypt from 'bcryptjs';
import { prisma } from '../utils/prisma';
import { authenticate } from '../middleware/authenticate';
import { asyncHandler } from '../middleware/asyncHandler';
import { uploadToCloudinary } from '../utils/cloudinary';
import multer from 'multer';

const router = Router();
router.use(authenticate);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB for avatar
  fileFilter: (_req, file, cb) => {
    if (file.mimetype.startsWith('image/')) cb(null, true);
    else cb(new Error('Only images allowed for avatar'));
  },
});

// GET /api/users/profile
router.get(
  '/profile',
  asyncHandler(async (req: Request, res: Response) => {
    const userId = (req as any).user.userId;

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        name: true,
        avatarUrl: true,
        role: true,
        emailVerified: true,
        createdAt: true,
        lastLoginAt: true,
        subscription: { include: { plan: true } },
        institution: { select: { id: true, name: true, logoUrl: true } },
        _count: { select: { papers: true, exports: true, ocrJobs: true } },
      },
    });

    if (!user) return res.status(404).json({ success: false, error: 'User not found' });

    res.json({ success: true, data: user });
  })
);

// PATCH /api/users/profile
router.patch(
  '/profile',
  [
    body('name').optional().trim().isLength({ min: 2, max: 80 }),
    body('currentPassword').optional().isString(),
    body('newPassword').optional().isLength({ min: 8 }),
  ],
  asyncHandler(async (req: Request, res: Response) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    const userId = (req as any).user.userId;
    const { name, currentPassword, newPassword } = req.body;

    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) return res.status(404).json({ success: false, error: 'User not found' });

    const updateData: Record<string, unknown> = {};

    if (name) updateData.name = name;

    if (newPassword) {
      if (!currentPassword) {
        return res.status(400).json({ success: false, error: 'Current password required to set new password' });
      }
      if (!user.passwordHash) {
        return res.status(400).json({ success: false, error: 'Cannot set password for OAuth accounts' });
      }
      const valid = await bcrypt.compare(currentPassword, user.passwordHash);
      if (!valid) {
        return res.status(400).json({ success: false, error: 'Current password is incorrect' });
      }
      updateData.passwordHash = await bcrypt.hash(newPassword, 12);
    }

    const updated = await prisma.user.update({
      where: { id: userId },
      data: updateData,
      select: { id: true, email: true, name: true, avatarUrl: true, role: true },
    });

    res.json({ success: true, data: updated, message: 'Profile updated successfully' });
  })
);

// POST /api/users/avatar
router.post(
  '/avatar',
  upload.single('avatar'),
  asyncHandler(async (req: Request, res: Response) => {
    if (!req.file) {
      return res.status(400).json({ success: false, error: 'No file uploaded' });
    }

    const userId = (req as any).user.userId;

    const avatarUrl = await uploadToCloudinary(
      req.file.buffer,
      req.file.mimetype,
      `avatars/${userId}`
    );

    const updated = await prisma.user.update({
      where: { id: userId },
      data: { avatarUrl },
      select: { avatarUrl: true },
    });

    res.json({ success: true, data: { avatarUrl: updated.avatarUrl } });
  })
);

// GET /api/users/usage
router.get(
  '/usage',
  asyncHandler(async (req: Request, res: Response) => {
    const userId = (req as any).user.userId;
    const thisMonthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1);

    const [subscription, papersThisMonth, exportsThisMonth, ocrJobs] = await Promise.all([
      prisma.subscription.findUnique({
        where: { userId },
        include: { plan: true },
      }),
      prisma.paper.count({ where: { userId, createdAt: { gte: thisMonthStart } } }),
      prisma.export.count({ where: { userId, createdAt: { gte: thisMonthStart } } }),
      prisma.ocrJob.count({ where: { userId } }),
    ]);

    const plan = subscription?.plan;
    res.json({
      success: true,
      data: {
        plan: plan?.type || 'FREE',
        papersUsed: subscription?.papersUsedThisMonth || papersThisMonth,
        papersLimit: plan?.papersPerMonth || 5,
        exportsUsed: subscription?.exportsUsedThisMonth || exportsThisMonth,
        exportsLimit: plan?.exportsPerMonth || 10,
        ocrJobsTotal: ocrJobs,
        periodEnd: subscription?.currentPeriodEnd,
      },
    });
  })
);

// DELETE /api/users/account — soft delete (deactivate)
router.delete(
  '/account',
  asyncHandler(async (req: Request, res: Response) => {
    const userId = (req as any).user.userId;
    await prisma.user.update({ where: { id: userId }, data: { isActive: false } });
    res.json({ success: true, message: 'Account deactivated. Contact support to recover.' });
  })
);

export default router;
