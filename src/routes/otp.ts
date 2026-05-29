import { Router, Request, Response } from 'express';
import { prisma } from '../utils/prisma';
import { asyncHandler } from '../middleware/asyncHandler';
import { logger } from '../utils/logger';
import nodemailer from 'nodemailer';

const router = Router();

function getTransporter() {
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'smtp.gmail.com',
    port: parseInt(process.env.SMTP_PORT || '587'),
    secure: false,
    pool: true,
connectionTimeout: 10000,
socketTimeout: 10000,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });
}

function generateOtp(): string {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

// SEND OTP
router.post('/send', asyncHandler(async (req: Request, res: Response) => {
  const { email } = req.body;

  if (!email || !email.includes('@')) {
    return res.status(400).json({
      success: false,
      error: 'Valid email is required',
    });
  }

  await (prisma as any).emailOtp.deleteMany({
    where: { email },
  });

  const otp = generateOtp();
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

  await (prisma as any).emailOtp.create({
    data: {
      email,
      otp,
      expiresAt,
      verified: false,
    },
  });

  try {
    const transporter = getTransporter();

    await transporter.sendMail({
      from: `"PaperCraft AI" <${process.env.SMTP_USER}>`,
      to: email,
      subject: 'Your PaperCraft AI Verification Code',
      html: `
        <div>
          <h2>PaperCraft AI Verification</h2>
          <p>Your OTP is:</p>
          <h1>${otp}</h1>
          <p>This OTP expires in 10 minutes.</p>
        </div>
      `,
    });

    logger.info(`OTP sent to ${email}`);

    return res.json({
      success: true,
      data: {
        message: 'OTP sent successfully',
        expiresIn: 600,
      },
    });
  } catch (emailErr) {
    logger.error('Failed to send OTP email:', emailErr);

    await (prisma as any).emailOtp.deleteMany({
      where: { email },
    });

    return res.status(500).json({
      success: false,
      error: 'Failed to send OTP. Check email configuration.',
    });
  }
}));

// VERIFY OTP
router.post('/verify', asyncHandler(async (req: Request, res: Response) => {
  const { email, otp } = req.body;

  if (!email || !otp) {
    return res.status(400).json({
      success: false,
      error: 'Email and OTP are required',
    });
  }

  const record = await (prisma as any).emailOtp.findFirst({
    where: {
      email,
      otp,
      verified: false,
    },
    orderBy: {
      createdAt: 'desc',
    },
  });

  if (!record) {
    return res.status(400).json({
      success: false,
      error: 'Invalid OTP. Please check and try again.',
    });
  }

  if (new Date() > record.expiresAt) {
    await (prisma as any).emailOtp.delete({
      where: { id: record.id },
    });

    return res.status(400).json({
      success: false,
      error: 'OTP has expired. Please request a new one.',
    });
  }

  await (prisma as any).emailOtp.update({
    where: { id: record.id },
    data: { verified: true },
  });

  await prisma.user.updateMany({
    where: { email },
    data: {
      emailVerified: true,
    },
  });

  logger.info(`OTP verified for ${email}`);

  return res.json({
    success: true,
    data: {
      message: 'Email verified successfully',
    },
  });
}));

// RESEND OTP
router.post('/resend', asyncHandler(async (req: Request, res: Response) => {
  const { email } = req.body;

  if (!email) {
    return res.status(400).json({
      success: false,
      error: 'Email is required',
    });
  }

  const user = await prisma.user.findUnique({
    where: { email },
  });

  if (!user) {
    return res.status(404).json({
      success: false,
      error: 'No account found with this email',
    });
  }

  await (prisma as any).emailOtp.deleteMany({
    where: { email },
  });

  const otp = generateOtp();
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

  await (prisma as any).emailOtp.create({
    data: {
      email,
      otp,
      expiresAt,
      verified: false,
    },
  });

  try {
    const transporter = getTransporter();

    await transporter.sendMail({
      from: `"PaperCraft AI" <${process.env.SMTP_USER}>`,
      to: email,
      subject: 'Your New PaperCraft AI Verification Code',
      html: `
        <div>
          <h2>PaperCraft AI Verification</h2>
          <p>Your new OTP is:</p>
          <h1>${otp}</h1>
          <p>This OTP expires in 10 minutes.</p>
        </div>
      `,
    });

    return res.json({
      success: true,
      data: {
        message: 'New OTP sent',
        expiresIn: 600,
      },
    });
  } catch (emailErr) {
    logger.error('Failed to resend OTP email:', emailErr);

    await (prisma as any).emailOtp.deleteMany({
      where: { email },
    });

    return res.status(500).json({
      success: false,
      error: 'Failed to send OTP email.',
    });
  }
}));

export default router;