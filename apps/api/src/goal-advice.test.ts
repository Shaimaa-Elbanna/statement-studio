import test from 'node:test';
import assert from 'node:assert/strict';
import { goalRequestSchema, type Analysis } from '@statement/shared';
import { goalContext } from './goal-advice.js';

test('goal input rejects empty and oversized goals and trims whitespace', () => {
  assert.equal(goalRequestSchema.safeParse({ goal: '  ' }).success, false);
  assert.equal(goalRequestSchema.safeParse({ goal: 'x'.repeat(2001) }).success, false);
  assert.equal(goalRequestSchema.parse({ goal: '  Save for a home  ' }).goal, 'Save for a home');
});

test('goal context contains spending and uncertainty without identity or raw transactions', () => {
  const analysis = {
    statement: { periodStart: '2026-01-01', periodEnd: '2026-01-31', accountHolder: 'Private name', transactions: [{ description: 'Private merchant' }], warnings: ['Missing rows'] },
    summaries: [{ currency: 'EGP', partial: true }],
    spending: { summaries: [{ currency: 'EGP', totalSpending: '123.45' }], issues: ['Excluded uncertain entries'] },
    issues: ['Balance unavailable']
  } as unknown as Analysis;
  const context = goalContext(analysis);
  assert.deepEqual(context.spending, analysis.spending);
  assert.deepEqual(context.dataIssues, ['Balance unavailable', 'Missing rows']);
  assert.equal(JSON.stringify(context).includes('Private'), false);
  assert.equal(context.accountSummaries[0].partial, true);
});
