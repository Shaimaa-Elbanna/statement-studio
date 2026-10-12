import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateText, Output } from 'ai';
import { z } from 'zod';
import { defaultModel, getAIModel, hasAIKey, pdfProviderOptions } from './openrouter.js';

test('the OPEN_ROUTER environment variable configures the provider', () => {
  assert.equal(hasAIKey({}), false); assert.equal(hasAIKey({ OPEN_ROUTER: '  ' }), false);
  assert.equal(hasAIKey({ OPEN_ROUTER: 'test' }), true);
  assert.throws(() => getAIModel({}), /OPEN_ROUTER/);
});
test('AI SDK sends PDFs and strict JSON requests through the official OpenRouter provider', async () => {
  let called = false;
  const mockFetch: typeof fetch = async (input, init) => {
    called = true;
    assert.equal(String(input), 'https://openrouter.ai/api/v1/chat/completions');
    assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer test-key');
    const body = JSON.parse(String(init?.body));
    assert.equal(body.model, defaultModel);
    assert.equal(body.response_format.type, 'json_schema');
    assert.equal(body.response_format.json_schema.strict, true);
    assert.equal(body.provider.require_parameters, true);
    assert.equal(body.reasoning.effort, 'low');
    assert.ok(body.plugins.some((p: { id: string; pdf?: { engine: string } }) => p.id === 'file-parser' && p.pdf?.engine === 'native'));
    assert.ok(body.messages[0].content.some((p: { type: string; file?: { file_data: string } }) => p.type === 'file' && p.file?.file_data.startsWith('data:application/pdf;base64,')));
    return new Response(JSON.stringify({ id: 'test', object: 'chat.completion', created: 0, model: defaultModel, choices: [{ index: 0, message: { role: 'assistant', content: '{"ok":true}' }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }), { headers: { 'Content-Type': 'application/json' } });
  };
  const result = await generateText({ model: getAIModel({ OPEN_ROUTER: 'test-key' }, mockFetch), output: Output.object({ schema: z.object({ ok: z.boolean() }) }), messages: [{ role: 'user', content: [{ type: 'text', text: 'Extract JSON' }, { type: 'file', data: Buffer.from('%PDF-test'), mediaType: 'application/pdf', filename: 'statement.pdf' }] }], providerOptions: pdfProviderOptions, maxRetries: 0 });
  assert.ok(called); assert.deepEqual(result.output, { ok: true });
});
