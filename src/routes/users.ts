// routes/users.ts
import { Router, Request, Response } from 'express';
import { body, validationResult } from 'express-validator';
import bcrypt from 'bcryptjs';
import { prisma } from '../utils/prisma';
import { authenticate } from '../middleware/authenticate';
import { asyncHandler } from '../middleware/asyncHandler';
import { uploadToCloudinary } from '../utils/cloudinary';
import { allowedImageHosts } from '../utils/imageFetch';
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

// ─────────────────────────────────────────
// INSTITUTE PROFILE (name, address, board, logo)
// One profile per account, kept on the Institution row. Papers use it for a header that
// is the same on every paper. A member who is not an owner/admin can read it but not change it.
// ─────────────────────────────────────────

const INSTITUTE_SELECT = { id: true, name: true, address: true, affiliation: true, logoUrl: true } as const;

async function canEditInstitute(userId: string, institutionId: string): Promise<boolean> {
  const members = await prisma.teamMember.findMany({ where: { institutionId }, select: { userId: true, role: true } });
  if (members.length === 0) return true; // solo account, nobody else is attached
  return members.some(m => m.userId === userId && (m.role === 'OWNER' || m.role === 'ADMIN'));
}

// GET /api/users/institution
router.get(
  '/institution',
  asyncHandler(async (req: Request, res: Response) => {
    const userId = (req as any).user.userId;
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { institutionId: true, institution: { select: INSTITUTE_SELECT } },
    });
    if (!user?.institution || !user.institutionId) {
      return res.json({ success: true, data: { institution: null, canEdit: true } });
    }
    res.json({
      success: true,
      data: { institution: user.institution, canEdit: await canEditInstitute(userId, user.institutionId) },
    });
  })
);

// PUT /api/users/institution — create the profile on first save, update it after that
router.put(
  '/institution',
  [
    body('name').isString().trim().isLength({ min: 2, max: 120 }).withMessage('Institute name must be 2 to 120 characters'),
    body('address').optional({ nullable: true }).isString().isLength({ max: 300 }).withMessage('Address is too long'),
    body('affiliation').optional({ nullable: true }).isString().isLength({ max: 80 }).withMessage('Board / affiliation is too long'),
    body('logoUrl').optional({ nullable: true }).isString().isLength({ max: 600 }).withMessage('Invalid logo'),
  ],
  asyncHandler(async (req: Request, res: Response) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, error: errors.array()[0].msg });
    }
    const userId = (req as any).user.userId;
    const b = req.body || {};

    // A logo must be one of our own uploads (https, on an allowed image host)
    let logoUrl: string | null = null;
    if (typeof b.logoUrl === 'string' && b.logoUrl.trim()) {
      try {
        const u = new URL(b.logoUrl.trim());
        if (u.protocol !== 'https:' || !allowedImageHosts().includes(u.hostname.toLowerCase())) throw new Error('host');
        logoUrl = u.toString();
      } catch {
        return res.status(400).json({ success: false, error: 'Please upload the logo again (its link is not valid).' });
      }
    }
    const data = {
      name: String(b.name).trim(),
      address: typeof b.address === 'string' && b.address.trim() ? b.address.trim() : null,
      affiliation: typeof b.affiliation === 'string' && b.affiliation.trim() ? b.affiliation.trim() : null,
      logoUrl,
    };

    const user = await prisma.user.findUnique({ where: { id: userId }, select: { institutionId: true } });
    if (!user) return res.status(404).json({ success: false, error: 'User not found' });

    if (user.institutionId) {
      if (!(await canEditInstitute(userId, user.institutionId))) {
        return res.status(403).json({ success: false, error: 'Only the institute owner can change this.' });
      }
      const institution = await prisma.institution.update({ where: { id: user.institutionId }, data, select: INSTITUTE_SELECT });
      return res.json({ success: true, data: { institution, canEdit: true } });
    }

    const institution = await prisma.$transaction(async tx => {
      const created = await tx.institution.create({ data, select: INSTITUTE_SELECT });
      await tx.user.update({ where: { id: userId }, data: { institutionId: created.id } });
      await tx.teamMember.create({ data: { userId, institutionId: created.id, role: 'OWNER' } });
      return created;
    });
    res.status(201).json({ success: true, data: { institution, canEdit: true } });
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