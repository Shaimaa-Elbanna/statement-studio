import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Analysis, ParsedStatement, ParseProgress, Upload } from '@statement/shared';
import { spendingCategories, categoryLabels, transactionKinds, kindLabels, type Classification } from '@statement/shared';
import Spending from './Spending';
import ParsedPreview from './ParsedPreview';
import GoalAdvice from './GoalAdvice';

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Request failed. Please try again.');
  return data;
}
const money = (amount: string | null, currency: string | null) => amount === null ? '—' : `${Number(amount).toLocaleString(undefined, { maximumFractionDigits: 8 })} ${currency || ''}`;
function exportJson(value: unknown, filename: string) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }));
  const a = document.createElement('a'); a.href = url; a.download = filename; a.click(); URL.revokeObjectURL(url);
}
const classificationValue = (c: Classification | undefined) => c?.kind === 'expense' ? `expense:${c.category || 'uncategorized'}` : c?.kind || 'unknown';

export default function App() {
  const queryClient = useQueryClient();
  const resumeId = new URLSearchParams(window.location.search).get('statement');
  const input = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [saved, setSaved] = useState<Upload | null>(() => {
    try {
      const value = JSON.parse(sessionStorage.getItem('statement-upload') || 'null') as Upload | null;
      return value && typeof value.id === 'string' && /^[0-9a-f-]{36}$/i.test(value.id) && (!resumeId || resumeId === value.id) ? value : null;
    } catch { return null; }
  });
  const [fileError, setFileError] = useState('');
  const [search, setSearch] = useState('');
  const [dragging, setDragging] = useState(false);
  const [corrected, setCorrected] = useState<Analysis | null>(null);
  const [categoryFilter, setCategoryFilter] = useState('all');
  const resumeUpload = useQuery({ queryKey: ['resume-upload', resumeId], queryFn: () => request<Upload>(`/api/uploads/${encodeURIComponent(resumeId!)}`), enabled: Boolean(resumeId && resumeId !== saved?.id), retry: false });
  useEffect(() => {
    if (!resumeId || !resumeUpload.data || resumeUpload.data.id === saved?.id) return;
    setSaved(resumeUpload.data);
    try { sessionStorage.setItem('statement-upload', JSON.stringify(resumeUpload.data)); } catch { /* Persistence is optional. */ }
  }, [resumeId, resumeUpload.data, saved?.id]);
  const health = useQuery({ queryKey: ['health'], queryFn: () => request<{ ok: boolean; extractionConfigured: boolean }>('/api/health') });
  const parsing = useMutation({ mutationFn: (id: string) => request<ParsedStatement | ParseProgress>(`/api/uploads/${id}/parse`, { method: 'POST' }), onSuccess: (_data, id) => { void health.refetch(); void queryClient.invalidateQueries({ queryKey: ['parse-status', id] }); } });
  const progress = useQuery({ queryKey: ['parse-status', saved?.id], queryFn: () => request<ParseProgress>(`/api/uploads/${saved!.id}/parse/status`), enabled: Boolean(saved), retry: false, refetchInterval: query => query.state.data?.state === 'parsing' ? 1000 : false });
  const parsedQuery = useQuery({ queryKey: ['parsed-statement', saved?.id], queryFn: () => request<ParsedStatement>(`/api/uploads/${saved!.id}/statement`), enabled: Boolean(saved && progress.data?.state === 'completed'), retry: false });
  const restoredAnalysis = useQuery({ queryKey: ['saved-analysis', saved?.id], queryFn: () => request<Analysis>(`/api/uploads/${saved!.id}/analysis`), enabled: Boolean(parsedQuery.data), retry: false });
  const analysis = useMutation({ mutationFn: (id: string) => request<Analysis>(`/api/uploads/${id}/analyze`, { method: 'POST' }), onSuccess: (_data, id) => { setCorrected(null); void health.refetch(); void queryClient.invalidateQueries({ queryKey: ['saved-analysis', id] }); } });
  const correction = useMutation({
    mutationFn: ({ uploadId, transactionId, value }: { uploadId: string; transactionId: string; value: string }) => {
      const expense = value.startsWith('expense:');
      const category = expense && value !== 'expense:uncategorized' ? value.slice(8) : null;
      return request<Analysis>(`/api/uploads/${uploadId}/transactions/${transactionId}/category`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind: expense ? 'expense' : value, category }) });
    },
    onSuccess: setCorrected
  });
  const upload = useMutation({
    mutationFn: (pdf: File) => { const body = new FormData(); body.append('statement', pdf); return request<Upload>('/api/uploads', { method: 'POST', body }); },
    onSuccess: (result) => { setSaved(result); try { sessionStorage.setItem('statement-upload', JSON.stringify(result)); } catch { /* Persistence is optional. */ } parsing.mutate(result.id); }
  });
  const parsingActive = parsing.isPending || progress.data?.state === 'parsing' || (Boolean(saved) && progress.isPending);
  const busy = upload.isPending || parsingActive || analysis.isPending || correction.isPending;
  function choose(next: File | undefined) {
    if (busy || !next) return;
    setFileError('');
    if (!next.name.toLowerCase().endsWith('.pdf') || (next.type && next.type !== 'application/pdf')) { setFileError('Choose a PDF file.'); return; }
    if (next.size > 10 * 1024 * 1024) { setFileError('PDF must be 10 MB or smaller.'); return; }
    window.history.replaceState(null, '', window.location.pathname);
    setFile(next); setSaved(null); setSearch(''); setCorrected(null); setCategoryFilter('all'); upload.reset(); parsing.reset(); analysis.reset(); correction.reset();
    try { sessionStorage.removeItem('statement-upload'); } catch { /* Persistence is optional. */ }
  }
  const result = corrected || analysis.data || restoredAnalysis.data;
  const parsed = parsing.data && 'statement' in parsing.data ? parsing.data : parsedQuery.data;
  const filtered = result?.statement.transactions.map((t, i) => ({ t, id: `tx-${i + 1}`, classification: result.classifications.find(c => c.transactionId === `tx-${i + 1}`) }))
    .filter(({ t, classification }) => `${t.description} ${t.date || ''} ${t.reference || ''}`.toLowerCase().includes(search.toLowerCase()) && (categoryFilter === 'all' || classificationValue(classification) === categoryFilter)) || [];
  const error = fileError || resumeUpload.error?.message || upload.error?.message || parsing.error?.message || (progress.data?.state === 'failed' ? progress.data.error : null) || parsedQuery.error?.message || correction.error?.message;
  return (
    <div className="shell">
      <header><a className="brand" href="/"> <span className="brand-icon">S</span> Statement Studio</a><span className="top-label">BANK STATEMENT ANALYSIS</span></header>
      <main>
        <section className="intro"><span className="eyebrow">FROM STATEMENT TO CLARITY</span><h1>Your finances.<br/><span>A clearer picture.</span></h1><p>Upload a bank statement to extract account details,<br className="desktop"/> explore transactions, and check your balances.</p></section>
        <section className="upload-panel" aria-label="Upload bank statement">
          <div className="section-title"><h2>1. Parse your statement</h2><span className="pill">PDF → JSON</span></div>
          <input ref={input} type="file" accept="application/pdf,.pdf" disabled={busy} onChange={e => choose(e.target.files?.[0])} hidden />
          <button className={`dropzone ${dragging ? 'dragging' : ''}`} disabled={busy} onClick={() => input.current?.click()}
            onDragOver={e => { e.preventDefault(); if (!busy) setDragging(true); }} onDragLeave={() => setDragging(false)}
            onDrop={e => { e.preventDefault(); setDragging(false); choose(e.dataTransfer.files[0]); }}>
            <span className="upload-icon" aria-hidden="true">↑</span>
            <strong>{file ? file.name : saved ? saved.filename : 'Drop your PDF here'}</strong>
            <span>{file ? `${(file.size / 1024).toFixed(0)} KB · Click to change file` : saved ? 'Saved statement · Click to choose a different file' : 'or click to browse your files'}</span>
            <small>Up to 10 MB · 30 pages · Unlocked PDFs</small>
          </button>
          <div className="upload-footer"><span>Parsed in small page batches. Completed batches are saved.</span><button className="primary" disabled={busy || (!file && !saved) || Boolean(parsed)} onClick={() => saved ? parsing.mutate(saved.id) : file && upload.mutate(file)}>{upload.isPending ? 'Saving PDF…' : parsingActive ? 'Parsing batches…' : parsed ? 'JSON ready ✓' : saved ? 'Resume parsing →' : 'Upload & parse PDF →'}</button></div>
          <div aria-live="polite">{saved && <p className="saved">PDF saved · {saved.pageCount} pages · {saved.textCharacters.toLocaleString()} text characters{saved.scannedPages.length ? ` · ${saved.scannedPages.length} pages need visual reading` : ''}</p>}
          {error && <p className="error" role="alert">{error}</p>}
          {health.isError && <p className="error">Cannot connect to the backend. Check that the API is running.</p>}
          {health.data && !health.data.extractionConfigured && <p className="notice">Upload is ready. Add your OpenRouter API key in the backend to enable parsing and JSON analysis.</p>}
          {parsingActive && <div className="parse-progress"><div className="section-title"><strong>Parsing statement</strong><span>{progress.data?.completedChunks || 0} / {progress.data?.totalChunks || '…'} batches saved</span></div><progress aria-label="PDF parsing progress" value={progress.data?.completedChunks || 0} max={progress.data?.totalChunks || 1} /><p>{progress.data?.currentPages ? `Reading pages ${progress.data.currentPages.start}–${progress.data.currentPages.end}.` : 'Preparing or merging page batches.'} You can refresh this tab without restarting the job. Spending analysis has not started.</p></div>}</div>
        </section>
        {parsed && <section className="json-stage" aria-label="Parsed statement preview">
          <div className="section-title"><div><span className="eyebrow">PARSED AND SAVED</span><h2>2. Preview parsed statement</h2></div><button className="secondary" onClick={() => exportJson(parsed.statement, 'statement.json')}>Download JSON ↓</button></div>
          <p className="footnote">This is the extracted statement data before categories or spending analysis. The next step reads this saved JSON.</p>
          {parsed.statement.warnings.length > 0 && <div className="review-box"><h3>Parsing notes</h3><ul>{parsed.statement.warnings.map((warning, i) => <li key={i}>{warning}</li>)}</ul></div>}
          <ParsedPreview key={parsed.upload.id} statement={parsed.statement} />
          <div className="json-analysis-action"><div><h3>3. Preview spending analysis</h3><p className="footnote">OpenRouter reads the saved JSON and suggests transaction categories. The spending breakdown appears below after analysis.{result ? ' Running again replaces category corrections.' : ''}</p></div><button className="primary" disabled={busy || !parsed.statement.isBankStatement || !parsed.statement.transactions.length} onClick={() => analysis.mutate(parsed.upload.id)}>{analysis.isPending ? 'Analyzing JSON…' : result ? 'Run analysis again →' : 'Analyze JSON →'}</button></div>
          <div aria-live="polite">{analysis.isPending && <p className="notice">Reading saved JSON and categorizing spending. The PDF is not being parsed again.</p>}{analysis.error && <p className="error" role="alert">{analysis.error.message}</p>}</div>
        </section>}
        {!result && <div className="steps"><div><span>01</span><h3>Upload</h3><p>Your original PDF is saved on disk.</p></div><div><span>02</span><h3>Extract</h3><p>Text and PDF layout become structured data.</p></div><div><span>03</span><h3>Understand</h3><p>Review transactions and balance checks.</p></div></div>}
        {result && <section className="results" aria-label="Spending analysis preview">
          <div className="analysis-preview-heading"><span className="eyebrow">ANALYSIS OF YOUR SAVED JSON</span><h2>Spending analysis preview</h2><p>OpenRouter suggests the categories; totals and balance checks are calculated from the extracted amounts. Your category corrections update this preview.</p></div>
          <div className="section-title"><div><span className="eyebrow">YOUR STATEMENT</span><h2>{result.statement.bankName || 'Bank statement'}</h2><p>{result.statement.accountHolder || 'Account holder unavailable'} · {result.statement.periodStart || 'Unknown start'} — {result.statement.periodEnd || 'Unknown end'}</p></div><div className="export-buttons"><button className="secondary" onClick={() => exportJson(result.statement, 'statement.json')}>Extracted JSON ↓</button><button className="secondary" onClick={() => exportJson(result, 'spending-analysis.json')}>Analysis JSON ↓</button></div></div>
          {result.summaries.map((summary, i) => <div className="account" key={`${summary.accountId}-${i}`}>
            <div className="section-title"><h3>{result.statement.accounts[i]?.accountType || 'Account'} {result.statement.accounts[i]?.lastFour ? `···· ${result.statement.accounts[i].lastFour}` : summary.accountId}</h3><span className={`pill ${summary.reconciliation === 'passed' ? 'good' : 'review'}`}>{summary.reconciliation === 'passed' ? 'Balances match' : summary.reconciliation === 'review' ? 'Review needed' : 'Balance check unavailable'}</span></div>
            <div className="metrics"><div><small>Money in{summary.partial ? ' · partial' : ''}</small><strong className="green">{money(summary.totalIn, summary.currency)}</strong></div><div><small>Money out{summary.partial ? ' · partial' : ''}</small><strong>{money(summary.totalOut, summary.currency)}</strong></div><div><small>Net movement</small><strong>{money(summary.net, summary.currency)}</strong></div><div><small>Transactions</small><strong>{summary.count}</strong></div></div>
          </div>)}
          <Spending data={result.spending} />
          <GoalAdvice key={result.upload.id} analysisVersion={JSON.stringify(result)} uploadId={result.upload.id} busy={busy} />
          {result.issues.length > 0 && <div className="review-box"><h3>Check these details</h3><ul>{result.issues.map((issue, i) => <li key={i}>{issue}</li>)}</ul></div>}
          {result.statement.extraFields.length > 0 && <details><summary>Additional bank details</summary><dl>{result.statement.extraFields.map((field, i) => <div key={i}><dt>{field.label}</dt><dd>{field.value}</dd></div>)}</dl></details>}
          <div className="section-title transaction-title"><h2>Transactions <span className="count">{result.statement.transactions.length}</span></h2><div className="transaction-filters"><select className="category-select" aria-label="Filter by category" value={categoryFilter} onChange={e => setCategoryFilter(e.target.value)}><option value="all">All categories</option>{spendingCategories.map(c => <option key={c} value={`expense:${c}`}>{categoryLabels[c]}</option>)}<option value="expense:uncategorized">Uncategorized spending</option>{transactionKinds.filter(k => k !== 'expense').map(k => <option key={k} value={k}>{kindLabels[k]}</option>)}</select><input className="search" aria-label="Search transactions" placeholder="Search transactions…" value={search} onChange={e => setSearch(e.target.value)} /></div></div>
          <p className="footnote">Categories are AI suggestions. Change a category below to save your correction and recalculate the spending totals.</p>
          <div className="table-wrap"><table><thead><tr><th>Date</th><th>Description</th><th>Category / kind</th><th>Account</th><th>Money in</th><th>Money out</th><th>Balance</th><th>Source</th></tr></thead><tbody>{filtered.map(({ t, id, classification }) => <tr key={id}><td>{t.date || 'Unknown'}</td><td>{t.description}{t.needsReview && <span className="review-tag">Review source</span>}{t.extraFields.length > 0 && <details><summary>More details</summary>{t.extraFields.map((f, j) => <p key={j}>{f.label}: {f.value}</p>)}</details>}</td><td><select className="category-select" aria-label={`Category for ${t.description}`} title={classification?.reason} value={classificationValue(classification)} disabled={busy} onChange={e => correction.mutate({ uploadId: result.upload.id, transactionId: id, value: e.target.value })}>{spendingCategories.map(c => <option key={c} value={`expense:${c}`}>{categoryLabels[c]}</option>)}<option value="expense:uncategorized">Uncategorized spending</option>{transactionKinds.filter(k => k !== 'expense').map(k => <option key={k} value={k}>{kindLabels[k]}</option>)}</select><small className="classification-note">{classification?.source === 'user' ? 'Your correction' : `${classification?.confidence || 'low'} confidence`}{classification?.needsReview ? ' · Review' : ''}</small><details><summary>Why this category?</summary><p>{classification?.reason || 'Not categorized.'}</p></details></td><td>{t.accountId || 'Unknown'}</td><td className="green">{money(t.moneyIn, t.currency)}</td><td>{money(t.moneyOut, t.currency)}</td><td>{money(t.balance, t.currency)}</td><td>Page {t.sourcePage}</td></tr>)}</tbody></table>{!filtered.length && <p className="empty">No transactions to show.</p>}</div>
          <p className="footnote">Check extracted entries against the original statement. Matching balances do not prove every entry is correct.</p>
        </section>}
      </main><footer>Statement Studio <span>Built for a clearer view.</span></footer>
    </div>
  );
}
