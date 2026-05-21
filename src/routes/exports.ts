// routes/exports.ts
import { Router, Request, Response } from 'express';
import { prisma } from '../utils/prisma';
import { authenticate } from '../middleware/authenticate';
import { asyncHandler } from '../middleware/asyncHandler';

const router = Router();
router.use(authenticate);

// GET /api/exports — list export history
router.get(
  '/',
  asyncHandler(async (req: Request, res: Response) => {
    const userId = (req as any).user.userId;
    const page = parseInt(req.query.page as string) || 1;
    const limit = Math.min(parseInt(req.query.limit as string) || 20, 100);

    const [exports, total] = await Promise.all([
      prisma.export.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
        include: {
          paper: {
            select: {
              title: true,
              examDetails: true,
              totalMarks: true,
            },
          },
        },
      }),
      prisma.export.count({ where: { userId } }),
    ]);

    res.json({
      success: true,
      data: exports,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
        hasNext: page * limit < total,
        hasPrev: page > 1,
      },
    });
  })
);

// GET /api/exports/:id/download — re-download if URL still valid
router.get(
  '/:id/download',
  asyncHandler(async (req: Request, res: Response) => {
    const userId = (req as any).user.userId;
    const { id } = req.params;

    const exportRecord = await prisma.export.findFirst({
      where: { id, userId },
    });

    if (!exportRecord) {
      return res.status(404).json({ success: false, error: 'Export not found' });
    }

    if (!exportRecord.fileUrl) {
      return res.status(410).json({ success: false, error: 'File no longer available. Please re-export.' });
    }

    res.json({ success: true, data: { downloadUrl: exportRecord.fileUrl } });
  })
);

// DELETE /api/exports/:id — remove export record
router.delete(
  '/:id',
  asyncHandler(async (req: Request, res: Response) => {
    const userId = (req as any).user.userId;
    const { id } = req.params;

    const exportRecord = await prisma.export.findFirst({ where: { id, userId } });
    if (!exportRecord) {
      return res.status(404).json({ success: false, error: 'Export not found' });
    }

    await prisma.export.delete({ where: { id } });
    res.json({ success: true, message: 'Export record removed' });
  })
);

export default router;
