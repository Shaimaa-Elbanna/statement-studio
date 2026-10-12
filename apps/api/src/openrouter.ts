import { createOpenRouter } from '@openrouter/ai-sdk-provider';

export const defaultModel = 'google/gemini-3.8-flash';
export function hasAIKey(env: NodeJS.ProcessEnv = process.env) {
  return Boolean(env.OPEN_ROUTER?.trim());
}
export function getAIModel(env: NodeJS.ProcessEnv = process.env, fetch?: typeof globalThis.fetch) {
  const apiKey = env.OPEN_ROUTER?.trim();
  if (!apiKey) throw new Error('OPEN_ROUTER is not configured.');
  const router = createOpenRouter({
    apiKey, fetch,
    extraBody: { provider: { require_parameters: true }, reasoning: { effort: 'low', exclude: true } }
  });
  return router(env.OPEN_ROUTER_MODEL?.trim() || defaultModel, { structuredOutputs: { strict: true } });
}
export const pdfProviderOptions = { openrouter: { plugins: [{ id: 'file-parser', pdf: { engine: 'native' } }] } };
