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
          status: 'captured', // matches the status written in payments.ts /verify
          createdAt: { gte: thisMonthStart },
        },
      }),
    ]);

    // Get plan names
    const plans = await prisma.plan.findMany({ select: { id: true, name: true, type: true } });
    const planMap = Object.fromEntries(plans.map((p) => [p.id, p]));

    // Multiple Plan rows can share the same `type` (e.g. two INSTITUTION plan
    // records), so aggregate counts by type here — otherwise the same plan
    // type shows up as separate rows/bars in the dashboard.
    const planCountsByType: Record<string, number> = {};
    // Seed every known plan type with 0 first, so a plan with zero *active*
    // subscribers right now (e.g. Pro) still shows up instead of being
    // silently omitted from the list.
    for (const p of plans) {
      if (!(p.type in planCountsByType)) planCountsByType[p.type] = 0;
    }
    for (const s of usersByPlan) {
      const type = planMap[s.planId]?.type || 'UNKNOWN';
      planCountsByType[type] = (planCountsByType[type] || 0) + s._count;
    }
    const planStats = Object.entries(planCountsByType).map(([plan, count]) => ({ plan, count }));

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

// ─────────────────────────────────────────
// ENGAGEMENT & FUNNEL (read-only)
// GET /api/admin/engagement
// Customers = users whose role is USER. ADMIN / SUPER_ADMIN accounts
// (internal testing) are excluded from every customer number and
// reported separately under `internal`.
// Note: only DOCX exports are recorded server-side today; PDF export is
// generated in the browser and is not tracked.
// ─────────────────────────────────────────

const DAY_MS = 24 * 60 * 60 * 1000;
const SEGMENT_LIMIT = 150;

function dayKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function median(nums: number[]): number | null {
  if (!nums.length) return null;
  const a = [...nums].sort((x, y) => x - y);
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

router.get(
  '/engagement',
  asyncHandler(async (_req: Request, res: Response) => {
    const now = new Date();
    const d30 = new Date(now.getTime() - 30 * DAY_MS);
    const d7 = new Date(now.getTime() - 7 * DAY_MS);
    const customerWhere = { role: 'USER' as const };
    const internalWhere = { role: { in: ['ADMIN' as const, 'SUPER_ADMIN' as const] } };

    const [
      customers,
      paperAgg,
      exportRows,
      ocrAgg,
      paidAgg,
      recentUsage,
      internalUsers,
      internalPapers,
      internalExports,
    ] = await Promise.all([
      prisma.user.findMany({
        where: customerWhere,
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          email: true,
          name: true,
          createdAt: true,
          lastLoginAt: true,
          emailVerified: true,
          isActive: true,
          subscription: { select: { status: true, plan: { select: { type: true } } } },
        },
      }),
      prisma.paper.groupBy({
        by: ['userId'],
        where: { user: customerWhere },
        _count: { _all: true },
        _min: { createdAt: true },
        _max: { createdAt: true },
      }),
      prisma.export.findMany({
        where: { user: customerWhere },
        select: { userId: true, createdAt: true },
      }),
      prisma.ocrJob.groupBy({
        by: ['userId'],
        where: { user: customerWhere },
        _count: { _all: true },
      }),
      prisma.payment.groupBy({
        by: ['userId'],
        where: { status: 'success', user: customerWhere },
        _sum: { amount: true },
        _count: { _all: true },
      }),
      prisma.usageLog.findMany({
        where: { createdAt: { gte: d30 }, user: customerWhere },
        select: { userId: true, createdAt: true },
      }),
      prisma.user.count({ where: internalWhere }),
      prisma.paper.count({ where: { user: internalWhere } }),
      prisma.export.count({ where: { user: internalWhere } }),
    ]);

    // ── per-user facts ──
    const papers = new Map(paperAgg.map(p => [p.userId, p]));
    const ocr = new Map(ocrAgg.map(o => [o.userId, o._count._all]));
    const paid = new Map(paidAgg.map(p => [p.userId, p]));
    const exportsBy = new Map<string, Date[]>();
    for (const e of exportRows) {
      const list = exportsBy.get(e.userId) || [];
      list.push(e.createdAt);
      exportsBy.set(e.userId, list);
    }
    const activeIds30 = new Set<string>(recentUsage.map(u => u.userId));
    const activeIds7 = new Set<string>(recentUsage.filter(u => u.createdAt >= d7).map(u => u.userId));
    // Also count paper creation / export rows in the window (older rows may lack a usage log)
    for (const p of paperAgg) if (p._max.createdAt && p._max.createdAt >= d30) activeIds30.add(p.userId);
    for (const p of paperAgg) if (p._max.createdAt && p._max.createdAt >= d7) activeIds7.add(p.userId);
    for (const [uid, list] of exportsBy) {
      if (list.some(d => d >= d30)) activeIds30.add(uid);
      if (list.some(d => d >= d7)) activeIds7.add(uid);
    }

    type Row = {
      id: string;
      email: string;
      name: string | null;
      signedUpAt: Date;
      daysSinceSignup: number;
      lastLoginAt: Date | null;
      emailVerified: boolean;
      papers: number;
      exports: number;
      exportDays: number;
      ocrJobs: number;
      lastActionAt: Date | null;
      plan: string;
      paidInr: number;
    };

    const rows: Row[] = customers.map(u => {
      const p = papers.get(u.id);
      const ex = exportsBy.get(u.id) || [];
      const exportDays = new Set(ex.map(dayKey)).size;
      const lastExport = ex.length ? new Date(Math.max(...ex.map(d => d.getTime()))) : null;
      const lastPaper = p?._max.createdAt || null;
      const lastActionAt =
        lastExport && lastPaper ? (lastExport > lastPaper ? lastExport : lastPaper) : lastExport || lastPaper;
      const pay = paid.get(u.id);
      return {
        id: u.id,
        email: u.email,
        name: u.name,
        signedUpAt: u.createdAt,
        daysSinceSignup: Math.floor((now.getTime() - u.createdAt.getTime()) / DAY_MS),
        lastLoginAt: u.lastLoginAt,
        emailVerified: u.emailVerified,
        papers: p?._count._all || 0,
        exports: ex.length,
        exportDays,
        ocrJobs: ocr.get(u.id) || 0,
        lastActionAt,
        plan: u.subscription?.plan.type || 'FREE',
        paidInr: Math.round((pay?._sum.amount || 0) / 100),
      };
    });

    const paidIds = new Set(paidAgg.map(p => p.userId));
    const registered = rows.length;
    const createdPaper = rows.filter(r => r.papers > 0);
    const exported = rows.filter(r => r.exports > 0);
    const repeat = rows.filter(r => r.exportDays >= 2);
    const paidRows = rows.filter(r => paidIds.has(r.id));

    const stage = (key: string, label: string, count: number, prev: number) => ({
      key,
      label,
      count,
      pctOfRegistered: registered ? Math.round((count / registered) * 1000) / 10 : 0,
      pctOfPrevious: prev ? Math.round((count / prev) * 1000) / 10 : 0,
      lost: Math.max(prev - count, 0),
    });
    const funnel = [
      stage('registered', 'Registered', registered, registered),
      stage('created', 'Created a paper', createdPaper.length, registered),
      stage('exported', 'Exported a paper', exported.length, createdPaper.length),
      stage('repeat', 'Came back and exported again', repeat.length, exported.length),
      stage('paid', 'Paid', paidRows.length, repeat.length || exported.length),
    ];

    const seg = (list: Row[]) => ({ count: list.length, users: list.slice(0, SEGMENT_LIMIT) });
    const segments = {
      neverCreated: seg(rows.filter(r => r.papers === 0)),
      createdNotExported: seg(rows.filter(r => r.papers > 0 && r.exports === 0)),
      exportedOnce: seg(rows.filter(r => r.exportDays === 1)),
      repeatNotPaid: seg(rows.filter(r => r.exportDays >= 2 && !paidIds.has(r.id))),
    };

    // ── genuine active users ──
    const activeRows = rows.filter(r => activeIds30.has(r.id));
    const active = {
      last7Days: rows.filter(r => activeIds7.has(r.id)).length,
      last30Days: activeRows.length,
      loggedInLast30Days: rows.filter(r => r.lastLoginAt && r.lastLoginAt >= d30).length,
      users: activeRows
        .sort((a, b) => (b.lastActionAt?.getTime() || 0) - (a.lastActionAt?.getTime() || 0))
        .slice(0, SEGMENT_LIMIT),
    };

    // ── weekly signup cohorts (last 8 weeks) ──
    const weeks: { weekStart: string; signups: number; createdPaper: number; exported: number }[] = [];
    const startOfWeek = (d: Date) => {
      const x = new Date(d);
      x.setUTCHours(0, 0, 0, 0);
      x.setUTCDate(x.getUTCDate() - ((x.getUTCDay() + 6) % 7));
      return x;
    };
    const thisWeek = startOfWeek(now);
    for (let i = 7; i >= 0; i--) {
      const from = new Date(thisWeek.getTime() - i * 7 * DAY_MS);
      const to = new Date(from.getTime() + 7 * DAY_MS);
      const cohort = rows.filter(r => r.signedUpAt >= from && r.signedUpAt < to);
      weeks.push({
        weekStart: dayKey(from),
        signups: cohort.length,
        createdPaper: cohort.filter(r => r.papers > 0).length,
        exported: cohort.filter(r => r.exports > 0).length,
      });
    }

    // ── signals that explain drop-off ──
    const hoursToFirstPaper = createdPaper
      .map(r => {
        const first = papers.get(r.id)?._min.createdAt;
        return first ? (first.getTime() - r.signedUpAt.getTime()) / 3600000 : null;
      })
      .filter((h): h is number => h !== null && h >= 0);
    const neverCreated = segments.neverCreated;
    const neverCreatedAll = rows.filter(r => r.papers === 0);

    const signals = {
      medianHoursToFirstPaper: median(hoursToFirstPaper),
      neverCreatedUnverified: neverCreatedAll.filter(r => !r.emailVerified).length,
      neverCreatedNeverLoggedBack: neverCreatedAll.filter(
        r => !r.lastLoginAt || r.lastLoginAt.getTime() - r.signedUpAt.getTime() < 60 * 60 * 1000
      ).length,
      neverCreatedTriedUpload: neverCreatedAll.filter(r => r.ocrJobs > 0).length,
      createdNotExportedAfter7Days: rows.filter(r => r.papers > 0 && r.exports === 0 && r.daysSinceSignup >= 7)
        .length,
      exportedOnceInactive14Days: rows.filter(
        r => r.exportDays === 1 && r.lastActionAt && now.getTime() - r.lastActionAt.getTime() > 14 * DAY_MS
      ).length,
    };

    const customerPapers = createdPaper.reduce((n, r) => n + r.papers, 0);
    const customerExports = exported.reduce((n, r) => n + r.exports, 0);

    res.json({
      success: true,
      data: {
        generatedAt: now,
        exportTrackingNote:
          'Only DOCX exports are recorded on the server. PDF exports happen in the browser and are not counted.',
        customers: {
          registered,
          papers: customerPapers,
          exports: customerExports,
          revenueInr: paidRows.reduce((n, r) => n + r.paidInr, 0),
          paidPlanSubscribers: rows.filter(r => r.plan !== 'FREE').length,
        },
        internal: { users: internalUsers, papers: internalPapers, exports: internalExports },
        funnel,
        segments,
        active,
        weeklyCohorts: weeks,
        signals,
        neverCreatedTotal: neverCreated.count,
      },
    });
  })
);

export default router;