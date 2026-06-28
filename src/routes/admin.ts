import { Router, Request, Response } from 'express';
import { prisma } from '../utils/prisma';
import { authenticate } from '../middleware/authenticate';
import { requireAdmin } from '../middleware/requireAdmin';
import { asyncHandler } from '../middleware/asyncHandler';

const router = Router();
router.use(authenticate, requireAdmin);

// ─────────────────────────────────────────
// ADMIN STATS
// GET /api/admin/stats
// ─────────────────────────────────────────

router.get(
  '/stats',
  asyncHandler(async (_req: Request, res: Response) => {
    const now = new Date();
    const lastMonth = new Date(now.getFullYear(), now.getMonth() - 1, now.getDate());
    const thisMonthStart = new Date(now.getFullYear(), now.getMonth(), 1);

    const [
      totalUsers,
      activeUsers,
      totalPapers,
      totalExports,
      totalOcrJobs,
      papersThisMonth,
      signupsThisMonth,
      usersByPlan,
      revenueResult,
    ] = await Promise.all([
      prisma.user.count({ where: { isActive: true } }),
      prisma.user.count({ where: { lastLoginAt: { gte: lastMonth } } }),
      prisma.paper.count({ where: { status: { not: 'ARCHIVED' } } }),
      prisma.export.count({ where: { status: 'ready' } }),
      prisma.ocrJob.count({ where: { status: 'COMPLETED' } }),
      prisma.paper.count({ where: { createdAt: { gte: thisMonthStart } } }),
      prisma.user.count({ where: { createdAt: { gte: thisMonthStart } } }),
      prisma.subscription.groupBy({
        by: ['planId'],
        _count: true,
        where: { status: 'ACTIVE' },
      }),
      prisma.payment.aggregate({
        _sum: { amount: true },
        where: {
          status: 'success',
          createdAt: { gte: thisMonthStart },
        },
      }),
    ]);

    // Get plan names
    const plans = await prisma.plan.findMany({ select: { id: true, name: true, type: true } });
    const planMap = Object.fromEntries(plans.map((p) => [p.id, p]));

    const planStats = usersByPlan.map((s) => ({
      plan: planMap[s.planId]?.type || 'UNKNOWN',
      count: s._count,
    }));

    res.json({
      success: true,
      data: {
        totalUsers,
        activeUsers,
        totalPapers,
        totalExports,
        totalOcrJobs,
        papersLastMonth: papersThisMonth,
        signupsLastMonth: signupsThisMonth,
        mrr: (revenueResult._sum.amount || 0) / 100, // paise to rupees
        usersByPlan: planStats,
      },
    });
  })
);

// ─────────────────────────────────────────
// USER MANAGEMENT
// GET /api/admin/users
// ─────────────────────────────────────────

router.get(
  '/users',
  asyncHandler(async (req: Request, res: Response) => {
    const page = parseInt(req.query.page as string) || 1;
    const limit = Math.min(parseInt(req.query.limit as string) || 20, 100);
    const search = req.query.search as string;

    const where = search
      ? {
          OR: [
            { email: { contains: search, mode: 'insensitive' as const } },
            { name: { contains: search, mode: 'insensitive' as const } },
          ],
        }
      : {};

    const [users, total] = await Promise.all([
      prisma.user.findMany({
        where,
        skip: (page - 1) * limit,
        take: limit,
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          email: true,
          name: true,
          role: true,
          isActive: true,
          emailVerified: true,
          createdAt: true,
          lastLoginAt: true,
          subscription: { include: { plan: { select: { name: true, type: true } } } },
          _count: { select: { papers: true, exports: true } },
        },
      }),
      prisma.user.count({ where }),
    ]);

    res.json({
      success: true,
      data: users,
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    });
  })
);

// ─────────────────────────────────────────
// TOGGLE USER ACTIVE
// PATCH /api/admin/users/:id/toggle-active
// ─────────────────────────────────────────

router.patch(
  '/users/:id/toggle-active',
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = req.params;

    const user = await prisma.user.findUnique({ where: { id } });
    if (!user) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }

    const updated = await prisma.user.update({
      where: { id },
      data: { isActive: !user.isActive },
      select: { id: true, email: true, isActive: true },
    });

    res.json({ success: true, data: updated });
  })
);

// ─────────────────────────────────────────
// RECENT ACTIVITY
// GET /api/admin/activity
// ─────────────────────────────────────────

router.get(
  '/activity',
  asyncHandler(async (_req: Request, res: Response) => {
    const logs = await prisma.usageLog.findMany({
      orderBy: { createdAt: 'desc' },
      take: 50,
      include: {
        user: { select: { email: true, name: true } },
      },
    });

    res.json({ success: true, data: logs });
  })
);

// ─────────────────────────────────────────
// OCR MONITORING
// GET /api/admin/ocr-stats
// ─────────────────────────────────────────

router.get(
  '/ocr-stats',
  asyncHandler(async (_req: Request, res: Response) => {
    const [total, completed, failed, avgConfidence] = await Promise.all([
      prisma.ocrJob.count(),
      prisma.ocrJob.count({ where: { status: 'COMPLETED' } }),
      prisma.ocrJob.count({ where: { status: 'FAILED' } }),
      prisma.ocrJob.aggregate({
        _avg: { confidence: true, processingMs: true },
        where: { status: 'COMPLETED' },
      }),
    ]);

    res.json({
      success: true,
      data: {
        total,
        completed,
        failed,
        successRate: total > 0 ? Math.round((completed / total) * 100) : 0,
        avgConfidence: Math.round((avgConfidence._avg.confidence || 0) * 100),
        avgProcessingMs: Math.round(avgConfidence._avg.processingMs || 0),
      },
    });
  })
);

// ─────────────────────────────────────────
// GET /api/admin/users/:id/referrals
// ─────────────────────────────────────────

router.get(
  '/users/:id/referrals',
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = req.params;

    const [user, referrals] = await Promise.all([
      prisma.user.findUnique({
        where: { id },
        select: { id: true, name: true, email: true },
      }),
      prisma.referral.findMany({
        where: { referrerId: id },
        orderBy: { createdAt: 'desc' },
        include: {
          referred: {
            select: { id: true, name: true, email: true, createdAt: true },
          },
        },
      }),
    ]);

    if (!user) {
      res.status(404).json({ success: false, error: 'User not found' });
      return;
    }

    res.json({
      success: true,
      data: {
        user,
        referrals: referrals.map(r => ({
          id: r.id,
          referredName: r.referred?.name || '—',
          referredEmail: r.referred?.email || r.referredEmail,
          referredAt: r.createdAt,
          joinedAt: r.referred?.createdAt || r.createdAt,
          status: r.status,
          planPurchased: r.planPurchased || null,
          paidAt: r.paidAt || null,
        })),
        totalCount: referrals.length,
        paidCount: referrals.filter(r => r.status === 'PAID').length,
        pendingCount: referrals.filter(r => r.status === 'PENDING').length,
        expiredCount: referrals.filter(r => r.status === 'EXPIRED').length,
      },
    });
  })
);

export default router;