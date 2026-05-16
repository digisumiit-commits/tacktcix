import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { ResourceType } from '@prisma/client';
import { requireAuth } from '../middleware/auth.js';
import { AuthenticatedRequest } from '../types/index.js';
import { billingService } from '../services/billing.service.js';
import { walletService } from '../services/wallet.service.js';
import { usageService } from '../services/usage.service.js';
import { analyticsService } from '../services/analytics.service.js';

export const billingRouter = Router();

function asyncHandler(fn: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response, next: NextFunction) => fn(req, res).catch(next);
}

function userId(req: Request): string {
  return (req as AuthenticatedRequest).userId!;
}

// ── Plans ──────────────────────────────────────────────────────

billingRouter.get('/plans', asyncHandler(async (_req, res) => {
  const plans = await billingService.getPlans();
  res.json(plans);
}));

billingRouter.get('/plans/:planId', asyncHandler(async (req, res) => {
  const plan = await billingService.getPlan(req.params.planId);
  if (!plan) { res.status(404).json({ error: 'Plan not found' }); return; }
  res.json(plan);
}));

billingRouter.post('/plans', asyncHandler(async (req, res) => {
  const schema = z.object({
    name: z.string().min(1),
    description: z.string().optional(),
    interval: z.enum(['MONTHLY', 'YEARLY']).optional(),
    basePriceCents: z.number().min(0).optional(),
    includedCredits: z.number().min(0).optional(),
    isPublic: z.boolean().optional(),
  });
  const plan = await billingService.createPlan(schema.parse(req.body));
  res.status(201).json(plan);
}));

// ── Subscription ───────────────────────────────────────────────

billingRouter.get('/subscription', requireAuth, asyncHandler(async (req, res) => {
  const sub = await billingService.getSubscription(userId(req));
  if (!sub) { res.status(404).json({ error: 'No subscription found' }); return; }
  res.json(sub);
}));

billingRouter.post('/subscription', requireAuth, asyncHandler(async (req, res) => {
  const schema = z.object({
    planId: z.string().uuid(),
    autoRecharge: z.object({
      enabled: z.boolean(),
      amountCents: z.number().min(0),
      thresholdCredits: z.number().min(0),
    }).optional(),
  });
  const data = schema.parse(req.body);
  const sub = await billingService.createOrUpdateSubscription(userId(req), data.planId, data.autoRecharge);
  res.json(sub);
}));

billingRouter.post('/subscription/cancel', requireAuth, asyncHandler(async (req, res) => {
  const sub = await billingService.cancelSubscription(userId(req));
  res.json(sub);
}));

// ── Auto-recharge ──────────────────────────────────────────────

billingRouter.get('/auto-recharge', requireAuth, asyncHandler(async (req, res) => {
  const config = await billingService.getAutoRechargeConfig(userId(req));
  res.json(config ?? { enabled: false, rechargeAmountCredits: 1000, thresholdCredits: 100 });
}));

billingRouter.put('/auto-recharge', requireAuth, asyncHandler(async (req, res) => {
  const schema = z.object({
    enabled: z.boolean(),
    rechargeAmountCredits: z.number().int().min(100),
    thresholdCredits: z.number().int().min(0),
  });
  const data = schema.parse(req.body);
  const config = await billingService.setAutoRecharge(
    userId(req), data.enabled, data.rechargeAmountCredits, data.thresholdCredits,
  );
  res.json(config);
}));

// ── Wallet ─────────────────────────────────────────────────────

billingRouter.get('/wallet', requireAuth, asyncHandler(async (req, res) => {
  const wallet = await walletService.getOrCreateWallet(userId(req));
  res.json(wallet);
}));

billingRouter.get('/wallet/transactions', requireAuth, asyncHandler(async (req, res) => {
  const wallet = await walletService.getOrCreateWallet(userId(req));
  const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);
  const offset = parseInt(req.query.offset as string) || 0;
  const transactions = await walletService.getTransactions(wallet.id, limit, offset);
  res.json(transactions);
}));

