import { Router, Request, Response } from 'express';
import { authenticate } from '../middleware/authenticate';
import { asyncHandler } from '../middleware/asyncHandler';
import { prisma } from '../utils/prisma';
import { logger } from '../utils/logger';
import crypto from 'crypto';

const router = Router();

// ─────────────────────────────────────────
// INITIALIZE RAZORPAY SAFELY
// ─────────────────────────────────────────

function getRazorpay() {
  const keyId = process.env.RAZORPAY_KEY_ID;
  const keySecret = process.env.RAZORPAY_KEY_SECRET;

  if (!keyId || !keySecret) {
    throw new Error('Razorpay keys not configured in .env');
  }

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const Razorpay = require('razorpay');
  return new Razorpay({
    key_id: keyId,
    key_secret: keySecret,
  });
}

// ─────────────────────────────────────────
// GET PLANS
// ─────────────────────────────────────────

router.get('/plans', asyncHandler(async (req: Request, res: Response) => {
  const plans = await prisma.plan.findMany({
    where: { isActive: true },
    orderBy: { priceMonthly: 'asc' },
  });
  res.json({ success: true, data: plans });
}));

// ─────────────────────────────────────────
// GET CURRENT SUBSCRIPTION
// ─────────────────────────────────────────

router.get('/subscription', authenticate, asyncHandler(async (req: Request, res: Response) => {
  const userId = (req as any).user.userId;
  const subscription = await prisma.subscription.findUnique({
    where: { userId },
    include: { plan: true },
  });
  res.json({ success: true, data: subscription });
}));

// ─────────────────────────────────────────
// GET PAYMENT HISTORY
// ─────────────────────────────────────────

router.get('/history', authenticate, asyncHandler(async (req: Request, res: Response) => {
  const userId = (req as any).user.userId;
  const payments = await prisma.payment.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' },
    take: 20,
  });
  res.json({ success: true, data: payments });
}));

// ─────────────────────────────────────────
// CREATE ORDER
// ─────────────────────────────────────────

router.post('/create-order', authenticate, asyncHandler(async (req: Request, res: Response) => {
  const userId = (req as any).user.userId;
  const { planId, billingCycle = 'monthly' } = req.body;

  logger.info(`Create order: userId=${userId}, planId=${planId}, cycle=${billingCycle}`);

  if (!planId) {
    return res.status(400).json({ success: false, error: 'planId is required' });
  }

  const plan = await prisma.plan.findUnique({ where: { id: planId } });
  if (!plan) {
    return res.status(404).json({ success: false, error: 'Plan not found' });
  }

  if (plan.type === 'FREE') {
    return res.status(400).json({ success: false, error: 'Cannot purchase free plan' });
  }

  const amount = billingCycle === 'yearly' ? plan.priceYearly : plan.priceMonthly;

  if (!amount || amount <= 0) {
    return res.status(400).json({ success: false, error: 'Invalid plan amount' });
  }

  try {
    const razorpay = getRazorpay();

    const order = await razorpay.orders.create({
      amount,
      currency: 'INR',
      receipt: `rcpt_${userId.substring(0, 8)}_${Date.now()}`,
      notes: {
        userId,
        planId: plan.id,
        planType: plan.type,
        billingCycle,
      },
    });

    logger.info(`Order created: ${order.id} for ${plan.name} plan`);

    res.json({
      success: true,
      data: {
        orderId: order.id,
        amount,
        currency: 'INR',
        planName: plan.name,
        planType: plan.type,
        billingCycle,
      },
    });

  } catch (razorpayErr: unknown) {
    const errMsg = razorpayErr instanceof Error
      ? razorpayErr.message
      : 'Razorpay order creation failed';
    logger.error('Razorpay error:', errMsg);
    return res.status(500).json({
      success: false,
      error: errMsg,
    });
  }
}));

// ─────────────────────────────────────────
// VERIFY PAYMENT
// ─────────────────────────────────────────

