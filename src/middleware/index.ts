// middleware/errorHandler.ts
import { Request, Response, NextFunction } from 'express';
import { logger } from '../utils/logger';

export function errorHandler(
  err: Error & { status?: number; code?: string },
  _req: Request,
  res: Response,
  _next: NextFunction
) {
  logger.error(`Error: ${err.message}`, { stack: err.stack });

  // Multer file size error
  if (err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({
      success: false,
      error: `File too large. Maximum size is ${process.env.MAX_FILE_SIZE_MB || 50}MB.`,
    });
  }

  // Prisma known errors
  if (err.constructor.name === 'PrismaClientKnownRequestError') {
    const prismaErr = err as any;
    if (prismaErr.code === 'P2002') {
      return res.status(409).json({ success: false, error: 'A record with this value already exists.' });
    }
    if (prismaErr.code === 'P2025') {
      return res.status(404).json({ success: false, error: 'Record not found.' });
    }
  }

  const status = err.status || 500;
  const message =
    process.env.NODE_ENV === 'production' && status === 500
      ? 'Internal server error'
      : err.message;

  res.status(status).json({ success: false, error: message });
}

// middleware/asyncHandler.ts
import { Request, Response, NextFunction } from 'express';
type AsyncFn = (req: Request, res: Response, next: NextFunction) => Promise<unknown>;

export function asyncHandler(fn: AsyncFn) {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

// middleware/requireAdmin.ts
export function requireAdmin(req: Request, res: Response, next: NextFunction) {
  const user = (req as any).user;
  if (user.role !== 'ADMIN' && user.role !== 'SUPER_ADMIN') {
    return res.status(403).json({ success: false, error: 'Admin access required' });
  }
  next();
}

// middleware/checkLimits.ts
import { prisma } from '../utils/prisma';

export async function checkPaperLimit(req: Request, res: Response, next: NextFunction) {
  const userId = (req as any).user.userId;

  const subscription = await prisma.subscription.findUnique({
    where: { userId },
    include: { plan: true },
  });

  if (!subscription || !subscription.plan) {
    return next(); // No subscription = free plan, handled elsewhere
  }

  const { plan, papersUsedThisMonth } = subscription;

  // -1 means unlimited
  if (plan.papersPerMonth !== -1 && papersUsedThisMonth >= plan.papersPerMonth) {
    return res.status(429).json({
      success: false,
      error: `Monthly paper limit (${plan.papersPerMonth}) reached. Upgrade your plan to create more papers.`,
      upgradeRequired: true,
    });
  }

  next();
}
