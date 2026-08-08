import { Router, Request, Response } from 'express';
import { body, query, param, validationResult } from 'express-validator';
import { rateLimit } from 'express-rate-limit';
import { prisma } from '../utils/prisma';
import { authenticate } from '../middleware/authenticate';
import { checkPaperLimit } from '../middleware/checkLimits';
import { asyncHandler } from '../middleware/asyncHandler';
import { generateDocx } from '../services/docxService';
import { logger } from '../utils/logger';
import type { PaperData } from '../types';

const router = Router();
router.use(authenticate);

// Strict rate limit for paper creation
const createLimiter = rateLimit({ windowMs: 60000, max: 10 });

// ─────────────────────────────────────────
// LIST PAPERS
// GET /api/papers?page=1&limit=10&status=READY&subject=Math
// ─────────────────────────────────────────

router.get(
  '/',
  asyncHandler(async (req: Request, res: Response) => {
    const userId = (req as any).user.userId;
    const page = parseInt(req.query.page as string) || 1;
    const limit = Math.min(parseInt(req.query.limit as string) || 10, 50);
    const status = req.query.status as string;
    const search = req.query.search as string;

    const where: Record<string, unknown> = { userId };
    if (status) where.status = status;
    if (search) {
      where.OR = [
        { title: { contains: search, mode: 'insensitive' } },
        { tags: { hasSome: [search] } },
      ];
    }

    const [papers, total] = await Promise.all([
      prisma.paper.findMany({
        where,
        orderBy: { updatedAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
        select: {
          id: true,
          title: true,
          status: true,
          totalMarks: true,
          questionCount: true,
          tags: true,
          thumbnail: true,
          createdAt: true,
          updatedAt: true,
          examDetails: true,
          template: { select: { name: true, category: true } },
          _count: { select: { exports: true } },
        },
      }),
      prisma.paper.count({ where }),
    ]);

    res.json({
      success: true,
      data: papers,
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

// ─────────────────────────────────────────
// GET SINGLE PAPER
// GET /api/papers/:id
// ─────────────────────────────────────────

router.get(
  '/:id',
  param('id').isString(),
  asyncHandler(async (req: Request, res: Response) => {
    const userId = (req as any).user.userId;
    const { id } = req.params;

    const paper = await prisma.paper.findFirst({
      where: { id, userId },
      include: {
        template: true,
        exports: {
          orderBy: { createdAt: 'desc' },
          take: 5,
        },
        versions: {
          orderBy: { version: 'desc' },
          take: 10,
          select: { id: true, version: true, createdAt: true },
        },
      },
    });

    if (!paper) {
      return res.status(404).json({ success: false, error: 'Paper not found' });
    }

    res.json({ success: true, data: paper });
  })
);

// ─────────────────────────────────────────
// CREATE PAPER
// POST /api/papers
// ─────────────────────────────────────────

router.post(
  '/',
  createLimiter,
  checkPaperLimit,
  [
    body('title').trim().isLength({ min: 2, max: 200 }).withMessage('Title required (2-200 chars)'),
    body('examDetails').isObject().withMessage('Exam details required'),
    body('sections').isArray().withMessage('Sections must be an array'),
  ],
  asyncHandler(async (req: Request, res: Response) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    const userId = (req as any).user.userId;
    const { title, examDetails, sections, templateId, tags } = req.body;

    // Calculate totals
    const totalMarks = sections.reduce((sum: number, s: { totalMarks?: number; questions?: Array<{ marks?: number }> }) => {
      return sum + (s.totalMarks || s.questions?.reduce((qs: number, q: { marks?: number }) => qs + (q.marks || 0), 0) || 0);
    }, 0);

    const questionCount = sections.reduce(
      (sum: number, s: { questions?: unknown[] }) => sum + (s.questions?.length || 0),
      0
    );

    // Store templateId inside examDetails (not as FK) to avoid constraint errors
    const examDetailsWithTemplate = {
      ...(examDetails as object),
      ...(templateId !== undefined ? { _templateId: templateId } : {}),
    };

    const paper = await prisma.paper.create({
      data: {
        userId,
        title,
        examDetails: examDetailsWithTemplate,
        sections,
        tags: tags || [],
        totalMarks,
        questionCount,
        status: 'DRAFT',
      },
    });

    // Log usage
    await prisma.usageLog.create({
      data: { userId, action: 'paper_created', metadata: { paperId: paper.id } },
    });

    // Increment subscription usage
    await prisma.subscription.updateMany({
      where: { userId },
      data: { papersUsedThisMonth: { increment: 1 } },
    });

    logger.info(`Paper created: ${paper.id} by user ${userId}`);

    res.status(201).json({ success: true, data: paper });
  })
);

// ─────────────────────────────────────────
// UPDATE PAPER
// PUT /api/papers/:id
// ─────────────────────────────────────────

router.put(
  '/:id',
  [body('title').optional().trim().isLength({ min: 2, max: 200 })],
  asyncHandler(async (req: Request, res: Response) => {
    const userId = (req as any).user.userId;
    const { id } = req.params;

    const existing = await prisma.paper.findFirst({ where: { id, userId } });
    if (!existing) {
      return res.status(404).json({ success: false, error: 'Paper not found' });
    }

    const { title, examDetails, sections, templateId, tags, status } = req.body;

    // Save version snapshot — skip silently if this version already exists
    try {
      const versionExists = await prisma.paperVersion.findFirst({
        where: { paperId: id, version: existing.version },
      });
      if (!versionExists) {
        await prisma.paperVersion.create({
          data: {
            paperId: id,
            version: existing.version,
            sections: existing.sections as object,
            examDetails: existing.examDetails as object,
            createdBy: userId,
          },
        });
      }
    } catch {
      // Version snapshot is non-critical — never block the actual save
    }

    const totalMarks = sections
      ? sections.reduce((sum: number, s: { totalMarks?: number; questions?: Array<{ marks?: number }> }) => {
          return sum + (s.totalMarks || s.questions?.reduce((qs: number, q: { marks?: number }) => qs + (q.marks || 0), 0) || 0);
        }, 0)
      : existing.totalMarks;

    const questionCount = sections
      ? sections.reduce((sum: number, s: { questions?: unknown[] }) => sum + (s.questions?.length || 0), 0)
      : existing.questionCount;

    const updated = await prisma.paper.update({
      where: { id },
      data: {
        ...(title && { title }),
        ...(examDetails && { examDetails }),
        ...(sections && { sections }),
        ...(templateId !== undefined && { templateId }),
        ...(tags && { tags }),
        ...(status && { status }),
        totalMarks,
        questionCount,
        version: { increment: 1 },
      },
    });

    res.json({ success: true, data: updated });
  })
);

// ─────────────────────────────────────────
// DELETE PAPER
// DELETE /api/papers/:id
// ─────────────────────────────────────────

router.delete(
  '/:id',
  asyncHandler(async (req: Request, res: Response) => {
    const userId = (req as any).user.userId;
    const { id } = req.params;

    const paper = await prisma.paper.findFirst({ where: { id, userId } });
    if (!paper) {
      return res.status(404).json({ success: false, error: 'Paper not found' });
    }

    // Resolve templateKey: body > examDetails._templateId > 'school'
    const rawKey: string =
      req.body.templateKey ||
      ((paper.examDetails as Record<string, unknown>)?._templateId as string) ||
      'school';
    const templateKey = rawKey; // keep tpl_ prefix - docxService uses tpl_ keys

    await prisma.paper.update({ where: { id }, data: { status: 'ARCHIVED' } });

    res.json({ success: true, message: 'Paper archived successfully' });
  })
);

// ─────────────────────────────────────────
// DUPLICATE PAPER
// POST /api/papers/:id/duplicate
// ─────────────────────────────────────────

router.post(
  '/:id/duplicate',
  asyncHandler(async (req: Request, res: Response) => {
    const userId = (req as any).user.userId;
    const { id } = req.params;

    const original = await prisma.paper.findFirst({ where: { id, userId } });
    if (!original) {
      return res.status(404).json({ success: false, error: 'Paper not found' });
    }

    const copy = await prisma.paper.create({
      data: {
        userId,
        title: `${original.title} (Copy)`,
        examDetails: original.examDetails as object,
        sections: original.sections as object,
        templateId: original.templateId,
        tags: original.tags,
        totalMarks: original.totalMarks,
        questionCount: original.questionCount,
        status: 'DRAFT',
      },
    });

    res.status(201).json({ success: true, data: copy });
  })
);

// ─────────────────────────────────────────
// EXPORT PAPER (DOCX)
// POST /api/papers/:id/export/docx
// ─────────────────────────────────────────
router.post(
  '/:id/export/docx',
  asyncHandler(async (req: Request, res: Response) => {
    const userId = (req as any).user.userId;
    const { id } = req.params;
    const paper = await prisma.paper.findFirst({ where: { id, userId } });
    if (!paper) {
      return res.status(404).json({ success: false, error: 'Paper not found' });
    }

    // Resolve templateKey: body > examDetails._templateId > 'school'
    const rawKey: string =
      req.body.templateKey ||
      ((paper.examDetails as Record<string, unknown>)?._templateId as string) ||
      'school';
    const templateKey = rawKey; // keep tpl_ prefix - docxService uses tpl_ keys
const paperData: PaperData = {
  id: paper.id,
  title: paper.title,
  examDetails:
    paper.examDetails as unknown as PaperData['examDetails'],
  sections:
    paper.sections as unknown as PaperData['sections'],
  totalMarks: paper.totalMarks,
  questionCount: paper.questionCount,
  status: paper.status as PaperData['status'],
};

    const buffer = await generateDocx(paperData, templateKey);

    const safeTitle = paper.title.replace(/[^a-z0-9]/gi, '_').toLowerCase();
    const fileName = `${safeTitle}_${paper.id}_v${paper.version}.docx`;

    await prisma.export.create({
      data: {
        userId,
        paperId: id,
        format: 'DOCX',
        fileSize: buffer.length,
        fileName,
        status: 'ready',
      },
    });

    await prisma.usageLog.create({
      data: { userId, action: 'paper_exported', metadata: { paperId: id, format: 'DOCX' } },
    });

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');

    res.send(buffer);
  })
);

// ─────────────────────────────────────────
// GET VERSION HISTORY
// GET /api/papers/:id/versions
// ─────────────────────────────────────────

router.get(
  '/:id/versions',
  asyncHandler(async (req: Request, res: Response) => {
    const userId = (req as any).user.userId;
    const { id } = req.params;

    const paper = await prisma.paper.findFirst({ where: { id, userId } });
    if (!paper) {
      return res.status(404).json({ success: false, error: 'Paper not found' });
    }

    // Resolve templateKey: body > examDetails._templateId > 'school'
    const rawKey: string =
      req.body.templateKey ||
      ((paper.examDetails as Record<string, unknown>)?._templateId as string) ||
      'school';
    const templateKey = rawKey; // keep tpl_ prefix - docxService uses tpl_ keys

    const versions = await prisma.paperVersion.findMany({
      where: { paperId: id },
      orderBy: { version: 'desc' },
    });

    res.json({ success: true, data: versions });
  })
);

export default router;