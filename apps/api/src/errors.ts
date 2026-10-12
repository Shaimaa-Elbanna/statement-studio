import { APICallError, NoObjectGeneratedError } from 'ai';

const networkCodes = new Set(['EACCES', 'EPERM', 'ENOTFOUND', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'CERT_HAS_EXPIRED']);
function chain(error: unknown, depth = 0): unknown[] {
  if (!error || typeof error !== 'object' || depth > 6) return [];
  const value = error as { cause?: unknown; errors?: unknown[] };
  return [error, ...chain(value.cause, depth + 1), ...(Array.isArray(value.errors) ? value.errors.flatMap(e => chain(e, depth + 1)) : [])];
}
export function describeAnalysisError(error: unknown) {
  const causes = chain(error), api = causes.find(APICallError.isInstance), structured = causes.find(NoObjectGeneratedError.isInstance);
  let providerStatus = api?.statusCode, retryAfterSeconds: number | undefined;
  if (api) {
    try {
      const body = api.responseBody ? JSON.parse(api.responseBody)?.error : (api.data as { error?: unknown } | undefined)?.error;
      if (Number.isInteger(body?.code) && body.code >= 400 && body.code <= 599) providerStatus = body.code;
    } catch { /* Never copy raw responses, prompts, credentials or financial data into diagnostics. */ }
    const retry = api.responseHeaders?.['retry-after'];
    if (retry && /^\d+$/.test(retry)) retryAfterSeconds = Number(retry);
  }
  const networkCode = causes.map(e => (e as { code?: unknown }).code).find(c => typeof c === 'string' && networkCodes.has(c)) as string | undefined;
  const finishReason = structured?.finishReason;
  let code = 'analysis_failed', status = 502, message = 'OpenRouter analysis failed. Your saved files are preserved. Please retry.';
  if (causes.some(e => ['TimeoutError', 'AbortError'].includes((e as Error).name)) || providerStatus === 408 || providerStatus === 504) {
    code = 'model_timeout'; status = 504; message = 'The model request exceeded its timeout. Try PDF_CHUNK_PAGES=1 for denser statements, then resume parsing.';
  } else if (networkCode === 'EACCES' || networkCode === 'EPERM') {
    code = networkCode; status = 503; message = 'The API process is blocked from connecting to OpenRouter. Restart the backend with network access; your API key is being read.';
  } else if (networkCode || (api && !providerStatus)) {
    code = networkCode || 'connection_failed'; status = 503; message = 'The backend could not connect to OpenRouter. Check its internet access, proxy and firewall, then retry.';
  } else if (providerStatus === 401) {
    code = 'invalid_api_key'; status = 503; message = 'OpenRouter rejected the API key. Check OPEN_ROUTER in apps/api/.env and that the key is active.';
  } else if (providerStatus === 402) {
    code = 'insufficient_credits'; status = 503; message = 'OpenRouter requires more credits or a higher key spending limit for this request. Check OpenRouter credits and key limits before retrying.';
  } else if (providerStatus === 429) {
    code = 'rate_limited'; status = 429; message = `OpenRouter or its model provider reached a rate limit.${retryAfterSeconds ? ` Retry after at least ${retryAfterSeconds} seconds.` : ' Wait before retrying.'}`;
  } else if (providerStatus === 403) {
    code = 'access_denied'; status = 503; message = 'OpenRouter denied this request. Check key permissions, model access and provider restrictions.';
  } else if (providerStatus === 404 || providerStatus === 503) {
    code = 'model_unavailable'; status = 503; message = 'No suitable model endpoint is available. Check OPEN_ROUTER_MODEL and that providers support PDF input and structured outputs.';
  } else if (providerStatus === 400 && /response.?schema|json.?schema|schema/i.test(api?.message || '')) {
    code = 'invalid_schema'; status = 500; message = 'The model provider rejected the output schema. This is an app configuration error, not an API-key error.';
  } else if (providerStatus === 400 || providerStatus === 413 || providerStatus === 422) {
    code = 'invalid_request'; status = 422; message = 'The model could not process this batch. Check PDF readability and model capabilities, or set PDF_CHUNK_PAGES=1.';
  } else if (causes.some(e => (e as Error).name === 'ChunkPageReferenceError')) {
    code = 'invalid_page_references'; status = 422; message = 'The model used page references outside the requested batch. Retry parsing; completed batches remain saved.';
  } else if (causes.some(e => (e as Error).name === 'OutputLimitError')) {
    code = 'output_limit'; status = 422; message = 'The batch reached the model output limit. Set PDF_CHUNK_PAGES=1 and retry parsing.';
  } else if (structured) {
    code = finishReason === 'length' ? 'output_limit' : 'invalid_json'; status = 422;
    message = finishReason === 'length' ? 'The batch reached the model output limit. Set PDF_CHUNK_PAGES=1 and resume parsing.' : 'The model did not return valid statement JSON for this batch. Retry or reduce PDF_CHUNK_PAGES to 1.';
  }
  return { status, message, diagnostic: { provider: 'openrouter', providerStatus, providerCode: code, networkCode, retryAfterSeconds, structuredOutputError: Boolean(structured), finishReason } };
}
