// Model access: @openai/agents driven against Anthropic's OpenAI-compatible endpoint.
// Everything that touches the network or the API key lives here. The key is read from the
// environment only, never logged, never returned to callers and scrubbed from every error.
import { AsyncLocalStorage } from 'node:async_hooks';
import OpenAI from 'openai';
import { Agent, run as agentsRun, setDefaultOpenAIClient, setOpenAIAPI, setTracingDisabled } from '@openai/agents';
import { FactoryError } from './canonical.mjs';

export const DEFAULT_BASE_URL = 'https://api.anthropic.com/v1/';
/** Default model id (matches .env.LLM_MODEL). NOT yet live-verified: the project key was rejected with 401 during Task 2; run `npm run verify:model` once a valid key is in .env. */
export const DEFAULT_MODEL = 'claude-sonnet-4-5';
/** Newest-first candidates tried by `verifyModelId`. */
export const MODEL_CANDIDATES = Object.freeze(['claude-sonnet-5-5', 'claude-sonnet-4-5']);

export function loadLlmConfig(env = process.env) {
  const apiKey = env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new FactoryError(
      'No AI service key is set. Add ANTHROPIC_API_KEY to the .env file (see .env.example), then try again.',
      'LLM_KEY_MISSING'
    );
  }
  return { apiKey, baseURL: env.LLM_BASE_URL || DEFAULT_BASE_URL, model: env.LLM_MODEL || DEFAULT_MODEL };
}

/** Remove any occurrence of the key (and obvious key-shaped strings) from text before it is shown or stored. */
export function scrubSecrets(text, apiKey) {
  let out = String(text ?? '');
  if (apiKey) out = out.split(apiKey).join('[key removed]');
  return out.replace(/\bsk-[A-Za-z0-9_-]{16,}/g, '[key removed]');
}

// Per-call collector: the fetch wrapper records the provider's `request-id` header here.
const collector = new AsyncLocalStorage();

function capturingFetch(baseFetch = globalThis.fetch) {
  return async (url, init) => {
    const res = await baseFetch(url, init);
    const store = collector.getStore();
    if (store) store.requestId = res.headers.get('request-id') ?? res.headers.get('x-request-id') ?? store.requestId;
    return res;
  };
}

export function configureAgentsSdk(config, fetchImpl) {
  const client = new OpenAI({ apiKey: config.apiKey, baseURL: config.baseURL, fetch: capturingFetch(fetchImpl), maxRetries: 1 });
  setDefaultOpenAIClient(client);
  setOpenAIAPI('chat_completions');
  setTracingDisabled(true);
  return client;
}

/**
 * One model call through the Agents SDK. No tools: the agent cannot act outward.
 * Returns { text, model, requestId, responseId, startedAt, finishedAt, durationMs, usage }.
 * Any failure throws FactoryError('MODEL_FAILED') with a plain-English reason; there is no fallback answer.
 */
export async function callModel({ instructions, input, model, maxTokens = 8000, temperature = 0.2, config, fetchImpl }) {
  const cfg = config ?? loadLlmConfig();
  const modelId = model ?? cfg.model;
  configureAgentsSdk(cfg, fetchImpl);
  const agent = new Agent({ name: 'SAFI agent', instructions, model: modelId, tools: [], modelSettings: { temperature, maxTokens } });
  const startedAt = new Date();
  const store = { requestId: undefined };
  try {
    const result = await collector.run(store, () => agentsRun(agent, input, { maxTurns: 1 }));
    const last = result.rawResponses.at(-1);
    const text = typeof result.finalOutput === 'string' ? result.finalOutput : '';
    if (!text.trim()) throw new FactoryError('The AI service returned an empty answer. Try the request again.', 'MODEL_EMPTY');
    const finishedAt = new Date();
    return {
      text,
      model: modelId,
      requestId: store.requestId ?? last?.requestId ?? last?.responseId ?? null,
      responseId: last?.responseId ?? null,
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      durationMs: finishedAt - startedAt,
      usage: last?.usage ? { inputTokens: last.usage.inputTokens, outputTokens: last.usage.outputTokens } : null
    };
  } catch (e) {
    if (e instanceof FactoryError) throw e;
    const status = e?.status ?? e?.cause?.status;
    const detail = scrubSecrets(e?.message ?? String(e), cfg.apiKey);
    let plain;
    if (status === 401 || status === 403) plain = 'The AI service rejected the API key. Ask the SAFI administrator to check ANTHROPIC_API_KEY.';
    else if (status === 404) plain = `The AI service does not know the model "${modelId}". Check LLM_MODEL.`;
    else if (status === 429) plain = 'The AI service is busy or over its limit. Wait a minute and try again.';
    else plain = 'The AI service could not be reached or failed. Check the internet connection and try again.';
    throw new FactoryError(`${plain} (${detail})`, 'MODEL_FAILED', { status, requestId: store.requestId ?? e?.requestID ?? e?.request_id ?? null });
  }
}

/** Try model ids newest-first with a tiny call; returns the first the key accepts plus evidence for each attempt. */
export async function verifyModelId(candidates = MODEL_CANDIDATES, opts = {}) {
  const attempts = [];
  for (const id of candidates) {
    try {
      const r = await callModel({ instructions: 'Reply with the single word: ok', input: 'ping', model: id, maxTokens: 16, temperature: 0, ...opts });
      attempts.push({ model: id, ok: true, requestId: r.requestId });
      return { model: id, attempts };
    } catch (e) {
      attempts.push({ model: id, ok: false, status: e.details?.status ?? null, reason: e.message });
    }
  }
  return { model: null, attempts };
}