router.post('/verify', authenticate, asyncHandler(async (req: Request, res: Response) => {
  const userId = (req as any).user.userId;
  const {
    razorpayOrderId,
    razorpayPaymentId,
    razorpaySignature,
    planId,
    billingCycle = 'monthly',
  } = req.body;

  logger.info(`Verify payment: orderId=${razorpayOrderId}, paymentId=${razorpayPaymentId}`);

  if (!razorpayOrderId || !razorpayPaymentId || !razorpaySignature) {
    return res.status(400).json({ success: false, error: 'Missing payment details' });
  }

  // Verify signature
  const keySecret = process.env.RAZORPAY_KEY_SECRET;
  if (!keySecret) {
    return res.status(500).json({ success: false, error: 'Payment configuration error' });
  }

  const expectedSignature = crypto
    .createHmac('sha256', keySecret)
    .update(`${razorpayOrderId}|${razorpayPaymentId}`)
    .digest('hex');

  if (expectedSignature !== razorpaySignature) {
    logger.error('Invalid payment signature');
    return res.status(400).json({ success: false, error: 'Invalid payment signature' });
  }

  const plan = await prisma.plan.findUnique({ where: { id: planId } });
  if (!plan) {
    return res.status(404).json({ success: false, error: 'Plan not found' });
  }

  const amount = billingCycle === 'yearly' ? plan.priceYearly : plan.priceMonthly;

  const now = new Date();
  const periodEnd = new Date(now);
  if (billingCycle === 'yearly') {
    periodEnd.setFullYear(periodEnd.getFullYear() + 1);
  } else {
    periodEnd.setMonth(periodEnd.getMonth() + 1);
  }

  // Update subscription
  await prisma.subscription.update({
    where: { userId },
    data: {
      planId,
      status: 'ACTIVE',
      currentPeriodStart: now,
      currentPeriodEnd: periodEnd,
      cancelAtPeriodEnd: false,
    },
  });

  // Save payment record
  await prisma.payment.create({
    data: {
      userId,
      amount,
      currency: 'INR',
      status: 'captured',
      razorpayOrderId,
      razorpayPayId: razorpayPaymentId,
      razorpaySigId: razorpaySignature,
      description: `${plan.name} Plan - ${billingCycle}`,
    },
  });

  logger.info(`Payment verified: user ${userId} upgraded to ${plan.name}`);

  res.json({
    success: true,
    data: {
      message: `Successfully upgraded to ${plan.name} plan!`,
      planType: plan.type,
      planName: plan.name,
      periodEnd,
    },
  });
}));

// ─────────────────────────────────────────
// CANCEL SUBSCRIPTION
// ─────────────────────────────────────────

router.post('/cancel', authenticate, asyncHandler(async (req: Request, res: Response) => {
  const userId = (req as any).user.userId;

  await prisma.subscription.update({
    where: { userId },
    data: { cancelAtPeriodEnd: true },
  });

  res.json({
    success: true,
    data: { message: 'Subscription will be cancelled at end of billing period.' },
  });
}));

// ─────────────────────────────────────────
// WEBHOOK
// ─────────────────────────────────────────

router.post('/webhook', asyncHandler(async (req: Request, res: Response) => {
  const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
  if (!secret) {
    return res.status(500).json({ error: 'Webhook not configured' });
  }

  const signature = req.headers['x-razorpay-signature'] as string;
  const body = JSON.stringify(req.body);

  const expectedSignature = crypto
    .createHmac('sha256', secret)
    .update(body)
    .digest('hex');

  if (signature !== expectedSignature) {
    return res.status(400).json({ error: 'Invalid signature' });
  }

  const event = req.body.event;
  logger.info(`Webhook: ${event}`);

  if (event === 'payment.captured') {
    logger.info(`Payment captured: ${req.body.payload?.payment?.entity?.id}`);
  }

  if (event === 'subscription.cancelled') {
    const sub = req.body.payload?.subscription?.entity;
    if (sub?.id) {
      const dbSub = await prisma.subscription.findFirst({
        where: { razorpaySubId: sub.id },
      });
      if (dbSub) {
        await prisma.subscription.update({
          where: { id: dbSub.id },
          data: { status: 'CANCELLED', cancelAtPeriodEnd: true },
        });
      }
    }
  }

  res.json({ status: 'ok' });
}));

export default router;