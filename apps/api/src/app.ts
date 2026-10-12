import express from 'express';
import multer from 'multer';
import { rateLimit } from 'express-rate-limit';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import Decimal from 'decimal.js';
import { saveUpload, readParsedStatement, uploadDirectory } from './storage.js';
import { extractStatement } from './extract.js';
import { analyze } from './analyze.js';
import { categorizeStatement } from './categorize.js';
import { categoryUpdateSchema, statementSchema, goalRequestSchema, type Analysis, type ParseProgress, type Upload } from '@statement/shared';
import { adviseOnGoal } from './goal-advice.js';
import { describeAnalysisError } from './errors.js';
import { parseSavedPdf } from './parse.js';
import { analyzeStatementJson } from './analysis-agent.js';
import { hasAIKey, defaultModel } from './openrouter.js';
import { chunkPageSize, writeJsonAtomic } from './chunks.js';

export function createApp(options: { storageRoot?: string; extractor?: typeof extractStatement; categorizer?: typeof categorizeStatement } = {}) {
  const app = express();
  let analyzing = false;
  const parseJobs = new Map<string, ParseProgress>();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '16kb' }));
  app.use('/api', (_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
  app.get('/api/health', (_req, res) => res.json({ ok: true, provider: 'openrouter', model: process.env.OPEN_ROUTER_MODEL || defaultModel, extractionConfigured: hasAIKey() }));
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024, files: 1, fields: 0 } });
  const limiter = rateLimit({ windowMs: 60_000, limit: 10, standardHeaders: 'draft-8', legacyHeaders: false, message: { error: 'Too many requests. Wait a minute and try again.' } });
  const correctionLimiter = rateLimit({ windowMs: 60_000, limit: 60, standardHeaders: 'draft-8', legacyHeaders: false, message: { error: 'Too many corrections. Wait a minute and try again.' } });
  app.get('/api/uploads/:id', async (req, res) => {
    try {
      if (typeof req.params.id !== 'string') throw new Error('Invalid upload ID.');
      res.json(JSON.parse(await readFile(path.join(uploadDirectory(req.params.id, options.storageRoot), 'upload.json'), 'utf8')));
    } catch { res.status(404).json({ error: 'Saved upload not found.' }); }
  });
  app.post('/api/uploads', limiter, upload.single('statement'), async (req, res) => {
    if (!req.file || req.file.mimetype !== 'application/pdf' || !req.file.buffer.subarray(0, 1024).includes(Buffer.from('%PDF-'))) {
      res.status(400).json({ error: 'Choose a valid PDF file.' }); return;
    }
    try {
      res.status(201).json(await saveUpload(req.file.buffer, req.file.originalname, options.storageRoot));
    } catch (error) {
      const message = error instanceof Error && (error.message.startsWith('Please upload') || error.message.startsWith('Too much text'))
        ? error.message : 'Cannot read this PDF. Upload a valid, unlocked statement.';
      res.status(422).json({ error: message });
    }
  });
  app.post('/api/uploads/:id/parse', limiter, async (req, res) => {
    if (typeof req.params.id !== 'string') { res.status(400).json({ error: 'Invalid upload ID.' }); return; }
    const id = req.params.id;
    try {
      const cached = await readParsedStatement(req.params.id, options.storageRoot);
      res.json({ upload: cached.upload, statement: cached.statement }); return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { res.status(422).json({ error: 'Saved JSON is invalid or the upload ID is malformed.' }); return; }
    }
    if (!options.extractor && !hasAIKey()) {
      res.status(503).json({ error: 'PDF saved. Add OPEN_ROUTER to apps/api/.env and restart the API, then retry parsing.' }); return;
    }
    if (parseJobs.get(id)?.state === 'parsing') { res.status(202).json(parseJobs.get(id)); return; }
    if (analyzing) { res.status(409).json({ error: 'Another operation is in progress. Retry parsing shortly.' }); return; }
    let dir: string, uploadInfo: Upload;
    try {
      dir = uploadDirectory(id, options.storageRoot);
      uploadInfo = JSON.parse(await readFile(path.join(dir, 'upload.json'), 'utf8')) as Upload;
    } catch { res.status(404).json({ error: 'Saved PDF not found.' }); return; }
    let size: number;
    try { size = chunkPageSize(); } catch { res.status(500).json({ error: 'PDF_CHUNK_PAGES must be an integer from 1 to 5.' }); return; }
    if (parseJobs.get(id)?.state === 'parsing') { res.status(202).json(parseJobs.get(id)); return; }
    if (analyzing) { res.status(409).json({ error: 'Another operation is in progress. Retry parsing shortly.' }); return; }
    analyzing = true;
    const initial: ParseProgress = { state: 'parsing', completedChunks: 0, totalChunks: Math.ceil(uploadInfo.pageCount / size), currentPages: null, error: null, code: null, updatedAt: new Date().toISOString() };
    parseJobs.set(id, initial);
    const update = async (progress: ParseProgress) => {
      parseJobs.set(id, progress);
      await writeJsonAtomic(path.join(dir, 'parse-progress.json'), progress);
    };
    // Return immediately; progress is polled independently of the long-running model calls.
    res.status(202).json(initial);
    void (async () => {
      try {
        await update(initial);
        await parseSavedPdf(id, options.storageRoot, options.extractor, update);
        const last = parseJobs.get(id)!;
        await update({ ...last, state: 'completed', completedChunks: last.totalChunks, currentPages: null, updatedAt: new Date().toISOString() });
      } catch (error) {
        const failure = describeAnalysisError(error);
        console.error('Statement parsing failed', failure.diagnostic);
        const last = parseJobs.get(id)!;
        const pageInfo = last.currentPages ? `Pages ${last.currentPages.start}–${last.currentPages.end}: ` : '';
        try {
          await update({ ...last, state: 'failed', error: `${pageInfo}${failure.message} Completed batches are saved; retry parsing to resume.`, code: failure.diagnostic.providerCode || failure.diagnostic.networkCode || 'parsing_failed', updatedAt: new Date().toISOString() });
        } catch { parseJobs.set(id, { ...last, state: 'failed', error: 'Could not save parsing progress. Check local storage permissions.', code: 'storage_failed', updatedAt: new Date().toISOString() }); }
      } finally { analyzing = false; }
    })();
  });
  app.get('/api/uploads/:id/parse/status', async (req, res) => {
    if (typeof req.params.id !== 'string') { res.status(400).json({ error: 'Invalid upload ID.' }); return; }
    const id = req.params.id;
    const active = parseJobs.get(id);
    if (active) { res.json(active); return; }
    try {
      const dir = uploadDirectory(id, options.storageRoot);
      const info = JSON.parse(await readFile(path.join(dir, 'upload.json'), 'utf8')) as Upload;
      const total = Math.ceil(info.pageCount / chunkPageSize());
      try {
        await readParsedStatement(id, options.storageRoot);
        res.json({ state: 'completed', completedChunks: total, totalChunks: total, currentPages: null, error: null, code: null, updatedAt: new Date().toISOString() } satisfies ParseProgress); return;
      } catch { /* Completed source JSON is not yet available. */ }
      try {
        const saved = JSON.parse(await readFile(path.join(dir, 'parse-progress.json'), 'utf8')) as ParseProgress;
        res.json(saved.state === 'parsing' ? { ...saved, state: 'failed', error: 'Parsing was interrupted by a backend restart. Retry to resume completed batches.', code: 'parsing_interrupted' } : saved); return;
      } catch { /* No prior job. */ }
      res.json({ state: 'idle', completedChunks: 0, totalChunks: total, currentPages: null, error: null, code: null, updatedAt: new Date().toISOString() } satisfies ParseProgress);
    } catch { res.status(404).json({ error: 'Saved upload not found.' }); }
  });
  app.get('/api/uploads/:id/statement', async (req, res) => {
    try {
      if (typeof req.params.id !== 'string') throw new Error('Invalid upload ID.');
      const parsed = await readParsedStatement(req.params.id, options.storageRoot);
      res.json({ upload: parsed.upload, statement: parsed.statement });
    } catch { res.status(404).json({ error: 'Parsed JSON not found. Parse the PDF first.' }); }
  });
  app.get('/api/uploads/:id/analysis', async (req, res) => {
    try {
      if (typeof req.params.id !== 'string') throw new Error('Invalid upload ID.');
      const result = JSON.parse(await readFile(path.join(uploadDirectory(req.params.id, options.storageRoot), 'analysis.json'), 'utf8')) as Analysis;
      res.json(result);
    } catch { res.status(404).json({ error: 'Saved analysis not found.' }); }
  });
  app.post('/api/uploads/:id/analyze', limiter, async (req, res) => {
    if (typeof req.params.id !== 'string') { res.status(400).json({ error: 'Invalid upload ID.' }); return; }
    let parsed;
    try { parsed = await readParsedStatement(req.params.id, options.storageRoot); }
    catch {
      try { await readFile(path.join(uploadDirectory(req.params.id, options.storageRoot), 'upload.json')); }
      catch { res.status(404).json({ error: 'Saved statement not found.' }); return; }
      res.status(409).json({ error: 'Parse this PDF first. Analysis only accepts saved statement JSON.' }); return;
    }
    if (!options.categorizer && !hasAIKey()) { res.status(503).json({ error: 'JSON is saved. Configure OPEN_ROUTER and restart the backend, then retry JSON analysis.' }); return; }
    if (analyzing) { res.status(409).json({ error: 'Another operation is in progress. Retry analysis shortly.' }); return; }
    analyzing = true;
    try { res.json(await analyzeStatementJson(parsed, parsed.dir, options.categorizer)); }
    catch (error) {
      const failure = describeAnalysisError(error);
      console.error('JSON analysis failed', failure.diagnostic);
      res.status(failure.status).json({ error: failure.message, code: failure.diagnostic.providerCode || failure.diagnostic.networkCode || 'analysis_failed' });
    } finally { analyzing = false; }
  });
  app.post('/api/uploads/:id/goal-advice', limiter, async (req, res) => {
    const input = goalRequestSchema.safeParse(req.body);
    if (!input.success) { res.status(400).json({ error: 'Enter a goal between 3 and 2,000 characters.' }); return; }
    if (!hasAIKey()) { res.status(503).json({ error: 'Configure OPEN_ROUTER to get goal advice.' }); return; }
    if (analyzing) { res.status(409).json({ error: 'Another operation is in progress. Try again shortly.' }); return; }
    analyzing = true;
    try {
      let analysis: Analysis;
      try {
        if (typeof req.params.id !== 'string') throw new Error('Invalid ID');
        analysis = JSON.parse(await readFile(path.join(uploadDirectory(req.params.id, options.storageRoot), 'analysis.json'), 'utf8')) as Analysis;
      } catch { res.status(404).json({ error: 'Run spending analysis before requesting goal advice.' }); return; }
      res.json(await adviseOnGoal(analysis, input.data.goal));
    } catch (error) {
      const failure = describeAnalysisError(error);
      console.error('Goal advice failed', failure.diagnostic);
      res.status(failure.status).json({ error: failure.message });
    } finally { analyzing = false; }
  });
  app.patch('/api/uploads/:id/transactions/:transactionId/category', correctionLimiter, async (req, res) => {
    const patch = categoryUpdateSchema.safeParse(req.body);
    if (!patch.success || (patch.data.kind !== 'expense' && patch.data.category !== null)) {
      res.status(400).json({ error: 'Choose a valid transaction kind and expense category.' }); return;
    }
    if (analyzing) { res.status(409).json({ error: 'Analysis is in progress. Retry your correction shortly.' }); return; }
    analyzing = true;
    let dir: string, previous: Analysis;
    try {
      if (typeof req.params.id !== 'string') throw new Error('Invalid upload ID.');
      dir = uploadDirectory(req.params.id, options.storageRoot);
      previous = JSON.parse(await readFile(path.join(dir, 'analysis.json'), 'utf8')) as Analysis;
    } catch { analyzing = false; res.status(404).json({ error: 'Saved analysis not found.' }); return; }
    const index = previous.classifications.findIndex(c => c.transactionId === req.params.transactionId);
    if (index < 0) { analyzing = false; res.status(404).json({ error: 'Transaction not found.' }); return; }
    const transaction = previous.statement.transactions[index];
    const { kind } = patch.data;
    if (transaction.moneyIn !== null && transaction.moneyOut !== null) {
      const credit = new Decimal(transaction.moneyIn), debit = new Decimal(transaction.moneyOut);
      const debitKind = kind === 'expense' || kind === 'cash_withdrawal' || kind === 'debt_payment';
      const creditKind = kind === 'income' || kind === 'refund';
      if ((debitKind && (!debit.gt(0) || !credit.isZero())) || (creditKind && (!credit.gt(0) || !debit.isZero()))) {
        analyzing = false; res.status(400).json({ error: 'This category does not match the transaction’s debit/credit amounts.' }); return;
      }
    }
    try {
      const classifications = [...previous.classifications];
      classifications[index] = { ...classifications[index], ...patch.data, source: 'user', confidence: 'high', needsReview: patch.data.kind === 'unknown', reason: 'Category assigned by user.' };
      const result = analyze(statementSchema.parse(previous.statement), previous.upload, classifications);
      await writeFile(path.join(dir, 'classifications.json'), JSON.stringify(result.classifications, null, 2), 'utf8');
      await writeFile(path.join(dir, 'analysis.json'), JSON.stringify(result, null, 2), 'utf8');
      res.json(result);
    } catch { res.status(500).json({ error: 'Could not save the category correction.' }); }
    finally { analyzing = false; }
  });
  app.use((error: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (error instanceof multer.MulterError) {
      res.status(400).json({ error: error.code === 'LIMIT_FILE_SIZE' ? 'PDF must be 10 MB or smaller.' : 'Upload one PDF in the statement field.' }); return;
    }
    res.status(500).json({ error: 'Unexpected server error.' });
  });
  return app;
}
export const app = createApp();
