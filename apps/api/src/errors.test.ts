import { test } from 'node:test';
import assert from 'node:assert/strict';
import { APICallError } from 'ai';
import { describeAnalysisError } from './errors.js';

function apiError(statusCode: number, code = statusCode, message = 'Private provider error DO_NOT_EXPOSE', retry?: string) {
  return new APICallError({ statusCode, message, url: 'https://openrouter.ai/api/v1/chat/completions', requestBodyValues: { privateStatement: 'DO_NOT_EXPOSE' }, responseBody: JSON.stringify({ error: { code, message } }), responseHeaders: retry ? { 'retry-after': retry } : undefined });
}
test('OpenRouter errors distinguish invalid keys, insufficient credits, rate limits and model access', () => {
  assert.equal(describeAnalysisError(apiError(401)).diagnostic.providerCode, 'invalid_api_key');
  assert.equal(describeAnalysisError(apiError(402)).diagnostic.providerCode, 'insufficient_credits');
  const limited = describeAnalysisError(apiError(429, 429, 'Rate limit reached', '18'));
  assert.equal(limited.status, 429); assert.match(limited.message, /18 seconds/);
  assert.match(describeAnalysisError(apiError(404)).message, /OPEN_ROUTER_MODEL/);
  assert.doesNotMatch(JSON.stringify(describeAnalysisError(apiError(401, 401, 'Incorrect key: PRIVATE_KEY_DO_NOT_EXPOSE'))), /PRIVATE_KEY|DO_NOT_EXPOSE/);
});
test('timeouts, schema failures and blocked networking receive different remedies', () => {
  assert.match(describeAnalysisError(new DOMException('deadline', 'TimeoutError')).message, /PDF_CHUNK_PAGES=1/);
  assert.equal(describeAnalysisError(apiError(400, 400, 'Invalid response_schema')).diagnostic.providerCode, 'invalid_schema');
  const network = describeAnalysisError(new APICallError({ message: 'fetch failed', url: 'https://openrouter.ai/api/v1/chat/completions', requestBodyValues: {}, cause: new TypeError('fetch failed', { cause: Object.assign(new Error('blocked'), { code: 'EACCES' }) }) }));
  assert.equal(network.diagnostic.networkCode, 'EACCES'); assert.match(network.message, /blocked from connecting to OpenRouter/);
});
