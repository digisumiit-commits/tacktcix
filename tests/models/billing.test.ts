import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Pricing ────────────────────────────────────────────────────

describe('Pricing', () => {
  let pricingModule: typeof import('../src/pricing.js');

  beforeEach(async () => {
    pricingModule = await import('../src/pricing.js');
  });

  it('has pricing rules for all 6 resource types', () => {
    expect(pricingModule.DEFAULT_PRICING.length).toBe(6);
    const resources = pricingModule.DEFAULT_PRICING.map((p) => p.resource);
    expect(resources).toContain('TOKENS');
    expect(resources).toContain('BROWSER_RUNTIME');
    expect(resources).toContain('STORAGE');
    expect(resources).toContain('VECTOR_DB');
    expect(resources).toContain('EXECUTION_TIME');
    expect(resources).toContain('DEPLOYMENT');
  });

  it('getPricingForResource returns correct pricing', () => {
    const tokens = pricingModule.getPricingForResource('TOKENS');
    expect(tokens).toBeDefined();
    expect(tokens!.creditsPerUnit).toBe(1);
    expect(tokens!.unit).toBe('1K tokens');
  });

  it('getPricingForResource returns undefined for unknown resource', () => {
    expect(pricingModule.getPricingForResource('UNKNOWN' as any)).toBeUndefined();
  });

  it('calculateCredits computes token cost correctly', () => {
    // 1 credit per 1K tokens, so 5K tokens = 5 credits
    expect(pricingModule.calculateCredits('TOKENS', 5)).toBe(5);
    // 0.5K tokens rounds up to 1
    expect(pricingModule.calculateCredits('TOKENS', 0.5)).toBe(1);
    // 10K tokens = 10 credits
    expect(pricingModule.calculateCredits('TOKENS', 10)).toBe(10);
  });

  it('calculateCredits computes storage cost correctly', () => {
    // 10 credits per GB-month, so 5 GB-months = 50 credits
    expect(pricingModule.calculateCredits('STORAGE', 5)).toBe(50);
  });

  it('calculateCredits computes deployment cost correctly', () => {
    // 50 credits per deployment
    expect(pricingModule.calculateCredits('DEPLOYMENT', 3)).toBe(150);
  });

  it('calculateCredits rounds up fractional credits', () => {
    // 0.3 * 5 = 1.5, ceil to 2
    expect(pricingModule.calculateCredits('BROWSER_RUNTIME', 0.3)).toBe(2);
  });

  it('calculateCredits returns 0 for unknown resource', () => {
    expect(pricingModule.calculateCredits('UNKNOWN' as any, 10)).toBe(0);
  });

  it('all pricing rules have positive credits per unit', () => {
    for (const p of pricingModule.DEFAULT_PRICING) {
      expect(p.creditsPerUnit).toBeGreaterThan(0);
    }
  });
});

// ── Billing Service (logic tests) ──────────────────────────────

describe('BillingService', () => {
  let billingService: typeof import('../src/services/billing.service.js');

  beforeEach(async () => {
    vi.resetModules();
    // Mock prisma at the module level before importing
    vi.doMock('../src/utils/prisma.js', () => ({
      default: {
        billingPlan: {
          findMany: vi.fn().mockResolvedValue([]),
          findUnique: vi.fn().mockResolvedValue(null),
          create: vi.fn(),
        },
        subscription: {
          findUnique: vi.fn().mockResolvedValue(null),
          create: vi.fn(),
          update: vi.fn(),
        },
        autoRechargeConfig: {
          findUnique: vi.fn().mockResolvedValue(null),
          upsert: vi.fn(),
        },
        usageRecord: {
          findMany: vi.fn().mockResolvedValue([]),
          aggregate: vi.fn().mockResolvedValue({ _sum: { costCredits: 0 } }),
        },
        invoice: {
          findMany: vi.fn().mockResolvedValue([]),
          findUnique: vi.fn().mockResolvedValue(null),
          create: vi.fn(),
          update: vi.fn(),
        },
        wallet: {
          findUnique: vi.fn().mockResolvedValue(null),
          create: vi.fn(),
          update: vi.fn(),
        },
        creditTransaction: {
          findUnique: vi.fn().mockResolvedValue(null),
          findMany: vi.fn().mockResolvedValue([]),
          create: vi.fn(),
        },
        $transaction: vi.fn((fn: any) => fn({
          wallet: { findUnique: vi.fn().mockResolvedValue({ id: 'w1', userId: 'u1', creditBalance: 500, lifetimeCreditsAdded: 1000 }), update: vi.fn() },
          creditTransaction: { create: vi.fn() },
          usageRecord: { create: vi.fn() },
        })),
      },
    }));

    billingService = await import('../src/services/billing.service.js');
  });

  it('getPlans returns empty array when no plans exist', async () => {
    const { default: prisma } = await import('../src/utils/prisma.js');
    (prisma.billingPlan.findMany as any).mockResolvedValue([]);
    const plans = await billingService.billingService.getPlans();
    expect(plans).toEqual([]);
  });

  it('createPlan creates a plan with required fields', async () => {
    const { default: prisma } = await import('../src/utils/prisma.js');
    const mockPlan = { id: 'plan-1', name: 'Starter', basePriceCents: 0, includedCredits: 100 };
    (prisma.billingPlan.create as any).mockResolvedValue(mockPlan);

    const plan = await billingService.billingService.createPlan({ name: 'Starter' });
    expect(plan.name).toBe('Starter');
    expect(prisma.billingPlan.create).toHaveBeenCalled();
  });

  it('getSubscription returns null when user has no subscription', async () => {
    const sub = await billingService.billingService.getSubscription('no-such-user');
    expect(sub).toBeNull();
  });
});

