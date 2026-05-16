import prisma from '../utils/prisma.js';
import { ResourceType } from '@prisma/client';
import { calculateCredits } from '../pricing';
import { walletService } from './wallet.service';

export interface RecordUsageInput {
  userId: string;
  resource: ResourceType;
  amount: number;
  unit: string;
  description?: string;
  idempotencyKey?: string;
}

export class UsageService {
  async recordUsage(input: RecordUsageInput) {
    const costCredits = calculateCredits(input.resource, input.amount);

    let usageRecord;
    await prisma.$transaction(async (tx) => {
      usageRecord = await tx.usageRecord.create({
        data: {
          userId: input.userId,
          resource: input.resource,
          amount: input.amount,
          unit: input.unit,
          costCredits,
          description: input.description,
        },
      });

      const wallet = await tx.wallet.findUnique({ where: { userId: input.userId } });
      if (wallet && wallet.creditBalance >= costCredits) {
        await tx.wallet.update({
          where: { id: wallet.id },
          data: { creditBalance: { decrement: costCredits } },
        });
        await tx.creditTransaction.create({
          data: {
            walletId: wallet.id,
            amountCredits: -costCredits,
            type: 'USAGE_DEDUCTION',
            description: input.description ?? `${input.resource} usage: ${input.amount} ${input.unit}`,
            idempotencyKey: input.idempotencyKey,
          },
        });
      }
    });

    // Check auto-recharge after the transaction
    await walletService.getOrCreateWallet(input.userId); // triggers auto-recharge check
    return usageRecord;
  }

  async getUsageByResource(userId: string, resource: ResourceType, since?: Date) {
    return prisma.usageRecord.findMany({
      where: {
        userId,
        resource,
        ...(since ? { recordedAt: { gte: since } } : {}),
      },
      orderBy: { recordedAt: 'desc' },
      take: 100,
    });
  }

  async getUsageSummary(userId: string, since?: Date) {
    const records = await prisma.usageRecord.findMany({
      where: {
        userId,
        ...(since ? { recordedAt: { gte: since } } : {}),
      },
    });

    const summary: Record<string, { totalAmount: number; totalCredits: number; unit: string }> = {};
    for (const r of records) {
      if (!summary[r.resource]) {
        summary[r.resource] = { totalAmount: 0, totalCredits: 0, unit: r.unit };
      }
      summary[r.resource].totalAmount += r.amount;
      summary[r.resource].totalCredits += r.costCredits;
    }
    return summary;
  }

  async getDailyUsage(userId: string, days = 30) {
    const since = new Date();
    since.setDate(since.getDate() - days);

    return prisma.usageRecord.findMany({
      where: { userId, recordedAt: { gte: since } },
      orderBy: { recordedAt: 'desc' },
    });
  }

  async getTotalCreditsSpent(userId: string, since?: Date) {
    const result = await prisma.usageRecord.aggregate({
      where: {
        userId,
        ...(since ? { recordedAt: { gte: since } } : {}),
      },
      _sum: { costCredits: true },
    });
    return result._sum.costCredits ?? 0;
  }
}

export const usageService = new UsageService();
