import Decimal from 'decimal.js';
import type { Classification, SpendingAnalysis, SpendingSummary, Statement, Upload } from '@statement/shared';

export function spendingAnalysis(statement: Statement, classifications: Classification[], upload: Upload): SpendingAnalysis {
  const issues: string[] = [];
  const groups = new Map<string, {
    total: Decimal; count: number; partial: boolean; refunds: Decimal;
    categories: Map<string, { total: Decimal; count: number }>;
    months: Map<string, { total: Decimal; count: number }>;
    excluded: Map<Classification['kind'], { total: Decimal; count: number }>;
  }>();
  const byId = new Map(classifications.map(c => [c.transactionId, c]));
  let excludedTransactionCount = 0, unattributedExclusions = false;
  const reviewIds = new Set<string>();
  function group(currency: string) {
    let existing = groups.get(currency);
    if (!existing) {
      existing = { total: new Decimal(0), count: 0, partial: false, refunds: new Decimal(0), categories: new Map(), months: new Map(), excluded: new Map() };
      groups.set(currency, existing);
    }
    return existing;
  }
  statement.transactions.forEach((t, i) => {
    const id = `tx-${i + 1}`, c = byId.get(id);
    const g = t.currency ? group(t.currency) : null;
    const accounts = statement.accounts.filter(a => a.id === t.accountId);
    const invalidSource = !statement.isBankStatement || !g || accounts.length !== 1 || accounts[0].currency !== t.currency || t.needsReview || t.sourcePage > upload.pageCount;
    const debit = t.moneyOut === null ? null : new Decimal(t.moneyOut);
    const credit = t.moneyIn === null ? null : new Decimal(t.moneyIn);
    const invalidAmounts = debit === null || credit === null || debit.isNegative() || credit.isNegative() || (debit.gt(0) && credit.gt(0));
    const uncertain = !c || c.kind === 'unknown' || c.needsReview || c.confidence === 'low';
    const invalidDirection = c && ((c.kind === 'expense' || c.kind === 'cash_withdrawal' || c.kind === 'debt_payment') && !debit?.gt(0)
      || (c.kind === 'income' || c.kind === 'refund') && !credit?.gt(0));
    if (invalidSource || invalidAmounts || uncertain || invalidDirection) {
      excludedTransactionCount++; reviewIds.add(id);
      if (!g) unattributedExclusions = true;
      if (g) g.partial = true;
      issues.push(`${id}: excluded from spending totals until its source, amounts or classification are reviewed.`);
      if (g && debit !== null && !debit.isNegative() && credit !== null && credit.isZero()) {
        const unknown = g.excluded.get('unknown') || { total: new Decimal(0), count: 0 };
        unknown.total = unknown.total.plus(debit); unknown.count++; g.excluded.set('unknown', unknown);
      }
      return;
    }
    if (c.kind !== 'expense') {
      excludedTransactionCount++;
      const row = g!.excluded.get(c.kind) || { total: new Decimal(0), count: 0 };
      row.total = row.total.plus(debit!); row.count++; g!.excluded.set(c.kind, row);
      if (c.kind === 'refund') g!.refunds = g!.refunds.plus(credit!);
      return;
    }
    g!.total = g!.total.plus(debit!); g!.count++;
    const category = c.category || 'uncategorized';
    const row = g!.categories.get(category) || { total: new Decimal(0), count: 0 };
    row.total = row.total.plus(debit!); row.count++; g!.categories.set(category, row);
    if (category === 'uncategorized') { reviewIds.add(id); issues.push(`${id}: included in spending, but needs a category.`); }
    const date = t.date ? new Date(t.date) : null;
    const validDate = date && !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === t.date;
    const month = validDate ? t.date!.slice(0, 7) : 'undated';
    const monthly = g!.months.get(month) || { total: new Decimal(0), count: 0 };
    monthly.total = monthly.total.plus(debit!); monthly.count++; g!.months.set(month, monthly);
    if (!validDate) { reviewIds.add(id); issues.push(`${id}: included in spending, but excluded from dated monthly buckets.`); }
  });
  if (statement.warnings.length || !statement.isBankStatement) {
    for (const g of groups.values()) g.partial = true;
    issues.push('Extraction has warnings; spending figures may be incomplete.');
  }
  if (unattributedExclusions) for (const g of groups.values()) g.partial = true;
  const summaries: SpendingSummary[] = [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([currency, g]) => ({
    currency, totalSpending: g.total.toString(), expenseCount: g.count, partial: g.partial, refunds: g.refunds.toString(),
    categories: [...g.categories.entries()].sort(([, a], [, b]) => b.total.comparedTo(a.total)).map(([category, row]) => ({ category: category as SpendingSummary['categories'][number]['category'], total: row.total.toString(), count: row.count, percentage: g.total.isZero() ? '0' : row.total.div(g.total).times(100).toFixed(1) })),
    months: [...g.months.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([month, row]) => ({ month, total: row.total.toString(), count: row.count })),
    excluded: [...g.excluded.entries()].map(([kind, row]) => ({ kind, totalOut: row.total.toString(), count: row.count }))
  }));
  return { summaries, excludedTransactionCount, reviewCount: reviewIds.size, issues };
}
