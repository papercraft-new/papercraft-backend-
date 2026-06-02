import { logger } from './logger';

interface EmailOptions {
  to: string;
  subject: string;
  template: 'welcome' | 'password-reset' | 'export-ready' | 'subscription-upgrade';
  data: Record<string, string>;
}

async function sendBrevoEmail(to: string, subject: string, html: string): Promise<void> {
  const response = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: {
      'Accept': 'application/json',
      'Content-Type': 'application/json',
      'api-key': process.env.BREVO_API_KEY || '',
    },
    body: JSON.stringify({
      sender: {
        name: 'PaperCraft AI',
        email: process.env.SMTP_USER, // your Brevo login email
      },
      to: [{ email: to }],
      subject,
      htmlContent: html,
    }),
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(`Brevo API error: ${JSON.stringify(error)}`);
  }
}

export function getTransporter() {
  return {
    sendMail: async (opts: { from: string; to: string; subject: string; html: string }) => {
      await sendBrevoEmail(opts.to, opts.subject, opts.html);
    },
    verify: async () => true,
  };
}

export async function verifyEmailTransporter(): Promise<void> {
  if (!process.env.BREVO_API_KEY) {
    logger.error('❌ BREVO_API_KEY is not set. Emails will not work.');
    return;
  }
  logger.info('✅ Brevo HTTP API email service ready');
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

  await sendBrevoEmail(to, subject, html);

  logger.info(`Email sent: ${template} → ${to}`);
}