import { ResourceType } from '@prisma/client';

export interface Pricing {
  resource: ResourceType;
  unit: string;
  creditsPerUnit: number;
  description: string;
}

export const DEFAULT_PRICING: Pricing[] = [
  { resource: 'TOKENS', unit: '1K tokens', creditsPerUnit: 1, description: 'Per 1,000 tokens (input + output)' },
  { resource: 'BROWSER_RUNTIME', unit: 'minute', creditsPerUnit: 5, description: 'Per minute of browser runtime' },
  { resource: 'STORAGE', unit: 'GB-month', creditsPerUnit: 10, description: 'Per GB of storage per month' },
  { resource: 'VECTOR_DB', unit: '1K vectors', creditsPerUnit: 2, description: 'Per 1,000 vector embeddings stored' },
  { resource: 'EXECUTION_TIME', unit: 'minute', creditsPerUnit: 3, description: 'Per minute of execution time' },
  { resource: 'DEPLOYMENT', unit: 'deployment', creditsPerUnit: 50, description: 'Per deployment' },
];

export function getPricingForResource(resource: ResourceType): Pricing | undefined {
  return DEFAULT_PRICING.find(p => p.resource === resource);
}

export function calculateCredits(resource: ResourceType, amount: number): number {
  const pricing = getPricingForResource(resource);
  if (!pricing) return 0;
  return Math.ceil(amount * pricing.creditsPerUnit);
}
