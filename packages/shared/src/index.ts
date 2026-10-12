import { z } from 'zod';

// Nullable standard fields + extensible key/value lists work with strict model output schemas.
const amount = z.string().regex(/^-?\d+(\.\d+)?$/).nullable().describe('Decimal string without grouping separators, or null if unknown.');
const extras = z.array(z.object({ label: z.string(), value: z.string() })).describe('Additional bank-specific fields not represented by standard fields.');
export const statementSchema = z.object({
  isBankStatement: z.boolean(), bankName: z.string().nullable(), accountHolder: z.string().nullable(),
  periodStart: z.string().nullable(), periodEnd: z.string().nullable(), extraFields: extras,
  accounts: z.array(z.object({
    id: z.string().describe('Unique internal identifier, e.g. account-1. No full account numbers.'),
    lastFour: z.string().nullable(), accountType: z.string().nullable(),
    currency: z.string().nullable(), openingBalance: amount, closingBalance: amount, extraFields: extras
  })),
  transactions: z.array(z.object({
    accountId: z.string().nullable(), date: z.string().nullable(), valueDate: z.string().nullable(),
    description: z.string(), currency: z.string().nullable(), moneyIn: amount, moneyOut: amount,
    balance: amount, reference: z.string().nullable(), sourcePage: z.number().int().positive(),
    needsReview: z.boolean(), extraFields: extras
  })),
  warnings: z.array(z.string())
});
export type Statement = z.infer<typeof statementSchema>;
export type Upload = { id: string; filename: string; pageCount: number; textCharacters: number; scannedPages: number[] };
export type ParsedStatement = { upload: Upload; statement: Statement };
export type ParseProgress = {
  state: 'idle' | 'parsing' | 'completed' | 'failed';
  completedChunks: number; totalChunks: number;
  currentPages: { start: number; end: number } | null;
  error: string | null; code: string | null; updatedAt: string;
};
export const spendingCategories = ['groceries', 'dining', 'transport', 'housing', 'utilities', 'health', 'shopping', 'entertainment', 'travel', 'education', 'insurance', 'fees', 'other'] as const;
export const transactionKinds = ['expense', 'income', 'refund', 'transfer', 'cash_withdrawal', 'debt_payment', 'unknown'] as const;
export const categoryLabels: Record<typeof spendingCategories[number], string> = {
  groceries: 'Groceries', dining: 'Dining & coffee', transport: 'Transport', housing: 'Housing', utilities: 'Bills & utilities',
  health: 'Health', shopping: 'Shopping', entertainment: 'Entertainment', travel: 'Travel', education: 'Education', insurance: 'Insurance', fees: 'Bank fees', other: 'Other'
};
export const kindLabels: Record<typeof transactionKinds[number], string> = {
  expense: 'Spending', income: 'Income', refund: 'Refund', transfer: 'Transfer', cash_withdrawal: 'Cash withdrawal', debt_payment: 'Debt repayment', unknown: 'Unknown'
};
export const classificationSchema = z.object({
  transactionId: z.string(), kind: z.enum(transactionKinds), category: z.enum(spendingCategories).nullable(),
  confidence: z.enum(['high', 'medium', 'low']), needsReview: z.boolean(), reason: z.string()
});
export const classificationsSchema = z.object({ transactions: z.array(classificationSchema) });
export const categoryUpdateSchema = classificationSchema.pick({ kind: true, category: true });
export type Classification = z.infer<typeof classificationSchema> & { source: 'ai' | 'user' | 'unavailable' };
export type SpendingSummary = {
  currency: string; totalSpending: string; expenseCount: number; partial: boolean;
  categories: { category: typeof spendingCategories[number] | 'uncategorized'; total: string; count: number; percentage: string }[];
  months: { month: string; total: string; count: number }[];
  excluded: { kind: typeof transactionKinds[number]; totalOut: string; count: number }[];
  refunds: string;
};
export type SpendingAnalysis = { summaries: SpendingSummary[]; excludedTransactionCount: number; reviewCount: number; issues: string[] };
export type Analysis = {
  upload: Upload; statement: Statement;
  summaries: { accountId: string; currency: string | null; totalIn: string; totalOut: string; net: string; count: number; partial: boolean; reconciliation: 'passed' | 'review' | 'unavailable'; difference: string | null }[];
  issues: string[];
  classifications: Classification[];
  spending: SpendingAnalysis;
};
export const goalRequestSchema = z.object({ goal: z.string().trim().min(3).max(2000) }).strict();
export const goalAdviceSchema = z.object({
  summary: z.string(),
  feasibility: z.string().describe('Explain what can and cannot be established from this statement and the goal.'),
  actions: z.array(z.object({ title: z.string(), recommendation: z.string(), evidence: z.string() })),
  assumptions: z.array(z.string()),
  questions: z.array(z.string())
});
export type GoalAdvice = z.infer<typeof goalAdviceSchema>;
