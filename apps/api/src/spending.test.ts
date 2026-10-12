import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Classification, Statement, Upload } from '@statement/shared';
import { spendingAnalysis } from './spending.js';
import { validateClassifications } from './categorize.js';

const upload: Upload = { id: '', filename: '', pageCount: 2, textCharacters: 0, scannedPages: [] };
const statement: Statement = {
  isBankStatement: true, bankName: null, accountHolder: null, periodStart: null, periodEnd: null, extraFields: [], warnings: [],
  accounts: ['EGP', 'USD'].map(currency => ({ id: currency, currency, lastFour: null, accountType: null, openingBalance: null, closingBalance: null, extraFields: [] })),
  transactions: []
};
function fixture(rows: { debit: string | null; credit?: string; currency?: string | null; kind: Classification['kind']; category?: Classification['category']; date?: string | null; low?: boolean; sourceReview?: boolean }[]) {
  const data: Statement = { ...statement, transactions: rows.map(r => ({ accountId: r.currency === 'USD' ? 'USD' : 'EGP', currency: r.currency === undefined ? 'EGP' : r.currency, date: r.date === undefined ? '2026-10-01' : r.date, valueDate: null, description: 'Test', moneyIn: r.credit || '0', moneyOut: r.debit, balance: null, reference: null, sourcePage: 1, needsReview: Boolean(r.sourceReview), extraFields: [] })) };
  const classifications: Classification[] = rows.map((r, i) => ({ transactionId: `tx-${i + 1}`, kind: r.kind, category: r.category || null, confidence: r.low ? 'low' : 'high', needsReview: Boolean(r.low), reason: 'Test evidence', source: 'ai' }));
  return { data, classifications };
}
test('spending excludes transfers, cash, debt and refunds; amounts stay exact and currencies separate', () => {
  const { data, classifications } = fixture([
    { debit: '0.1', kind: 'expense', category: 'groceries' },
    { debit: '0.2', kind: 'expense', category: 'groceries' },
    { debit: '5', kind: 'expense', currency: 'USD', category: 'dining', date: '2026-09-01' },
    { debit: '100', kind: 'transfer' }, { debit: '200', kind: 'cash_withdrawal' }, { debit: '300', kind: 'debt_payment' },
    { debit: '0', credit: '1', kind: 'refund' }, { debit: '0', credit: '500', kind: 'income' }
  ]);
  const result = spendingAnalysis(data, classifications, upload);
  const egp = result.summaries.find(s => s.currency === 'EGP')!;
  assert.equal(egp.totalSpending, '0.3'); assert.equal(egp.categories[0].total, '0.3'); assert.equal(egp.categories[0].percentage, '100.0');
  assert.equal(egp.refunds, '1'); assert.equal(egp.months[0].month, '2026-10'); assert.equal(egp.months[0].total, '0.3');
  assert.equal(result.summaries.find(s => s.currency === 'USD')!.totalSpending, '5');
  assert.equal(result.excludedTransactionCount, 5); assert.equal(egp.partial, false);
});
test('unknown classification, unreadable amounts, low confidence and source review are excluded, not guessed', () => {
  const { data, classifications } = fixture([
    { debit: '2', kind: 'expense', category: 'shopping' },
    { debit: '10', kind: 'unknown' }, { debit: null, kind: 'expense', category: 'housing' },
    { debit: '20', kind: 'expense', category: 'groceries', low: true }, { debit: '30', kind: 'expense', sourceReview: true },
    { debit: '40', kind: 'expense', currency: null }, { debit: '5', credit: '5', kind: 'expense' }
  ]);
  const result = spendingAnalysis(data, classifications, upload);
  assert.equal(result.summaries[0].totalSpending, '2'); assert.equal(result.summaries[0].partial, true);
  assert.equal(result.reviewCount, 6); assert.equal(result.excludedTransactionCount, 6);
});
test('clear expenses without category or date stay visible as uncategorized and undated', () => {
  const { data, classifications } = fixture([{ debit: '7.25', kind: 'expense', date: '2026-02-30' }]);
  const result = spendingAnalysis(data, classifications, upload);
  assert.equal(result.summaries[0].categories[0].category, 'uncategorized');
  assert.equal(result.summaries[0].months[0].month, 'undated');
  assert.equal(result.summaries[0].totalSpending, '7.25');
  assert.equal(result.reviewCount, 1);
});
test('classification IDs must cover the input exactly once, independent of output order', () => {
  const { data, classifications } = fixture([{ debit: '1', kind: 'expense' }, { debit: '2', kind: 'expense' }]);
  assert.equal(validateClassifications(data, [...classifications].reverse())[0].transactionId, 'tx-1');
  assert.throws(() => validateClassifications(data, [classifications[0]]));
  assert.throws(() => validateClassifications(data, [classifications[0], classifications[0]]));
  assert.throws(() => validateClassifications(data, [{ ...classifications[0], transactionId: 'invented' }, classifications[1]]));
});
