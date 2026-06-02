import nodemailer from 'nodemailer';
import { logger } from './logger';

interface EmailOptions {
  to: string;
  subject: string;
  template: 'welcome' | 'password-reset' | 'export-ready' | 'subscription-upgrade';
  data: Record<string, string>;
}

let transporter: nodemailer.Transporter | null = null;

export function getTransporter(): nodemailer.Transporter {
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST || 'smtp-relay.brevo.com',
      port: parseInt(process.env.SMTP_PORT || '587'),
      secure: false,
      requireTLS: true,
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
      },
      tls: {
        rejectUnauthorized: false,
      },
      connectionTimeout: 15000,
      socketTimeout: 15000,
      pool: true,
      maxConnections: 3,
    });
  }
  return transporter;
}

export async function verifyEmailTransporter(): Promise<void> {
  try {
    await getTransporter().verify();
    logger.info('✅ SMTP transporter verified successfully');
  } catch (err: any) {
    logger.error('❌ SMTP transporter verification failed:');
    logger.error('Error message: ' + (err.message || 'unknown'));
    logger.error('Error code: ' + (err.code || 'none'));
    logger.error('SMTP_HOST: ' + (process.env.SMTP_HOST || 'not set'));
    logger.error('SMTP_PORT: ' + (process.env.SMTP_PORT || 'not set'));
    logger.error('SMTP_USER present: ' + !!process.env.SMTP_USER);
    logger.error('SMTP_PASS present: ' + !!process.env.SMTP_PASS);
  }
}

const templates: Record<string, (data: Record<string, string>) => string> = {
  welcome: (d) => `
    <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;background:#f9fafb;padding:2rem;border-radius:12px">
      <div style="background:linear-gradient(135deg,#2563eb,#0891b2);padding:2rem;border-radius:8px;text-align:center;margin-bottom:1.5rem">
        <h1 style="color:#fff;margin:0;font-size:1.5rem">Welcome to PaperCraft AI! 🎉</h1>
      </div>
      <p style="color:#374151">Hi <strong>${d.name}</strong>,</p>
      <p style="color:#374151">You're all set to create professional question papers in seconds.</p>
      <div style="text-align:center;margin:2rem 0">
        <a href="${process.env.FRONTEND_URL}/dashboard" style="background:#2563eb;color:#fff;padding:12px 28px;border-radius:8px;text-decoration:none;font-weight:600">Open Dashboard →</a>
      </div>
    </div>`,

  'password-reset': (d) => `
    <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;background:#f9fafb;padding:2rem;border-radius:12px">
      <h2 style="color:#1f2937">Reset Your Password</h2>
      <p style="color:#374151">Hi <strong>${d.name}</strong>, you requested a password reset.</p>
      <p style="color:#374151">Click the button below. This link expires in 1 hour.</p>
      <div style="text-align:center;margin:2rem 0">
        <a href="${d.resetUrl}" style="background:#2563eb;color:#fff;padding:12px 28px;border-radius:8px;text-decoration:none;font-weight:600">Reset Password</a>
      </div>
      <p style="color:#9ca3af;font-size:12px">If you didn't request this, ignore this email.</p>
    </div>`,

  'export-ready': (d) => `
    <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;background:#f9fafb;padding:2rem;border-radius:12px">
      <h2 style="color:#1f2937">Your Paper is Ready! 📄</h2>
      <p style="color:#374151">Your paper "<strong>${d.paperTitle}</strong>" has been exported.</p>
      <div style="text-align:center;margin:2rem 0">
        <a href="${d.downloadUrl}" style="background:#10b981;color:#fff;padding:12px 28px;border-radius:8px;text-decoration:none;font-weight:600">Download Now</a>
      </div>
    </div>`,

  'subscription-upgrade': (d) => `
    <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;background:#f9fafb;padding:2rem;border-radius:12px">
      <h2 style="color:#1f2937">You're now on ${d.planName}! 🚀</h2>
      <p style="color:#374151">Hi <strong>${d.name}</strong>, your subscription is active.</p>
      <div style="text-align:center;margin:2rem 0">
        <a href="${process.env.FRONTEND_URL}/dashboard" style="background:#2563eb;color:#fff;padding:12px 28px;border-radius:8px;text-decoration:none;font-weight:600">Start Creating →</a>
      </div>
    </div>`,
};

export async function sendEmail({ to, subject, template, data }: EmailOptions): Promise<void> {
  const html = templates[template]?.(data);
  if (!html) throw new Error(`Unknown email template: ${template}`);

  await getTransporter().sendMail({
    from: `"PaperCraft AI" <${process.env.SMTP_USER}>`,
    to,
    subject,
    html,
  });

  logger.info(`Email sent: ${template} → ${to}`);
}