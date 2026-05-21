// routes/templates.ts
import { Router, Request, Response } from 'express';
import { body, validationResult } from 'express-validator';
import { prisma } from '../utils/prisma';
import { authenticate } from '../middleware/authenticate';
import { asyncHandler } from '../middleware/asyncHandler';

const router = Router();

// GET /api/templates — list all templates (system + user's own)
router.get(
  '/',
  asyncHandler(async (req: Request, res: Response) => {
    const userId = req.headers.authorization
      ? (() => {
          try {
            const jwt = require('jsonwebtoken');
            const token = req.headers.authorization!.split(' ')[1];
            const decoded = jwt.verify(token, process.env.JWT_SECRET!) as { userId: string };
            return decoded.userId;
          } catch { return null; }
        })()
      : null;

    const templates = await prisma.template.findMany({
      where: {
        OR: [
          { isSystem: true },
          { isPublic: true },
          ...(userId ? [{ userId }] : []),
        ],
      },
      orderBy: [{ isSystem: 'desc' }, { usageCount: 'desc' }],
      select: {
        id: true,
        name: true,
        description: true,
        category: true,
        config: true,
        previewUrl: true,
        isSystem: true,
        usageCount: true,
        createdAt: true,
      },
    });

    res.json({ success: true, data: templates });
  })
);

// GET /api/templates/:id
router.get(
  '/:id',
  asyncHandler(async (req: Request, res: Response) => {
    const template = await prisma.template.findUnique({
      where: { id: req.params.id },
    });
    if (!template) {
      return res.status(404).json({ success: false, error: 'Template not found' });
    }
    res.json({ success: true, data: template });
  })
);

// POST /api/templates — create custom template (auth required)
router.post(
  '/',
  authenticate,
  [
    body('name').trim().isLength({ min: 2, max: 100 }),
    body('config').isObject(),
    body('category').isIn(['school', 'college', 'coaching', 'competitive', 'minimal', 'luxury', 'custom']),
  ],
  asyncHandler(async (req: Request, res: Response) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    const userId = (req as any).user.userId;
    const { name, description, category, config, isPublic } = req.body;

    const template = await prisma.template.create({
      data: { name, description, category, config, userId, isPublic: isPublic || false },
    });

    res.status(201).json({ success: true, data: template });
  })
);

// PUT /api/templates/:id
router.put(
  '/:id',
  authenticate,
  asyncHandler(async (req: Request, res: Response) => {
    const userId = (req as any).user.userId;
    const { id } = req.params;

    const template = await prisma.template.findFirst({
      where: { id, userId, isSystem: false },
    });
    if (!template) {
      return res.status(404).json({ success: false, error: 'Template not found or not editable' });
    }

    const updated = await prisma.template.update({
      where: { id },
      data: req.body,
    });

    res.json({ success: true, data: updated });
  })
);

// DELETE /api/templates/:id
router.delete(
  '/:id',
  authenticate,
  asyncHandler(async (req: Request, res: Response) => {
    const userId = (req as any).user.userId;
    const { id } = req.params;

    const template = await prisma.template.findFirst({
      where: { id, userId, isSystem: false },
    });
    if (!template) {
      return res.status(404).json({ success: false, error: 'Template not found or protected' });
    }

    await prisma.template.delete({ where: { id } });
    res.json({ success: true, message: 'Template deleted' });
  })
);

export default router;
