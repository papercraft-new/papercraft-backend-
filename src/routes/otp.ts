import { Router, Request, Response } from 'express';
import { prisma } from '../utils/prisma';
import { asyncHandler } from '../middleware/asyncHandler';
import { logger } from '../utils/logger';
// Use the shared singleton transporter — same config used everywhere in the app
import { getTransporter } from '../utils/email';

const router = Router();

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

  await (prisma as any).emailOtp.deleteMany({ where: { email } });

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
    await getTransporter().sendMail({
      from: `"Paptrix" <${process.env.SMTP_USER}>`,
      to: email,
      subject: 'Your Paptrix Verification Code',
      html: `
        <div style="font-family:Arial,sans-serif;max-width:500px;margin:0 auto;padding:20px">
          <h1 style="color:#2563eb;text-align:center">📋 Paptrix</h1>
          <div style="background:#f8fafc;border-radius:12px;padding:24px;text-align:center">
            <h2>Verify your email</h2>
            <p style="color:#64748b">Your verification code:</p>
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
            ">${otp}</div>
            <p style="color:#64748b;font-size:14px">Expires in <strong>10 minutes</strong></p>
          </div>
        </div>
      `,
    });

    logger.info(`OTP sent to ${email}`);

    return res.json({
      success: true,
      data: { message: 'OTP sent successfully', expiresIn: 600 },
    });
  } catch (emailErr: any) {
    logger.error('Failed to send OTP email:', emailErr.message || emailErr);

    await (prisma as any).emailOtp.deleteMany({ where: { email } });

    return res.status(500).json({
      success: false,
      error: 'Failed to send OTP. Please check your email address or try again later.',
    });
  }
}));

// VERIFY OTP
router.post('/verify', asyncHandler(async (req: Request, res: Response) => {
  const { email, otp } = req.body;

  if (!email || !otp) {
    return res.status(400).json({ success: false, error: 'Email and OTP are required' });
  }

  const record = await (prisma as any).emailOtp.findFirst({
    where: { email, otp, verified: false },
    orderBy: { createdAt: 'desc' },
  });

  if (!record) {
    return res.status(400).json({ success: false, error: 'Invalid OTP. Please check and try again.' });
  }

  if (new Date() > record.expiresAt) {
    await (prisma as any).emailOtp.delete({ where: { id: record.id } });
    return res.status(400).json({ success: false, error: 'OTP has expired. Please request a new one.' });
  }

  await (prisma as any).emailOtp.update({
    where: { id: record.id },
    data: { verified: true },
  });

  await prisma.user.updateMany({
    where: { email },
    data: { emailVerified: true },
  });

  logger.info(`OTP verified for ${email}`);

  return res.json({ success: true, data: { message: 'Email verified successfully' } });
}));

// RESEND OTP
router.post('/resend', asyncHandler(async (req: Request, res: Response) => {
  const { email } = req.body;

  if (!email) {
    return res.status(400).json({ success: false, error: 'Email is required' });
  }

  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) {
    return res.status(404).json({ success: false, error: 'No account found with this email' });
  }

  await (prisma as any).emailOtp.deleteMany({ where: { email } });

  const otp = generateOtp();
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

  await (prisma as any).emailOtp.create({
    data: { email, otp, expiresAt, verified: false },
  });

  try {
    await getTransporter().sendMail({
      from: `"Paptrix" <${process.env.SMTP_USER}>`,
      to: email,
      subject: 'Your New P Verification Code',
      html: `
        <div style="font-family:Arial,sans-serif;max-width:500px;margin:0 auto;padding:20px">
          <h1 style="color:#2563eb;text-align:center">📋 paptrix</h1>
          <div style="background:#f8fafc;border-radius:12px;padding:24px;text-align:center">
            <h2>New Verification Code</h2>
            <p style="color:#64748b">Your new OTP is:</p>
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
            ">${otp}</div>
            <p style="color:#64748b;font-size:14px">Expires in <strong>10 minutes</strong></p>
          </div>
        </div>
      `,
    });

    return res.json({ success: true, data: { message: 'New OTP sent', expiresIn: 600 } });
  } catch (emailErr: any) {
    logger.error('Failed to resend OTP email:', emailErr.message || emailErr);

    await (prisma as any).emailOtp.deleteMany({ where: { email } });

    return res.status(500).json({ success: false, error: 'Failed to send OTP email.' });
  }
}));

export default router;
