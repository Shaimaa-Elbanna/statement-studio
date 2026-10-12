import { PDFDocument } from 'pdf-lib';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { statementSchema, type ParseProgress, type Statement } from '@statement/shared';
import { extractStatement } from './extract.js';
import { defaultModel } from './openrouter.js';

export function chunkPageSize(value = process.env.PDF_CHUNK_PAGES) {
  const size = Number(value || 2);
  if (!Number.isInteger(size) || size < 1 || size > 5) throw new Error('PDF_CHUNK_PAGES must be an integer from 1 to 5.');
  return size;
}
export async function writeJsonAtomic(filename: string, value: unknown) {
  const temporary = `${filename}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2), 'utf8');
  await rename(temporary, filename);
}
const uniqueExtras = (values: Statement['extraFields']) => [...new Map(values.map(field => [JSON.stringify(field), field])).values()];

export function mergeChunks(chunks: Statement[]): Statement {
  const merged: Statement = { isBankStatement: false, bankName: null, accountHolder: null, periodStart: null, periodEnd: null, extraFields: [], accounts: [], transactions: [], warnings: [] };
  for (const chunk of chunks) {
    merged.isBankStatement ||= chunk.isBankStatement;
    for (const field of ['bankName', 'accountHolder', 'periodStart', 'periodEnd'] as const) {
      if (merged[field] !== null && chunk[field] !== null && merged[field] !== chunk[field]) merged.warnings.push(`Conflicting ${field} across page batches; review the statement.`);
      merged[field] ??= chunk[field];
    }
    merged.extraFields = uniqueExtras([...merged.extraFields, ...chunk.extraFields]);
    merged.warnings.push(...chunk.warnings);
    const mappedIds = new Map<string, string>();
    if (new Set(chunk.accounts.map(a => a.id)).size !== chunk.accounts.length) throw new Error('Duplicate account identifiers in a page batch.');
    for (const account of chunk.accounts) {
      // A matching known ID or last-four/currency identity may join pages; conflicting identifiers never merge.
      let target = merged.accounts.find(a => a.currency === account.currency && (
        (a.id === account.id && !(a.lastFour && account.lastFour && a.lastFour !== account.lastFour)) ||
        (a.lastFour !== null && account.lastFour !== null && a.lastFour === account.lastFour && !(a.accountType && account.accountType && a.accountType !== account.accountType))
      ));
      if (!target) {
        let id = account.id;
        if (merged.accounts.some(a => a.id === id)) id = `account-${merged.accounts.length + 1}`;
        while (merged.accounts.some(a => a.id === id)) id += '-new';
        target = { ...account, id, extraFields: [...account.extraFields] }; merged.accounts.push(target);
      } else {
        for (const field of ['openingBalance', 'closingBalance', 'lastFour', 'accountType'] as const) {
          if (target[field] !== null && account[field] !== null && target[field] !== account[field]) merged.warnings.push(`${target.id}: conflicting ${field} across page batches.`);
          target[field] ??= account[field];
        }
        target.extraFields = uniqueExtras([...target.extraFields, ...account.extraFields]);
      }
      mappedIds.set(account.id, target.id);
    }
    for (const transaction of chunk.transactions) {
      let accountId = transaction.accountId ? mappedIds.get(transaction.accountId) : undefined;
      if (!accountId && transaction.accountId && merged.accounts.some(a => a.id === transaction.accountId && a.currency === transaction.currency)) accountId = transaction.accountId;
      if (!accountId) merged.warnings.push(`Page ${transaction.sourcePage}: a transaction has no reliable account link.`);
      merged.transactions.push({ ...transaction, accountId: accountId || null });
    }
  }
  // Keep duplicate-looking rows: two identical charges may be legitimate. Ownership is by source page.
  const dated = merged.transactions.every(t => t.date && /^\d{4}-\d{2}-\d{2}$/.test(t.date));
  merged.transactions.sort((a, b) => dated ? a.date!.localeCompare(b.date!) || a.sourcePage - b.sourcePage : a.sourcePage - b.sourcePage);
  merged.warnings = [...new Set(merged.warnings)];
  return statementSchema.parse(merged);
}
export async function parsePdfChunks(pdfBytes: Buffer, markdown: string, dir: string, extractor = extractStatement, onProgress?: (progress: ParseProgress) => Promise<void>, size = chunkPageSize()) {
  const source = await PDFDocument.load(pdfBytes);
  const pageCount = source.getPageCount(), totalChunks = Math.ceil(pageCount / size);
  const fingerprint = createHash('sha256').update(pdfBytes).update(markdown).update(JSON.stringify({ version: 2, size, provider: 'openrouter', model: process.env.OPEN_ROUTER_MODEL || defaultModel })).digest('hex');
  const cache = path.join(dir, 'chunks', fingerprint);
  await mkdir(cache, { recursive: true });
  const pages = new Map<number, string>();
  for (const match of markdown.matchAll(/^## Page (\d+)\r?\n([\s\S]*?)(?=^## Page \d+\r?\n|(?![\s\S]))/gm)) pages.set(Number(match[1]), match[2]);
  const results: Statement[] = [];
  for (let start = 1; start <= pageCount; start += size) {
    const end = Math.min(start + size - 1, pageCount);
    await onProgress?.({ state: 'parsing', completedChunks: results.length, totalChunks, currentPages: { start, end }, error: null, code: null, updatedAt: new Date().toISOString() });
    const filename = path.join(cache, `${start}-${end}.json`);
    let result: Statement;
    try { result = statementSchema.parse(JSON.parse(await readFile(filename, 'utf8'))); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      // One adjacent page on each side supplies continuation/header context without owning its rows.
      const pdfPages = Array.from({ length: Math.min(pageCount, end + 1) - Math.max(1, start - 1) + 1 }, (_, i) => Math.max(1, start - 1) + i);
      const batch = await PDFDocument.create();
      const copied = await batch.copyPages(source, pdfPages.map(n => n - 1));
      copied.forEach(page => batch.addPage(page));
      const knownAccounts = mergeChunks(results).accounts.map(({ id, lastFour, currency, accountType }) => ({ id, lastFour, currency, accountType }));
      try {
        result = statementSchema.parse(await extractor(pdfPages.map(n => `## Page ${n}\n${pages.get(n) || '[Read original PDF page.]'}`).join('\n\n'), Buffer.from(await batch.save()), { startPage: start, endPage: end, pdfPages, knownAccounts }));
        if (result.transactions.some(t => t.sourcePage < start || t.sourcePage > end)) {
          const error = new Error('Batch returned transactions outside its owned page range.');
          error.name = 'ChunkPageReferenceError'; throw error;
        }
        await writeJsonAtomic(filename, result);
      } catch (cause) { throw new Error(`Parsing pages ${start}–${end} failed. Completed batches are saved for retry.`, { cause }); }
    }
    if (result.transactions.some(t => t.sourcePage < start || t.sourcePage > end)) throw new Error('Cached batch has invalid source page references.');
    results.push(result);
    await onProgress?.({ state: 'parsing', completedChunks: results.length, totalChunks, currentPages: null, error: null, code: null, updatedAt: new Date().toISOString() });
  }
  return mergeChunks(results);
}
