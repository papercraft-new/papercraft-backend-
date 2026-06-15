import { Request, Response, NextFunction } from 'express';
import { prisma } from '../utils/prisma';
import { logger } from '../utils/logger';

// Simple in-memory cache: only check once per user per 5 minutes
const lastChecked = new Map<string, number>();
const CACHE_MS = 5 * 60 * 1000; // 5 minutes

// Runs on every authenticated request
// If subscription has expired → downgrade to FREE automatically
export async function checkSubscription(req: Request, res: Response, next: NextFunction) {
  try {
    const userId = (req as any).user?.userId;
    if (!userId) return next();

    // Skip if checked recently
    const last = lastChecked.get(userId) || 0;
    if (Date.now() - last < CACHE_MS) return next();
    lastChecked.set(userId, Date.now());

    const sub = await prisma.subscription.findUnique({
      where: { userId },
      include: { plan: true },
    });

    if (!sub || sub.plan.type === 'FREE') return next();

    const now = new Date();
    const expired = sub.currentPeriodEnd && new Date(sub.currentPeriodEnd) < now;

    if (expired) {
      // Find FREE plan
      const freePlan = await prisma.plan.findFirst({ where: { type: 'FREE' } });
      if (freePlan) {
        await prisma.subscription.update({
          where: { userId },
          data: {
            planId: freePlan.id,
            status: 'EXPIRED',
            papersUsedThisMonth: 0,
          },
        });
        logger.info(`Subscription expired for user ${userId} — downgraded to FREE`);
      }
    }
  } catch (err) {
    // Non-critical — never block the request
    logger.warn('checkSubscription error:', err);
  }

  next();
}