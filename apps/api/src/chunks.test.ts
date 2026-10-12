import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { PDFDocument } from 'pdf-lib';
import type { ParseProgress, Statement } from '@statement/shared';
import { parsePdfChunks, mergeChunks, chunkPageSize } from './chunks.js';
import type { ChunkContext } from './extract.js';

function batch(page: number, id = 'local-account'): Statement {
  return { isBankStatement: true, bankName: 'Test bank', accountHolder: null, periodStart: '2026-10-01', periodEnd: '2026-10-31', extraFields: [], warnings: [],
    accounts: [{ id, lastFour: '1234', currency: 'EGP', accountType: 'Current', openingBalance: page === 1 ? '100' : null, closingBalance: page === 5 ? '60' : null, extraFields: [] }],
    transactions: [{ accountId: id, date: `2026-10-0${page}`, valueDate: null, description: 'Repeated merchant', currency: 'EGP', moneyIn: '0', moneyOut: '10', balance: null, reference: null, sourcePage: page, needsReview: false, extraFields: [] }]
  };
}
async function temporaryRoot() { return mkdtemp(path.join(os.tmpdir(), 'statement-chunks-')); }
async function cleanup(root: string) {
  assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
  assert.ok(path.basename(root).startsWith('statement-chunks-'));
  await rm(root, { recursive: true, force: true });
}
test('page batches preserve original page numbers, include adjacent context, merge accounts and retain legitimate identical charges', async () => {
  const root = await temporaryRoot();
  try {
    const pdf = await PDFDocument.create(); for (let p = 0; p < 5; p++) pdf.addPage();
    const bytes = Buffer.from(await pdf.save());
    const markdown = Array.from({ length: 5 }, (_, i) => `## Page ${i + 1}\n\nUnique text ${i + 1}\nSecond line ${i + 1}`).join('\n\n');
    const seen: number[] = [], progress: ParseProgress[] = [];
    const extractor = async (text: string, buffer: Buffer, context?: ChunkContext) => {
      assert.ok(context); seen.push(context.startPage);
      const expected = context.startPage === 1 ? [1, 2, 3] : context.startPage === 3 ? [2, 3, 4, 5] : [4, 5];
      assert.deepEqual(context.pdfPages, expected);
      assert.equal((await PDFDocument.load(buffer)).getPageCount(), expected.length);
      for (const p of expected) { assert.match(text, new RegExp(`Unique text ${p}`)); assert.match(text, new RegExp(`Second line ${p}`)); }
      if (context.startPage > 1) assert.equal(context.knownAccounts[0].id, 'account-first');
      const result = batch(context.startPage, context.startPage === 1 ? 'account-first' : 'new-local-id');
      if (context.startPage === 1) result.transactions.push({ ...result.transactions[0] });
      return result;
    };
    const result = await parsePdfChunks(bytes, markdown, root, extractor, async p => { progress.push(p); }, 2);
    assert.deepEqual(seen, [1, 3, 5]); assert.equal(result.accounts.length, 1);
    assert.equal(result.accounts[0].openingBalance, '100'); assert.equal(result.accounts[0].closingBalance, '60');
    assert.deepEqual(result.transactions.map(t => t.sourcePage), [1, 1, 3, 5]);
    assert.ok(result.transactions.every(t => t.accountId === 'account-first'));
    assert.equal(progress.at(-1)?.completedChunks, 3);
    await parsePdfChunks(bytes, markdown, root, async () => { throw new Error('Should reuse cached batches'); }, undefined, 2);
  } finally { await cleanup(root); }
});
test('failure publishes no completed source JSON and retry skips successful page batches', async () => {
  const root = await temporaryRoot();
  try {
    const pdf = await PDFDocument.create(); for (let p = 0; p < 4; p++) pdf.addPage();
    const bytes = Buffer.from(await pdf.save()), calls: number[] = [];
    let fail = true;
    const extractor = async (_text: string, _pdf: Buffer, context?: ChunkContext) => {
      assert.ok(context); calls.push(context.startPage);
      if (context.startPage === 3 && fail) throw new DOMException('Deadline', 'TimeoutError');
      return batch(context.startPage);
    };
    await assert.rejects(parsePdfChunks(bytes, '## Page 1\nText', root, extractor, undefined, 2), /Completed batches are saved/);
    await assert.rejects(readFile(path.join(root, 'statement.json')));
    fail = false;
    const result = await parsePdfChunks(bytes, '## Page 1\nText', root, extractor, undefined, 2);
    assert.deepEqual(calls, [1, 3, 3]); assert.deepEqual(result.transactions.map(t => t.sourcePage), [1, 3]);
  } finally { await cleanup(root); }
});
test('conflicting account identities stay separate and ambiguous balances produce review warnings', () => {
  const first = batch(1), different = batch(3);
  different.accounts[0].lastFour = '9999';
  const separated = mergeChunks([first, different]);
  assert.equal(separated.accounts.length, 2); assert.notEqual(separated.transactions[0].accountId, separated.transactions[1].accountId);
  const conflict = batch(3); conflict.accounts[0].openingBalance = '200';
  const merged = mergeChunks([first, conflict]);
  assert.equal(merged.accounts[0].openingBalance, '100'); assert.ok(merged.warnings.some(w => w.includes('conflicting openingBalance')));
  assert.throws(() => chunkPageSize('0')); assert.throws(() => chunkPageSize('8')); assert.throws(() => chunkPageSize('abc'));
});
test('rows from context pages are rejected rather than duplicated in the merged result', async () => {
  const root = await temporaryRoot();
  try {
    const pdf = await PDFDocument.create(); for (let p = 0; p < 4; p++) pdf.addPage();
    await assert.rejects(parsePdfChunks(Buffer.from(await pdf.save()), '', root, async (_text, _pdf, context) => {
      assert.ok(context); return batch(context.startPage === 1 ? 1 : 2);
    }, undefined, 2), error => error instanceof Error && error.cause instanceof Error && error.cause.message.includes('outside its owned page range'));
  } finally { await cleanup(root); }
});
