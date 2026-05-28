import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { body, validationResult } from 'express-validator';
import { rateLimit } from 'express-rate-limit';
import { prisma } from '../utils/prisma';
import { sendEmail } from '../utils/email';
import { logger } from '../utils/logger';
import { asyncHandler } from '../middleware/asyncHandler';
import { authenticate } from '../middleware/authenticate';
import type { JwtPayload } from '../types';
import nodemailer from 'nodemailer';
import crypto from 'crypto';

const router = Router();

// Strict rate limit on auth routes
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10,
  message: { error: 'Too many authentication attempts. Please try again in 15 minutes.' },
});

// ─────────────────────────────────────────
// REGISTER
// ─────────────────────────────────────────
router.post(
  '/register',
  authLimiter,
  [
    body('email').isEmail().normalizeEmail().withMessage('Valid email required'),
    body('password').isLength({ min: 8 }).withMessage('Password must be at least 8 characters'),
    body('name').trim().isLength({ min: 2, max: 80 }).withMessage('Name must be 2-80 characters'),
  ],
  asyncHandler(async (req: Request, res: Response) => {
    const errors = validationResult(req);

    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        errors: errors.array(),
      });
    }

    const { email, password, name } = req.body;

    const existingUser = await prisma.user.findUnique({
      where: { email },
    });

    if (existingUser) {
      return res.status(409).json({
        success: false,
        error: 'Email already registered',
      });
    }

    const passwordHash = await bcrypt.hash(password, 12);

    // Create user
    const user = await prisma.user.create({
      data: {
        email,
        name,
        passwordHash,
        subscription: {
          create: {
            planId: await getFreePlanId(),
            status: 'ACTIVE',
            currentPeriodStart: new Date(),
            currentPeriodEnd: new Date(
              Date.now() + 30 * 24 * 60 * 60 * 1000
            ),
          },
        },
      },
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
        avatarUrl: true,
      },
    });

    // Generate token
    const token = signToken({
      userId: user.id,
      email: user.email,
      role: user.role,
    });

    // Generate OTP
    const otp = Math.floor(
      100000 + Math.random() * 900000
    ).toString();

    const expiresAt = new Date(
      Date.now() + 10 * 60 * 1000
    );

    // Delete old OTPs
    await (prisma as any).emailOtp.deleteMany({
      where: { email },
    });

    // Save OTP
    await (prisma as any).emailOtp.create({
      data: {
        id: crypto.randomUUID(),
        email,
        otp,
        expiresAt,
        verified: false,
      },
    });

    // Send OTP Email
    try {
      const transporter = nodemailer.createTransport({
        host: process.env.SMTP_HOST || 'smtp.gmail.com',
        port: parseInt(process.env.SMTP_PORT || '587'),
        secure: false,
        auth: {
          user: process.env.SMTP_USER,
          pass: process.env.SMTP_PASS,
        },
      });

      await transporter.sendMail({
        from: `"PaperCraft AI" <${process.env.SMTP_USER}>`,
        to: email,
        subject: 'Verify your PaperCraft AI account',
        html: `
          <div style="font-family:Arial,sans-serif;max-width:500px;margin:0 auto;padding:20px">
            <h1 style="color:#2563eb;text-align:center">
              📋 PaperCraft AI
            </h1>

            <div style="background:#f8fafc;border-radius:12px;padding:24px;text-align:center">
              <h2>Welcome ${name}! Verify your email</h2>

              <p style="color:#64748b">
                Your verification code:
              </p>

              <div style="
                background:#2563eb;
                color:white;
                font-size:36px;
                font-weight:bold;
                letter-spacing:8px;
                padding:16px 24px;
                border-radius:8px;
                margin:20px 0;
                display:inline-block;
              ">
                ${otp}
              </div>

              <p style="color:#64748b;font-size:14px">
                Expires in <strong>10 minutes</strong>
              </p>
            </div>
          </div>
        `,
      });
    } catch (emailErr) {
      logger.warn(
        'Failed to send verification email:',
        emailErr
      );
    }

    logger.info(`New user registered: ${email}`);

    // Return response
    return res.status(201).json({
      success: true,
      data: {
        user: {
          id: user.id,
          email: user.email,
          name: user.name,
          role: user.role,
          avatarUrl: user.avatarUrl,
          emailVerified: false,
        },
        token,
        requiresVerification: true,
        message:
          'Account created. Please verify your email.',
      },
    });
  })
);

// ─────────────────────────────────────────
// LOGIN
// ─────────────────────────────────────────

router.post(
  '/login',
  authLimiter,
  [
    body('email').isEmail().normalizeEmail(),
    body('password').notEmpty(),
  ],
  asyncHandler(async (req: Request, res: Response) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    const { email, password } = req.body;

    const user = await prisma.user.findUnique({
      where: { email },
      include: {
        subscription: { include: { plan: true } },
      },
    });

    if (!user || !user.passwordHash) {
      return res.status(401).json({ success: false, error: 'Invalid credentials' });
    }

    if (!user.isActive) {
      return res.status(403).json({ success: false, error: 'Account deactivated. Contact support.' });
    }

    const isPasswordValid = await bcrypt.compare(password, user.passwordHash);
    if (!isPasswordValid) {
      return res.status(401).json({ success: false, error: 'Invalid credentials' });
    }

    // Update last login
    await prisma.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date() },
    });

    const token = signToken({ userId: user.id, email: user.email, role: user.role });

    const { passwordHash: _, ...safeUser } = user;

    logger.info(`User logged in: ${email}`);

    res.json({
      success: true,
      data: {
        user: safeUser,
        token,
        plan: user.subscription?.plan?.type || 'FREE',
      },
    });
  })
);

