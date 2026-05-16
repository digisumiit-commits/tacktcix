import prisma from '../utils/prisma.js';
import { TransactionType } from '@prisma/client';

export class WalletService {
  async getOrCreateWallet(userId: string) {
    let wallet = await prisma.wallet.findUnique({ where: { userId } });
    if (!wallet) {
      wallet = await prisma.wallet.create({ data: { userId } });
    }
    return wallet;
  }

  async getBalance(userId: string): Promise<number> {
    const wallet = await this.getOrCreateWallet(userId);
    return wallet.creditBalance;
  }

  async addCredits(
    userId: string,
    amount: number,
    type: TransactionType = 'CREDIT_PURCHASE',
    description?: string,
    idempotencyKey?: string,
  ) {
    if (amount <= 0) throw new Error('Credit amount must be positive');

    const wallet = await this.getOrCreateWallet(userId);

    if (idempotencyKey) {
      const existing = await prisma.creditTransaction.findUnique({
        where: { idempotencyKey },
      });
      if (existing) return wallet;
    }

    const [updated] = await prisma.$transaction([
      prisma.wallet.update({
        where: { id: wallet.id },
        data: {
          creditBalance: { increment: amount },
          lifetimeCreditsAdded: { increment: amount },
        },
      }),
      prisma.creditTransaction.create({
        data: { walletId: wallet.id, amountCredits: amount, type, description, idempotencyKey },
      }),
    ]);

    await this.checkAutoRecharge(userId);
    return updated;
  }

  async deductCredits(
    userId: string,
    amount: number,
    description?: string,
    idempotencyKey?: string,
  ) {
    if (amount <= 0) throw new Error('Deduction amount must be positive');

    const wallet = await this.getOrCreateWallet(userId);

    if (wallet.creditBalance < amount) {
      throw new Error(`Insufficient credits: have ${wallet.creditBalance}, need ${amount}`);
    }

    if (idempotencyKey) {
      const existing = await prisma.creditTransaction.findUnique({
        where: { idempotencyKey },
      });
      if (existing) return wallet;
    }

    const [updated] = await prisma.$transaction([
      prisma.wallet.update({
        where: { id: wallet.id },
        data: { creditBalance: { decrement: amount } },
      }),
      prisma.creditTransaction.create({
        data: { walletId: wallet.id, amountCredits: -amount, type: 'USAGE_DEDUCTION', description, idempotencyKey },
      }),
    ]);

    await this.checkAutoRecharge(userId);
    return updated;
  }

  async getTransactions(walletId: string, limit = 50, offset = 0) {
    return prisma.creditTransaction.findMany({
      where: { walletId },
      orderBy: { createdAt: 'desc' },
      take: limit,
      skip: offset,
    });
  }

  async hasSufficientCredits(userId: string, required: number): Promise<boolean> {
    const balance = await this.getBalance(userId);
    return balance >= required;
  }

  private async checkAutoRecharge(userId: string) {
    const config = await prisma.autoRechargeConfig.findUnique({ where: { userId } });
    if (!config?.enabled) return;

    const wallet = await prisma.wallet.findUnique({ where: { userId } });
    if (!wallet) return;

    if (wallet.creditBalance < 0) {
      // balance went negative, trigger emergency recharge regardless of threshold
      await this.performAutoRecharge(userId, config, wallet.id);
      return;
    }

    if (wallet.creditBalance <= config.thresholdCredits) {
      await this.performAutoRecharge(userId, config, wallet.id);
    }
  }

  private async performAutoRecharge(
    userId: string,
    config: { id: string; rechargeAmountCredits: number; maxRechargesPerMonth: number; rechargeCountThisMonth: number },
    walletId: string,
  ) {
    if (config.rechargeCountThisMonth >= config.maxRechargesPerMonth) return;

    await prisma.$transaction([
      prisma.wallet.update({
        where: { id: walletId },
        data: { creditBalance: { increment: config.rechargeAmountCredits } },
      }),
      prisma.creditTransaction.create({
        data: {
          walletId,
          amountCredits: config.rechargeAmountCredits,
          type: 'AUTO_RECHARGE',
          description: `Auto-recharge of ${config.rechargeAmountCredits} credits`,
        },
      }),
      prisma.autoRechargeConfig.update({
        where: { id: config.id },
        data: {
          rechargeCountThisMonth: { increment: 1 },
          lastRechargeAt: new Date(),
        },
      }),
    ]);
  }
}

export const walletService = new WalletService();
