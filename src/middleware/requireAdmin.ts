import { Request, Response, NextFunction } from 'express';

const SUPER_ADMIN_EMAIL = 'admin@papercraft.ai';

export function requireAdmin(req: Request, res: Response, next: NextFunction) {
  const user = (req as any).user;

  if (!user) {
    return res.status(401).json({ success: false, error: 'Not authenticated' });
  }

  // Only admin@papercraft.ai can access admin routes
  if (user.email !== SUPER_ADMIN_EMAIL) {
    return res.status(403).json({
      success: false,
      error: 'Access denied. Admin only.',
    });
  }

  next();
}