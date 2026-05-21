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