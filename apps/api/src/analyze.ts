import Decimal from 'decimal.js';
import type { Analysis, Classification, Statement, Upload } from '@statement/shared';
import { unknownClassifications, validateClassifications } from './categorize.js';
import { spendingAnalysis } from './spending.js';

function validDate(value: string | null) {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(value);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}
export function analyze(statement: Statement, upload: Upload, input: Classification[] = unknownClassifications(statement)): Analysis {
  const classifications = validateClassifications(statement, input);
  const issues = [...statement.warnings];
  if (!statement.isBankStatement) issues.push('This document was not identified as a bank statement.');
  if (!statement.transactions.length) issues.push('No transactions extracted.');
  const ids = statement.accounts.map(a => a.id);
  if (new Set(ids).size !== ids.length) issues.push('Duplicate account identifiers; summaries require review.');
  statement.transactions.forEach((t, i) => {
    if (!t.accountId || !ids.includes(t.accountId)) issues.push(`Transaction ${i + 1}: account is unknown; excluded from account totals.`);
    if (!validDate(t.date) || t.needsReview) issues.push(`Transaction ${i + 1}: review the date or source entry.`);
    if (t.sourcePage > upload.pageCount) issues.push(`Transaction ${i + 1}: invalid source page.`);
  });
  const summaries = statement.accounts.map(account => {
    let incoming = new Decimal(0), outgoing = new Decimal(0), partial = false;
    let previous = account.openingBalance === null ? null : new Decimal(account.openingBalance);
    const txns = statement.transactions.filter(t => t.accountId === account.id);
    let runningMismatch = false;
    if (!account.currency) { issues.push(`${account.id}: currency is unknown.`); partial = true; }
    txns.forEach(t => {
      if (t.currency !== account.currency || t.moneyIn === null || t.moneyOut === null) {
        partial = true; previous = null;
        issues.push(`${account.id}: unknown amount or mismatched currency; totals are partial.`); return;
      }
      const credit = new Decimal(t.moneyIn), debit = new Decimal(t.moneyOut);
      if (credit.isNegative() || debit.isNegative() || (credit.gt(0) && debit.gt(0))) {
        partial = true; previous = null; issues.push(`${account.id}: ambiguous debit/credit; totals are partial.`); return;
      }
      incoming = incoming.plus(credit); outgoing = outgoing.plus(debit);
      if (previous !== null && t.balance !== null && !previous.plus(credit).minus(debit).eq(t.balance)) runningMismatch = true;
      previous = t.balance === null ? null : new Decimal(t.balance);
    });
    if (runningMismatch) issues.push(`${account.id}: running balances do not match transactions.`);
    const difference = !partial && account.openingBalance !== null && account.closingBalance !== null
      ? new Decimal(account.openingBalance).plus(incoming).minus(outgoing).minus(account.closingBalance).toString() : null;
    if (difference !== null && !new Decimal(difference).isZero()) issues.push(`${account.id}: calculated closing balance differs by ${difference}.`);
    const review = partial || runningMismatch || !statement.isBankStatement || !txns.length || statement.transactions.some(t => !t.accountId || !ids.includes(t.accountId)) || txns.some(t => t.needsReview || !validDate(t.date) || t.sourcePage > upload.pageCount) || new Set(ids).size !== ids.length || statement.warnings.length > 0;
    return { accountId: account.id, currency: account.currency, totalIn: incoming.toString(), totalOut: outgoing.toString(), net: incoming.minus(outgoing).toString(), count: txns.length, partial, difference,
      reconciliation: review || (difference !== null && !new Decimal(difference).isZero()) ? 'review' as const : difference === null ? 'unavailable' as const : 'passed' as const };
  });
  return { upload, statement, summaries, issues: [...new Set(issues)], classifications, spending: spendingAnalysis(statement, classifications, upload) };
}