// ── Analytics Service (pure logic) ────────────────────────────

describe('AnalyticsService', () => {
  let analyticsService: typeof import('../src/services/analytics.service.js');

  beforeEach(async () => {
    vi.resetModules();
    vi.doMock('../src/utils/prisma.js', () => ({
      default: {
        wallet: { findUnique: vi.fn().mockResolvedValue(null) },
        subscription: { findUnique: vi.fn().mockResolvedValue(null) },
        usageRecord: { findMany: vi.fn().mockResolvedValue([]) },
        creditTransaction: { findMany: vi.fn().mockResolvedValue([]) },
      },
    }));

    analyticsService = await import('../src/services/analytics.service.js');
  });

  it('getDashboard returns default structure for user with no data', async () => {
    const dashboard = await analyticsService.analyticsService.getDashboard('new-user');
    expect(dashboard.balance).toBe(0);
    expect(dashboard.lifetimeCreditsAdded).toBe(0);
    expect(dashboard.totalCreditsSpent30d).toBe(0);
    expect(dashboard.subscription).toBeNull();
    expect(dashboard.usageByResource).toEqual({});
    expect(dashboard.dailySpend).toEqual({});
    expect(dashboard.resourceBreakdown).toEqual({});
    expect(dashboard.estimatedBurnRate).toBe(0);
    expect(Array.isArray(dashboard.recentTransactions)).toBe(true);
  });

  it('getResourceAnalytics returns structured results', async () => {
    const result = await analyticsService.analyticsService.getResourceAnalytics('user-1', 'TOKENS', 30);
    expect(result.resource).toBe('TOKENS');
    expect(result.periodDays).toBe(30);
    expect(result.totalCredits).toBe(0);
    expect(result.averagePerDay).toBe(0);
  });

  it('getSpendingTrend returns daily, weekly, and total', async () => {
    const trend = await analyticsService.analyticsService.getSpendingTrend('user-1', 90);
    expect(trend).toHaveProperty('daily');
    expect(trend).toHaveProperty('weekly');
    expect(trend).toHaveProperty('totalCredits');
    expect(trend.totalCredits).toBe(0);
  });
});

// ── WalletService ─────────────────────────────────────────────

describe('WalletService', () => {
  let walletService: typeof import('../src/services/wallet.service.js');

  beforeEach(async () => {
    vi.resetModules();
    vi.doMock('../src/utils/prisma.js', () => ({
      default: {
        wallet: {
          findUnique: vi.fn().mockResolvedValue(null),
          create: vi.fn().mockImplementation(({ data }: any) =>
            Promise.resolve({ id: 'wallet-new', userId: data.userId, creditBalance: 0, lifetimeCreditsAdded: 0 }),
          ),
          update: vi.fn(),
        },
        creditTransaction: {
          findUnique: vi.fn().mockResolvedValue(null),
          findMany: vi.fn().mockResolvedValue([]),
          create: vi.fn(),
        },
        autoRechargeConfig: {
          findUnique: vi.fn().mockResolvedValue(null),
          update: vi.fn(),
        },
        $transaction: vi.fn((ops: any[]) => Promise.all(ops)),
      },
    }));

    walletService = await import('../src/services/wallet.service.js');
  });

  it('getOrCreateWallet creates wallet for new user', async () => {
    const wallet = await walletService.walletService.getOrCreateWallet('new-user');
    expect(wallet).toBeDefined();
    expect(wallet.userId).toBe('new-user');
    expect(wallet.creditBalance).toBe(0);
  });

  it('getBalance returns 0 for new user', async () => {
    const balance = await walletService.walletService.getBalance('new-user');
    expect(balance).toBe(0);
  });

  it('addCredits rejects zero amount', async () => {
    await expect(
      walletService.walletService.addCredits('user-1', 0),
    ).rejects.toThrow('Credit amount must be positive');
  });

  it('addCredits rejects negative amount', async () => {
    await expect(
      walletService.walletService.addCredits('user-1', -5),
    ).rejects.toThrow('Credit amount must be positive');
  });

  it('deductCredits rejects zero amount', async () => {
    await expect(
      walletService.walletService.deductCredits('user-1', 0),
    ).rejects.toThrow('Deduction amount must be positive');
  });

  it('deductCredits checks balance before deducting', async () => {
    // Wallet has 0 balance, can't deduct 100
    await expect(
      walletService.walletService.deductCredits('user-1', 100),
    ).rejects.toThrow('Insufficient credits');
  });
});

// ── Server health check ───────────────────────────────────────

describe('Server', () => {
  it('createServer returns an Express app', async () => {
    const { createServer } = await import('../src/server.js');
    const app = await createServer();
    expect(app).toBeDefined();
    expect(typeof app.listen).toBe('function');
  });
});
