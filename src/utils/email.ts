// utils/email.ts
import nodemailer from 'nodemailer';
import { logger } from './logger';

interface EmailOptions {
  to: string;
  subject: string;
  template: 'welcome' | 'password-reset' | 'export-ready' | 'subscription-upgrade';
  data: Record<string, string>;
}

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: parseInt(process.env.SMTP_PORT || '587'),
  secure: false,
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

const templates: Record<string, (data: Record<string, string>) => string> = {
  welcome: (d) => `
    <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;background:#f9fafb;padding:2rem;border-radius:12px">
      <div style="background:linear-gradient(135deg,#2563eb,#0891b2);padding:2rem;border-radius:8px;text-align:center;margin-bottom:1.5rem">
        <h1 style="color:#fff;margin:0;font-size:1.5rem">Welcome to PaperCraft AI! 🎉</h1>
      </div>
      <p style="color:#374151">Hi <strong>${d.name}</strong>,</p>
      <p style="color:#374151">You're all set to create professional question papers in seconds. Here's what you can do:</p>
      <ul style="color:#374151;line-height:2">
        <li>📸 Upload handwritten notes — AI extracts questions automatically</li>
        <li>✏️ Build & edit question papers with live preview</li>
        <li>📄 Export to DOCX and PDF with DTP-quality formatting</li>
        <li>🎨 Choose from 6 professional templates</li>
      </ul>
      <div style="text-align:center;margin:2rem 0">
        <a href="${process.env.FRONTEND_URL}/dashboard" style="background:#2563eb;color:#fff;padding:12px 28px;border-radius:8px;text-decoration:none;font-weight:600">Open Dashboard →</a>
      </div>
      <p style="color:#9ca3af;font-size:12px;text-align:center">PaperCraft AI — Smarter exam papers, faster.</p>
    </div>`,

  'password-reset': (d) => `
    <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;background:#f9fafb;padding:2rem;border-radius:12px">
      <h2 style="color:#1f2937">Reset Your Password</h2>
      <p style="color:#374151">Hi <strong>${d.name}</strong>, you requested a password reset.</p>
      <p style="color:#374151">Click the button below to set a new password. This link expires in 1 hour.</p>
      <div style="text-align:center;margin:2rem 0">
        <a href="${d.resetUrl}" style="background:#2563eb;color:#fff;padding:12px 28px;border-radius:8px;text-decoration:none;font-weight:600">Reset Password</a>
      </div>
      <p style="color:#9ca3af;font-size:12px">If you didn't request this, ignore this email. Your password won't change.</p>
    </div>`,

  'export-ready': (d) => `
    <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;background:#f9fafb;padding:2rem;border-radius:12px">
      <h2 style="color:#1f2937">Your Paper is Ready! 📄</h2>
      <p style="color:#374151">Your question paper "<strong>${d.paperTitle}</strong>" has been exported successfully.</p>
      <div style="text-align:center;margin:2rem 0">
        <a href="${d.downloadUrl}" style="background:#10b981;color:#fff;padding:12px 28px;border-radius:8px;text-decoration:none;font-weight:600">Download Now</a>
      </div>
    </div>`,

  'subscription-upgrade': (d) => `
    <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;background:#f9fafb;padding:2rem;border-radius:12px">
      <h2 style="color:#1f2937">You're now on ${d.planName}! 🚀</h2>
      <p style="color:#374151">Hi <strong>${d.name}</strong>, your subscription has been activated.</p>
      <p style="color:#374151">Enjoy unlimited papers, all templates, DOCX exports, and priority support.</p>
      <div style="text-align:center;margin:2rem 0">
        <a href="${process.env.FRONTEND_URL}/dashboard" style="background:#2563eb;color:#fff;padding:12px 28px;border-radius:8px;text-decoration:none;font-weight:600">Start Creating →</a>
      </div>
    </div>`,
};

export async function sendEmail({ to, subject, template, data }: EmailOptions): Promise<void> {
  const html = templates[template]?.(data);
  if (!html) {
    throw new Error(`Unknown email template: ${template}`);
  }

  await transporter.sendMail({
    from: process.env.EMAIL_FROM || 'PaperCraft AI <noreply@papercraft.ai>',
    to,
    subject,
    html,
  });

  logger.info(`Email sent: ${template} → ${to}`);
}