billingRouter.post('/wallet/add-credits', requireAuth, asyncHandler(async (req, res) => {
  const schema = z.object({
    amount: z.number().int().positive(),
    description: z.string().optional(),
    idempotencyKey: z.string().optional(),
  });
  const data = schema.parse(req.body);
  const wallet = await walletService.addCredits(
    userId(req), data.amount, 'CREDIT_PURCHASE', data.description, data.idempotencyKey,
  );
  res.json(wallet);
}));

// ── Usage ──────────────────────────────────────────────────────

billingRouter.get('/usage', requireAuth, asyncHandler(async (req, res) => {
  const days = parseInt(req.query.days as string) || 30;
  const records = await usageService.getDailyUsage(userId(req), days);
  res.json(records);
}));

billingRouter.get('/usage/summary', requireAuth, asyncHandler(async (req, res) => {
  const since = req.query.since ? new Date(req.query.since as string) : undefined;
  const summary = await usageService.getUsageSummary(userId(req), since);
  res.json(summary);
}));

const RESOURCE_TYPES = ['TOKENS', 'BROWSER_RUNTIME', 'STORAGE', 'VECTOR_DB', 'EXECUTION_TIME', 'DEPLOYMENT'] as const;

billingRouter.get('/usage/:resource', requireAuth, asyncHandler(async (req, res) => {
  const resource = req.params.resource as ResourceType;
  if (!(RESOURCE_TYPES as readonly string[]).includes(resource)) {
    res.status(400).json({ error: 'Invalid resource type' });
    return;
  }
  const since = req.query.since ? new Date(req.query.since as string) : undefined;
  const records = await usageService.getUsageByResource(userId(req), resource, since);
  res.json(records);
}));

billingRouter.post('/usage/record', requireAuth, asyncHandler(async (req, res) => {
  const schema = z.object({
    resource: z.enum(RESOURCE_TYPES),
    amount: z.number().positive(),
    unit: z.string(),
    description: z.string().optional(),
    idempotencyKey: z.string().optional(),
  });
  const data = schema.parse(req.body);
  const record = await usageService.recordUsage({ userId: userId(req), ...data });
  res.status(201).json(record);
}));

// ── Invoices ───────────────────────────────────────────────────

billingRouter.get('/invoices', requireAuth, asyncHandler(async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit as string) || 20, 100);
  const offset = parseInt(req.query.offset as string) || 0;
  const invoices = await billingService.getInvoices(userId(req), limit, offset);
  res.json(invoices);
}));

billingRouter.get('/invoices/:invoiceId', requireAuth, asyncHandler(async (req, res) => {
  const invoice = await billingService.getInvoice(req.params.invoiceId);
  if (!invoice) { res.status(404).json({ error: 'Invoice not found' }); return; }
  res.json(invoice);
}));

billingRouter.post('/invoices/generate', requireAuth, asyncHandler(async (req, res) => {
  const schema = z.object({
    periodStart: z.string().datetime(),
    periodEnd: z.string().datetime(),
  });
  const data = schema.parse(req.body);
  const invoice = await billingService.generateInvoice(
    userId(req), new Date(data.periodStart), new Date(data.periodEnd),
  );
  res.status(201).json(invoice);
}));

billingRouter.post('/invoices/:invoiceId/pay', requireAuth, asyncHandler(async (req, res) => {
  const invoice = await billingService.markInvoicePaid(req.params.invoiceId);
  res.json(invoice);
}));

// ── Analytics ──────────────────────────────────────────────────

billingRouter.get('/analytics/dashboard', requireAuth, asyncHandler(async (req, res) => {
  const dashboard = await analyticsService.getDashboard(userId(req));
  res.json(dashboard);
}));

billingRouter.get('/analytics/resource/:resource', requireAuth, asyncHandler(async (req, res) => {
  const resource = req.params.resource as ResourceType;
  if (!(RESOURCE_TYPES as readonly string[]).includes(resource)) {
    res.status(400).json({ error: 'Invalid resource type' });
    return;
  }
  const days = parseInt(req.query.days as string) || 30;
  const analytics = await analyticsService.getResourceAnalytics(userId(req), resource, days);
  res.json(analytics);
}));

billingRouter.get('/analytics/spending-trend', requireAuth, asyncHandler(async (req, res) => {
  const days = parseInt(req.query.days as string) || 90;
  const trend = await analyticsService.getSpendingTrend(userId(req), days);
  res.json(trend);
}));
