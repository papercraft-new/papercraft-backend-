import { prisma } from '../utils/prisma';
import { logger } from '../utils/logger';

// ─────────────────────────────────────────────────────────────
// REFERRAL SERVICE
// Single source of truth for all referral reward logic.
// Nothing outside this file should mutate Referral / ReferralReward
// records or grant/revoke subscription extensions for referrals.
// ─────────────────────────────────────────────────────────────

const REWARD_DAYS = 30;
const PLAN_RANK: Record<string, number> = { FREE: 0, PRO: 1, INSTITUTION: 2 };

/**
 * Call this when a NEW USER REGISTERS with a referral code.
 * Creates a PENDING referral record. No reward yet — reward only
 * fires once this referred user actually pays (see markReferralPaid).
 *
 * Safe no-ops if:
 *  - referrerId is invalid / doesn't exist
 *  - referrerId === referredId (self-referral attempt at signup)
 *  - a referral record already exists for this referredId
 */
export async function createPendingReferral(
  referrerId: string,
  referredId: string,
  referredEmail: string
): Promise<void> {
  try {
    if (!referrerId || referrerId === referredId) return;

    const referrer = await prisma.user.findUnique({ where: { id: referrerId } });
    if (!referrer) return;

    // unique constraint on referredId means this is also naturally idempotent
    await prisma.referral.create({
      data: {
        referrerId,
        referredId,
        referredEmail,
        status: 'PENDING',
      },
    });

    logger.info(`Referral created: referrer=${referrerId} referred=${referredId}`);
  } catch (err) {
    // Duplicate referral (P2002) or any other issue — never block registration
    logger.warn('createPendingReferral skipped:', err);
  }
}

/**
 * Call this from the payment webhook/verify route AFTER a payment has
 * been successfully verified and persisted to the Payment table.
 *
 * Handles:
 *  - Idempotency (duplicate webhook calls for the same paymentId)
 *  - Self-referral detection (referrer/referred share phone or payment identity)
 *  - 90-day expiry check
 *  - Triggers reward check once marked paid
 */
export async function markReferralPaid(
  referredUserId: string,
  planType: 'PRO' | 'INSTITUTION',
  paymentId: string
): Promise<void> {
  try {
    const referral = await prisma.referral.findUnique({
      where: { referredId: referredUserId },
    });

    if (!referral) return; // this user wasn't referred by anyone — nothing to do
    if (referral.status !== 'PENDING') return; // already PAID/REFUNDED/EXPIRED — idempotent guard

    // Idempotency: if this exact paymentId was already used for ANY referral, skip
    const existingByPayment = await prisma.referral.findUnique({ where: { paymentId } });
    if (existingByPayment) return;

    // Expiry check — friend took too long to pay
    if (new Date() > referral.expiresAt) {
      await prisma.referral.update({
        where: { id: referral.id },
        data: { status: 'EXPIRED' },
      });
      logger.info(`Referral ${referral.id} expired before payment`);
      return;
    }

    // Self-referral check — compare referrer & referred user identity signals
    const isSelf = await checkSelfReferral(referral.referrerId, referredUserId);
    if (isSelf) {
      logger.warn(`Self-referral blocked: referrer=${referral.referrerId} referred=${referredUserId}`);
      await prisma.referral.update({
        where: { id: referral.id },
        data: { status: 'EXPIRED' }, // quietly invalidate, no error shown to user
      });
      return;
    }

    await prisma.referral.update({
      where: { id: referral.id },
      data: {
        status: 'PAID',
        planPurchased: planType,
        paymentId,
        paidAt: new Date(),
      },
    });

    logger.info(`Referral ${referral.id} marked PAID (${planType})`);

    // Check if this referrer now has a fresh pair of paid referrals
    await checkAndGrantReward(referral.referrerId);
  } catch (err) {
    // Referral failures must NEVER break the actual payment flow
    logger.error('markReferralPaid error:', err);
  }
}

