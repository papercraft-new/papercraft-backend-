import { Router, Request, Response } from 'express';
import { prisma } from '../utils/prisma';
import { authenticate } from '../middleware/authenticate';
import { asyncHandler } from '../middleware/asyncHandler';
import { getReferralProgress } from '../services/referralService';
import { logger } from '../utils/logger';

const router = Router();
router.use(authenticate);

// ─────────────────────────────────────────
// GET MY REFERRAL LINK
// ─────────────────────────────────────────
router.get(
  '/my-link',
  asyncHandler(async (req: Request, res: Response) => {
    const userId = (req as any).user.userId;
    const frontendUrl = process.env.FRONTEND_URL || 'https://paptrix.com';

    res.json({
      success: true,
      data: {
        referralCode: userId,
        referralLink: `${frontendUrl}/auth/register?ref=${userId}`,
      },
    });
  })
);

// ─────────────────────────────────────────
// GET MY REFERRAL PROGRESS
// ─────────────────────────────────────────
router.get(
  '/my-progress',
  asyncHandler(async (req: Request, res: Response) => {
    const userId = (req as any).user.userId;

    try {
      const progress = await getReferralProgress(userId);
      res.json({ success: true, data: progress });
    } catch (err) {
      logger.error('Failed to fetch referral progress:', err);
      res.status(500).json({ success: false, error: 'Failed to load referral data' });
    }
  })
);

export default router;