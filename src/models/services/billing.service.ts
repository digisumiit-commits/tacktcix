import prisma from '../utils/prisma.js';
import { SubscriptionStatus } from '@prisma/client';
import { walletService } from './wallet.service';

export class BillingService {
  async getPlans() {
    return prisma.billingPlan.findMany({ where: { isPublic: true }, orderBy: { basePriceCents: 'asc' } });
  }

  async getPlan(planId: string) {
    return prisma.billingPlan.findUnique({ where: { id: planId } });
  }

  async createPlan(data: {
    name: string;
    description?: string;
    interval?: 'MONTHLY' | 'YEARLY';
    basePriceCents?: number;
    includedCredits?: number;
    isPublic?: boolean;
  }) {
    return prisma.billingPlan.create({ data });
  }

  async getSubscription(userId: string) {
    return prisma.subscription.findUnique({
      where: { userId },
      include: { plan: true },
    });
  }

  async createOrUpdateSubscription(
    userId: string,
    planId: string,
    autoRecharge?: { enabled: boolean; amountCents: number; thresholdCredits: number },
  ) {
    const existing = await prisma.subscription.findUnique({ where: { userId } });
    const plan = await prisma.billingPlan.findUnique({ where: { id: planId } });
    if (!plan) throw new Error('Plan not found');

    const now = new Date();
    const periodEnd = new Date(now);
    periodEnd.setMonth(periodEnd.getMonth() + (plan.interval === 'YEARLY' ? 12 : 1));

    const data = {
      planId,
      status: 'ACTIVE' as SubscriptionStatus,
      currentPeriodStart: now,
      currentPeriodEnd: periodEnd,
      trialEndsAt: null as Date | null,
      autoRechargeEnabled: autoRecharge?.enabled ?? existing?.autoRechargeEnabled ?? false,
      autoRechargeAmountCents: autoRecharge?.amountCents ?? existing?.autoRechargeAmountCents ?? 0,
      autoRechargeThresholdCredits: autoRecharge?.thresholdCredits ?? existing?.autoRechargeThresholdCredits ?? 0,
      canceledAt: null,
    };

    if (existing) {
      return prisma.subscription.update({ where: { userId }, data, include: { plan: true } });
    }

    const subscription = await prisma.subscription.create({
      data: { userId, ...data },
      include: { plan: true },
    });

    // Grant included credits on first subscription
    if (plan.includedCredits > 0) {
      await walletService.addCredits(
        userId,
        plan.includedCredits,
        'CREDIT_BONUS',
        `Included credits for ${plan.name} plan`,
      );
    }

    return subscription;
  }

  async cancelSubscription(userId: string) {
    return prisma.subscription.update({
      where: { userId },
      data: { status: 'CANCELED', canceledAt: new Date() },
    });
  }

  async setAutoRecharge(userId: string, enabled: boolean, amountCredits: number, thresholdCredits: number) {
    const config = await prisma.autoRechargeConfig.upsert({
      where: { userId },
      create: { userId, enabled, rechargeAmountCredits: amountCredits, thresholdCredits },
      update: { enabled, rechargeAmountCredits: amountCredits, thresholdCredits },
    });

    await prisma.subscription.update({
      where: { userId },
      data: {
        autoRechargeEnabled: enabled,
        autoRechargeAmountCents: amountCredits,
        autoRechargeThresholdCredits: thresholdCredits,
      },
    });

    return config;
  }

  async getAutoRechargeConfig(userId: string) {
    return prisma.autoRechargeConfig.findUnique({ where: { userId } });
  }

  async generateInvoice(userId: string, periodStart: Date, periodEnd: Date) {
    const subscription = await prisma.subscription.findUnique({
      where: { userId },
      include: { plan: true },
    });

    const usageRecords = await prisma.usageRecord.findMany({
      where: { userId, recordedAt: { gte: periodStart, lt: periodEnd } },
    });

    const subtotalCents = subscription?.plan.basePriceCents ?? 0;
    const taxCents = Math.round(subtotalCents * 0.085);
    const totalCents = subtotalCents + taxCents;

    const invoice = await prisma.invoice.create({
      data: {
        userId,
        subscriptionId: subscription?.id,
        periodStart,
        periodEnd,
        subtotalCents,
        taxCents,
        totalCents,
        status: 'open',
        lineItems: {
          create: [
            {
              description: subscription?.plan.name ?? 'Usage',
              resource: 'TOKENS',
              quantity: 1,
              unitPriceCents: subtotalCents,
              totalCents: subtotalCents,
            },
          ],
        },
      },
      include: { lineItems: true },
    });

    return invoice;
  }

  async getInvoices(userId: string, limit = 20, offset = 0) {
    return prisma.invoice.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: limit,
      skip: offset,
      include: { lineItems: true },
    });
  }

  async getInvoice(invoiceId: string) {
    return prisma.invoice.findUnique({
      where: { id: invoiceId },
      include: { lineItems: true },
    });
  }

  async markInvoicePaid(invoiceId: string) {
    return prisma.invoice.update({
      where: { id: invoiceId },
      data: { status: 'paid', paidAt: new Date() },
    });
  }
}

export const billingService = new BillingService();
