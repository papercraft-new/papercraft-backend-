import { Request, Response, NextFunction } from 'express';
import { prisma } from '../utils/prisma';

export async function checkPaperLimit(req: Request, res: Response, next: NextFunction) {
  const userId = (req as any).user.userId;

  const subscription = await prisma.subscription.findUnique({
    where: { userId },
    include: { plan: true },
  });

  if (!subscription || !subscription.plan) {
    return next();
  }

  const { plan, papersUsedThisMonth } = subscription;

  if (plan.papersPerMonth !== -1 && papersUsedThisMonth >= plan.papersPerMonth) {
    return res.status(429).json({
      success: false,
      error: `Monthly paper limit (${plan.papersPerMonth}) reached. Upgrade your plan to create more papers.`,
      upgradeRequired: true,
    });
  }

  next();
}