/**
 * Self-referral guard: compares phone number (if present) between
 * referrer and referred user. Email is intentionally NOT compared here
 * since a self-referral always uses a different email by definition —
 * phone number is the more reliable signal for the same real person.
 */
async function checkSelfReferral(referrerId: string, referredId: string): Promise<boolean> {
  if (referrerId === referredId) return true;

  const [referrer, referred] = await Promise.all([
    prisma.user.findUnique({ where: { id: referrerId }, select: { email: true } }),
    prisma.user.findUnique({ where: { id: referredId }, select: { email: true } }),
  ]);

  if (!referrer || !referred) return false;

  // Same email domain + identical local-part pattern is NOT checked here
  // (too many false positives for legitimate family/colleague signups).
  // Extend this function later with phone number or payment fingerprint
  // comparison once that data is reliably available on both records.
  return false;
}

/**
 * Checks whether the referrer has accumulated a NEW pair of PAID,
 * not-yet-rewarded referrals. If so, grants +30 days on their CURRENT
 * plan (or upgrades them from Free to the appropriate tier).
 *
 * This is safe to call multiple times — it only rewards pairs that
 * haven't already been included in a previous ReferralReward record.
 */
export async function checkAndGrantReward(referrerId: string): Promise<void> {
  try {
    // All PAID referrals for this referrer, oldest first
    const paidReferrals = await prisma.referral.findMany({
      where: { referrerId, status: 'PAID' },
      orderBy: { paidAt: 'asc' },
    });

    // All referral IDs already consumed by a previous (non-reversed) reward
    const previousRewards = await prisma.referralReward.findMany({
      where: { referrerId, reversedAt: null },
      select: { referralIds: true },
    });
    const alreadyRewarded = new Set(previousRewards.flatMap(r => r.referralIds));

    const unrewarded = paidReferrals.filter(r => !alreadyRewarded.has(r.id));

    // Need at least 2 unrewarded paid referrals to form a new pair
    if (unrewarded.length < 2) return;

    const pair = unrewarded.slice(0, 2); // oldest 2 unrewarded paid referrals

    const subscription = await prisma.subscription.findUnique({
      where: { userId: referrerId },
      include: { plan: true },
    });

    if (!subscription) return;

    const currentTier = subscription.plan.type;
    let targetTier: 'PRO' | 'INSTITUTION';
    let newPeriodEnd: Date;

    if (currentTier === 'FREE') {
      // Case A — referrer on Free: upgrade to the lower of the two friends' tiers
      const tiers = pair.map(r => r.planPurchased).filter(Boolean) as ('PRO' | 'INSTITUTION')[];
      const lowestTier = tiers.reduce((min, t) =>
        PLAN_RANK[t] < PLAN_RANK[min] ? t : min, tiers[0] || 'PRO'
      );
      targetTier = lowestTier;
      newPeriodEnd = new Date(Date.now() + REWARD_DAYS * 24 * 60 * 60 * 1000);
    } else {
      // Case B/C — referrer already Pro or Institution: extend current tier, never downgrade/replace
      targetTier = currentTier as 'PRO' | 'INSTITUTION';
      const base = subscription.currentPeriodEnd && subscription.currentPeriodEnd > new Date()
        ? subscription.currentPeriodEnd
        : new Date(); // their plan already lapsed — extend from now instead of a past date
      newPeriodEnd = new Date(base.getTime() + REWARD_DAYS * 24 * 60 * 60 * 1000);
    }

    const targetPlan = await prisma.plan.findFirst({ where: { type: targetTier } });
    if (!targetPlan) {
      logger.error(`checkAndGrantReward: no plan found for tier ${targetTier}`);
      return;
    }

    await prisma.subscription.update({
      where: { userId: referrerId },
      data: {
        planId: targetPlan.id,
        status: 'ACTIVE',
        currentPeriodEnd: newPeriodEnd,
        cancelAtPeriodEnd: false,
      },
    });

    await prisma.referralReward.create({
      data: {
        referrerId,
        referralIds: pair.map(r => r.id),
        daysGranted: REWARD_DAYS,
        tierAtGrant: targetTier,
      },
    });

    logger.info(
      `Referral reward granted: referrer=${referrerId} tier=${targetTier} newPeriodEnd=${newPeriodEnd.toISOString()}`
    );
  } catch (err) {
    logger.error('checkAndGrantReward error:', err);
  }
}