// ─────────────────────────────────────────
// GOOGLE OAUTH CALLBACK
// ─────────────────────────────────────────

router.post(
  '/google',
  asyncHandler(async (req: Request, res: Response) => {
    const { googleToken } = req.body;

    if (!googleToken) {
      return res.status(400).json({ success: false, error: 'Google token required' });
    }

    // Verify Google token using Google's tokeninfo endpoint
    const googleRes = await fetch(
      `https://oauth2.googleapis.com/tokeninfo?id_token=${googleToken}`
    );

    if (!googleRes.ok) {
      return res.status(401).json({ success: false, error: 'Invalid Google token' });
    }

    const googleData = await googleRes.json() as {
      sub: string;
      email: string;
      name: string;
      picture: string;
    };

    const { sub: googleId, email, name, picture: avatarUrl } = googleData;

    // Upsert user
    let user = await prisma.user.findUnique({ where: { googleId } });

    if (!user) {
      user = await prisma.user.findUnique({ where: { email } });
      if (user) {
        // Link Google account to existing email account
        user = await prisma.user.update({
          where: { id: user.id },
          data: { googleId, avatarUrl: avatarUrl || user.avatarUrl },
        });
      } else {
        // New user via Google
        user = await prisma.user.create({
          data: {
            email,
            name,
            googleId,
            avatarUrl,
            emailVerified: true,
            subscription: {
              create: {
                planId: await getFreePlanId(),
                status: 'ACTIVE',
                currentPeriodStart: new Date(),
                currentPeriodEnd: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
              },
            },
          },
        });
      }
    }

    if (!user.isActive) {
      return res.status(403).json({ success: false, error: 'Account deactivated.' });
    }

    await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });

    const token = signToken({ userId: user.id, email: user.email, role: user.role });

    res.json({ success: true, data: { user, token } });
  })
);

// ─────────────────────────────────────────
// FORGOT PASSWORD
// ─────────────────────────────────────────

router.post(
  '/forgot-password',
  authLimiter,
  [body('email').isEmail().normalizeEmail()],
  asyncHandler(async (req: Request, res: Response) => {
    const { email } = req.body;

    const user = await prisma.user.findUnique({ where: { email } });

    // Always respond success to prevent email enumeration
    if (!user) {
      return res.json({ success: true, message: 'If that email exists, a reset link has been sent.' });
    }

    const token = generateSecureToken();
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

    await prisma.passwordReset.create({
      data: { userId: user.id, token, expiresAt },
    });

    const resetUrl = `${process.env.FRONTEND_URL}/auth/reset-password?token=${token}`;

    await sendEmail({
      to: email,
      subject: 'Reset your PaperCraft AI password',
      template: 'password-reset',
      data: { name: user.name || 'User', resetUrl },
    });

    res.json({ success: true, message: 'If that email exists, a reset link has been sent.' });
  })
);

// ─────────────────────────────────────────
// RESET PASSWORD
// ─────────────────────────────────────────

router.post(
  '/reset-password',
  authLimiter,
  [
    body('token').notEmpty(),
    body('password').isLength({ min: 8 }),
  ],
  asyncHandler(async (req: Request, res: Response) => {
    const { token, password } = req.body;

    const reset = await prisma.passwordReset.findUnique({ where: { token } });

    if (!reset || reset.usedAt || reset.expiresAt < new Date()) {
      return res.status(400).json({ success: false, error: 'Invalid or expired reset token' });
    }

    const passwordHash = await bcrypt.hash(password, 12);

    await prisma.$transaction([
      prisma.user.update({ where: { id: reset.userId }, data: { passwordHash } }),
      prisma.passwordReset.update({ where: { id: reset.id }, data: { usedAt: new Date() } }),
    ]);

    res.json({ success: true, message: 'Password reset successfully' });
  })
);

// ─────────────────────────────────────────
// GET CURRENT USER
// ─────────────────────────────────────────

router.get(
  '/me',
  authenticate,
  asyncHandler(async (req: Request, res: Response) => {
    const user = await prisma.user.findUnique({
      where: { id: (req as any).user.userId },
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
        avatarUrl: true,
        emailVerified: true,
        createdAt: true,
        subscription: {
          include: { plan: true },
        },
        institution: true,
        _count: {
          select: { papers: true, exports: true },
        },
      },
    });

    if (!user) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }

    res.json({ success: true, data: user });
  })
);


// ─────────────────────────────────────────
// LOGOUT
// ─────────────────────────────────────────

router.post(
  '/logout',
  authenticate,
  asyncHandler(async (_req: Request, res: Response) => {
    // In a stateless JWT system, logout is client-side token deletion.
    // For session-based, invalidate the session here.
    res.json({ success: true, message: 'Logged out successfully' });
  })
);

// ─────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────

function signToken(payload: JwtPayload): string {
  return jwt.sign(payload, process.env.JWT_SECRET as string, {
    expiresIn: process.env.JWT_EXPIRES_IN || '7d',
  } as jwt.SignOptions);
}

function generateSecureToken(): string {
  const { randomBytes } = require('crypto');
  return randomBytes(32).toString('hex');
}

async function getFreePlanId(): Promise<string> {
  const freePlan = await prisma.plan.findFirst({ where: { type: 'FREE' } });
  if (!freePlan) {
    // Auto-create free plan if it doesn't exist
    const created = await prisma.plan.create({
      data: {
        name: 'Free',
        type: 'FREE',
        priceMonthly: 0,
        priceYearly: 0,
        papersPerMonth: 5,
        exportsPerMonth: 10,
        templatesCount: 3,
        hasDocxExport: false,
        hasCustomBranding: false,
        features: ['5 papers/month', '3 templates', 'PDF export', 'Basic OCR'],
      },
    });
    return created.id;
  }
  return freePlan.id;
}

export default router;
