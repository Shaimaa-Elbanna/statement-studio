import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rename, rm, access } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { createApp } from './app.js';
import { analyze } from './analyze.js';
import { statementSchema, type Statement, type Upload } from '@statement/shared';
import { unknownClassifications } from './categorize.js';
import { setTimeout } from 'node:timers/promises';

const statement: Statement = {
  isBankStatement: true, bankName: 'Test bank', accountHolder: null, periodStart: null, periodEnd: null, extraFields: [], warnings: [],
  accounts: [{ id: 'a', lastFour: null, accountType: null, currency: 'EGP', openingBalance: '0.1', closingBalance: '0.3', extraFields: [] }],
  transactions: [{ accountId: 'a', date: '2026-10-01', valueDate: null, description: 'Deposit', currency: 'EGP', moneyIn: '0.2', moneyOut: '0', balance: '0.3', reference: null, sourcePage: 1, needsReview: false, extraFields: [] }]
};
const upload: Upload = { id: '', filename: '', pageCount: 1, textCharacters: 0, scannedPages: [] };
test('exact decimals reconcile; unknown values and currencies never produce a passed check', () => {
  assert.equal(analyze(statement, upload).summaries[0].reconciliation, 'passed');
  assert.equal(analyze(statement, upload).summaries[0].net, '0.2');
  for (const changed of [{ moneyIn: null }, { currency: 'USD' }, { moneyOut: '-1' }, { date: '2026-02-30' }, { sourcePage: 2 }]) {
    const result = analyze({ ...statement, transactions: [{ ...statement.transactions[0], ...changed }] }, upload);
    assert.equal(result.summaries[0].reconciliation, 'review');
  }
  assert.throws(() => statementSchema.parse({ ...statement, accounts: [{ ...statement.accounts[0], openingBalance: 'garbage' }] }));
});
test('PDF parsing and JSON analysis are separate; JSON analysis never needs the PDF or Markdown', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'statement-test-'));
  let parseCalls = 0, categoryCalls = 0;
  let categoryFailure = false;
  const extractedStatement: Statement = { ...statement,
    accounts: [{ ...statement.accounts[0], openingBalance: '0.3', closingBalance: '0.1' }],
    transactions: [{ ...statement.transactions[0], description: 'Unclear merchant', moneyIn: '0', moneyOut: '0.2', balance: '0.1' }]
  };
  const app = createApp({ storageRoot: root, extractor: async (markdown, pdf) => {
    assert.match(markdown, /Page 1/); assert.match(markdown, /Test bank/); assert.equal(pdf.subarray(0, 5).toString(), '%PDF-'); parseCalls++; return extractedStatement;
  }, categorizer: async (extracted) => {
    categoryCalls++;
    const dirs = await import('node:fs/promises').then(fs => fs.readdir(root));
    assert.deepEqual(JSON.parse(await readFile(path.join(root, dirs[0], 'statement.json'), 'utf8')), extractedStatement);
    if (categoryFailure) throw new Error('Provider unavailable');
    return unknownClassifications(extracted);
  } });
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const pdf = await PDFDocument.create();
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    pdf.addPage().drawText('Test bank statement deposit 0.2 EGP', { x: 40, y: 700, font, size: 12 });
    const bytes = await pdf.save();
    const form = new FormData(); form.append('statement', new Blob([new Uint8Array(bytes)], { type: 'application/pdf' }), 'test.pdf');
    const response = await fetch(`${base}/api/uploads`, { method: 'POST', body: form });
    assert.equal(response.status, 201);
    const saved = await response.json() as Upload;
    assert.equal(saved.pageCount, 1);
    assert.match(await readFile(path.join(root, saved.id, 'statement.md'), 'utf8'), /Test bank/);
    assert.deepEqual(await readFile(path.join(root, saved.id, 'statement.pdf')), Buffer.from(bytes));
    assert.equal((await fetch(`${base}/api/uploads/${saved.id}/analyze`, { method: 'POST' })).status, 409);
    assert.equal(parseCalls, 0); assert.equal(categoryCalls, 0);
    const parsedResponse = await fetch(`${base}/api/uploads/${saved.id}/parse`, { method: 'POST' });
    assert.equal(parsedResponse.status, 202);
    assert.equal((await parsedResponse.json()).state, 'parsing');
    let state = 'parsing';
    for (let poll = 0; state === 'parsing' && poll < 250; poll++) {
      const status = await (await fetch(`${base}/api/uploads/${saved.id}/parse/status`)).json();
      state = status.state;
      if (state === 'parsing') await setTimeout(20);
      else assert.equal(state, 'completed', status.error);
    }
    assert.equal(state, 'completed');
    assert.deepEqual((await (await fetch(`${base}/api/uploads/${saved.id}/statement`)).json()).statement, extractedStatement);
    assert.equal(parseCalls, 1); assert.equal(categoryCalls, 0);
    await assert.rejects(access(path.join(root, saved.id, 'analysis.json')));
    await assert.rejects(access(path.join(root, saved.id, 'classifications.json')));
    assert.equal((await fetch(`${base}/api/uploads/${saved.id}/statement`)).status, 200);
    // Make both source representations unavailable: analysis must use JSON only.
    await rename(path.join(root, saved.id, 'statement.pdf'), path.join(root, saved.id, 'statement.pdf.offline'));
    await rename(path.join(root, saved.id, 'statement.md'), path.join(root, saved.id, 'statement.md.offline'));
    assert.equal((await fetch(`${base}/api/uploads/${saved.id}/parse`, { method: 'POST' })).status, 200);
    assert.equal(parseCalls, 1);
    assert.equal((await fetch(`${base}/api/uploads/${saved.id}/analyze`, { method: 'POST' })).status, 200);
    assert.equal(parseCalls, 1); assert.equal(categoryCalls, 1);
    assert.match(await readFile(path.join(root, saved.id, 'analysis.json'), 'utf8'), /"passed"/);
    assert.deepEqual(JSON.parse(await readFile(path.join(root, saved.id, 'statement.json'), 'utf8')), extractedStatement);
    const correctedResponse = await fetch(`${base}/api/uploads/${saved.id}/transactions/tx-1/category`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind: 'expense', category: 'groceries' }) });
    assert.equal(correctedResponse.status, 200);
    const corrected = await correctedResponse.json();
    assert.equal(corrected.spending.summaries[0].totalSpending, '0.2');
    assert.equal(corrected.spending.summaries[0].categories[0].category, 'groceries');
    assert.equal(corrected.classifications[0].source, 'user');
    assert.equal(JSON.parse(await readFile(path.join(root, saved.id, 'classifications.json'), 'utf8'))[0].category, 'groceries');
    assert.deepEqual(JSON.parse(await readFile(path.join(root, saved.id, 'statement.json'), 'utf8')), extractedStatement);
    assert.equal((await fetch(`${base}/api/uploads/${saved.id}/transactions/tx-1/category`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind: 'income', category: null }) })).status, 400);
    assert.equal((await fetch(`${base}/api/uploads/${saved.id}/transactions/tx-1/category`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind: 'expense', category: 'invalid' }) })).status, 400);
    categoryFailure = true;
    const fallback = await fetch(`${base}/api/uploads/${saved.id}/analyze`, { method: 'POST' });
    assert.equal(fallback.status, 200);
    const fallbackResult = await fallback.json();
    assert.equal(fallbackResult.classifications[0].kind, 'unknown');
    assert.equal(fallbackResult.spending.summaries[0].totalSpending, '0');
    assert.match(fallbackResult.spending.issues[0], /Categorization was unavailable/);
    assert.equal(parseCalls, 1); assert.equal(categoryCalls, 2);
    assert.equal((await fetch(`${base}/api/uploads/invalid/analyze`, { method: 'POST' })).status, 404);
    const invalid = new FormData(); invalid.append('statement', new Blob(['not a PDF'], { type: 'application/pdf' }), 'bad.pdf');
    assert.equal((await fetch(`${base}/api/uploads`, { method: 'POST', body: invalid })).status, 400);
    const oversized = new FormData(); oversized.append('statement', new Blob([new Uint8Array(10 * 1024 * 1024 + 1)], { type: 'application/pdf' }), 'large.pdf');
    assert.equal((await fetch(`${base}/api/uploads`, { method: 'POST', body: oversized })).status, 400);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('statement-test-'));
    await rm(root, { recursive: true, force: true });
  }
});