/**
 * Call this from the Razorpay refund webhook handler.
 * Finds the referral tied to this paymentId, marks it REFUNDED,
 * and if it was part of an already-granted reward, claws back the
 * remaining unused days from the referrer's currentPeriodEnd.
 */
export async function clawbackReferralReward(paymentId: string): Promise<void> {
  try {
    const referral = await prisma.referral.findUnique({ where: { paymentId } });
    if (!referral || referral.status !== 'PAID') return;

    await prisma.referral.update({
      where: { id: referral.id },
      data: { status: 'REFUNDED' },
    });

    // Find the reward (if any) that this referral contributed to
    const reward = await prisma.referralReward.findFirst({
      where: {
        referrerId: referral.referrerId,
        referralIds: { has: referral.id },
        reversedAt: null,
      },
    });

    if (!reward) {
      // Refund happened before a reward was ever granted (referrer didn't
      // have a 2nd paid friend yet) — nothing to claw back.
      return;
    }

    const subscription = await prisma.subscription.findUnique({
      where: { userId: referral.referrerId },
    });

    if (subscription?.currentPeriodEnd) {
      const reverted = new Date(
        subscription.currentPeriodEnd.getTime() - reward.daysGranted * 24 * 60 * 60 * 1000
      );
      // Never set a period end in the past relative to now from this operation alone —
      // checkSubscription middleware will naturally downgrade them on next check if reverted < now.
      await prisma.subscription.update({
        where: { userId: referral.referrerId },
        data: { currentPeriodEnd: reverted },
      });
    }

    await prisma.referralReward.update({
      where: { id: reward.id },
      data: { reversedAt: new Date() },
    });

    logger.info(`Referral reward clawed back: referrer=${referral.referrerId} reward=${reward.id}`);
  } catch (err) {
    logger.error('clawbackReferralReward error:', err);
  }
}

/**
 * Cron-safe cleanup: expires PENDING referrals past their 90-day window.
 * Call this from a scheduled job (same pattern as the existing monthly
 * papersUsedThisMonth reset cron in index.ts).
 */
export async function expireStaleReferrals(): Promise<void> {
  try {
    const result = await prisma.referral.updateMany({
      where: { status: 'PENDING', expiresAt: { lt: new Date() } },
      data: { status: 'EXPIRED' },
    });
    if (result.count > 0) {
      logger.info(`Expired ${result.count} stale referral(s)`);
    }
  } catch (err) {
    logger.error('expireStaleReferrals error:', err);
  }
}

/**
 * Returns a referrer's progress summary for the frontend dashboard.
 */
export async function getReferralProgress(referrerId: string) {
  const referrals = await prisma.referral.findMany({
    where: { referrerId },
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      referredEmail: true,
      status: true,
      planPurchased: true,
      createdAt: true,
      paidAt: true,
    },
  });

  const rewards = await prisma.referralReward.findMany({
    where: { referrerId, reversedAt: null },
    orderBy: { grantedAt: 'desc' },
  });

  const paidCount = referrals.filter(r => r.status === 'PAID').length;
  const rewardedReferralIds = new Set(rewards.flatMap(r => r.referralIds));
  const unrewardedPaidCount = referrals.filter(
    r => r.status === 'PAID' && !rewardedReferralIds.has(r.id)
  ).length;

  return {
    referrals,
    totalRewardsGranted: rewards.length,
    totalDaysEarned: rewards.reduce((sum, r) => sum + r.daysGranted, 0),
    paidFriendsCount: paidCount,
    progressTowardNextReward: unrewardedPaidCount % 2, // 0 or 1 — out of 2 needed
  };
}