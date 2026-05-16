import prisma from '../utils/prisma.js';
import { ResourceType } from '@prisma/client';

export class AnalyticsService {
  async getDashboard(userId: string) {
    const wallet = await prisma.wallet.findUnique({ where: { userId } });
    const subscription = await prisma.subscription.findUnique({
      where: { userId },
      include: { plan: true },
    });

    const now = new Date();
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

    const recentUsage = await prisma.usageRecord.findMany({
      where: { userId, recordedAt: { gte: thirtyDaysAgo } },
      orderBy: { recordedAt: 'desc' },
    });

    const usageByResource = this.aggregateByResource(recentUsage);
    const dailySpend = this.aggregateByDay(recentUsage);
    const resourceBreakdown = this.computeResourceBreakdown(usageByResource);

    const totalCreditsSpent30d = recentUsage.reduce((sum, r) => sum + r.costCredits, 0);

    const recentTransactions = await prisma.creditTransaction.findMany({
      where: { walletId: wallet?.id },
      orderBy: { createdAt: 'desc' },
      take: 20,
    });

    return {
      balance: wallet?.creditBalance ?? 0,
      lifetimeCreditsAdded: wallet?.lifetimeCreditsAdded ?? 0,
      totalCreditsSpent30d,
      subscription: subscription
        ? {
            planName: subscription.plan.name,
            status: subscription.status,
            currentPeriodEnd: subscription.currentPeriodEnd,
            autoRechargeEnabled: subscription.autoRechargeEnabled,
          }
        : null,
      usageByResource,
      dailySpend,
      resourceBreakdown,
      recentTransactions,
      estimatedBurnRate: totalCreditsSpent30d / 30,
    };
  }

  async getResourceAnalytics(userId: string, resource: ResourceType, days = 30) {
    const since = new Date();
    since.setDate(since.getDate() - days);

    const records = await prisma.usageRecord.findMany({
      where: { userId, resource, recordedAt: { gte: since } },
      orderBy: { recordedAt: 'asc' },
    });

    const totalCredits = records.reduce((sum, r) => sum + r.costCredits, 0);
    const totalAmount = records.reduce((sum, r) => sum + r.amount, 0);

    return {
      resource,
      periodDays: days,
      totalCredits,
      totalAmount,
      recordCount: records.length,
      averagePerDay: records.length > 0 ? totalCredits / days : 0,
      dailyBreakdown: this.aggregateByDay(records),
    };
  }

  async getSpendingTrend(userId: string, days = 90) {
    const since = new Date();
    since.setDate(since.getDate() - days);

    const records = await prisma.usageRecord.findMany({
      where: { userId, recordedAt: { gte: since } },
      orderBy: { recordedAt: 'asc' },
    });

    const daily = this.aggregateByDay(records);
    const weeks: { label: string; credits: number }[] = [];
    let currentWeekLabel = '';
    let currentWeekCredits = 0;

    for (const [dateStr, credits] of Object.entries(daily)) {
      const date = new Date(dateStr);
      const weekStart = new Date(date);
      weekStart.setDate(date.getDate() - date.getDay());
      const label = weekStart.toISOString().slice(0, 10);

      if (label !== currentWeekLabel) {
        if (currentWeekLabel) weeks.push({ label: currentWeekLabel, credits: currentWeekCredits });
        currentWeekLabel = label;
        currentWeekCredits = 0;
      }
      currentWeekCredits += credits;
    }
    if (currentWeekLabel) weeks.push({ label: currentWeekLabel, credits: currentWeekCredits });

    return { daily, weekly: weeks, totalCredits: records.reduce((s, r) => s + r.costCredits, 0) };
  }

  private aggregateByResource(records: { resource: string; amount: number; costCredits: number }[]) {
    const agg: Record<string, { totalAmount: number; totalCredits: number }> = {};
    for (const r of records) {
      if (!agg[r.resource]) agg[r.resource] = { totalAmount: 0, totalCredits: 0 };
      agg[r.resource].totalAmount += r.amount;
      agg[r.resource].totalCredits += r.costCredits;
    }
    return agg;
  }

  private aggregateByDay(records: { recordedAt: Date; costCredits: number }[]) {
    const daily: Record<string, number> = {};
    for (const r of records) {
      const day = r.recordedAt.toISOString().slice(0, 10);
      daily[day] = (daily[day] ?? 0) + r.costCredits;
    }
    return daily;
  }

  private computeResourceBreakdown(usageByResource: Record<string, { totalAmount: number; totalCredits: number }>) {
    const total = Object.values(usageByResource).reduce((s, v) => s + v.totalCredits, 0);
    if (total === 0) return {};
    const breakdown: Record<string, { credits: number; percentage: number }> = {};
    for (const [resource, data] of Object.entries(usageByResource)) {
      breakdown[resource] = {
        credits: data.totalCredits,
        percentage: Math.round((data.totalCredits / total) * 1000) / 10,
      };
    }
    return breakdown;
  }
}

export const analyticsService = new AnalyticsService();
