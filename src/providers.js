// AI providers behind one method (Gemini, Anthropic, any OpenAI-compatible API):
//   complete({system, user, schema, temperature}) -> {json, usage}
// The answer must follow `schema` (JSON Schema); the caller validates it again.
// Keys come from the caller (the CLI reads the environment), never from files.
// Browser-safe: fetch and WebCrypto only.

export const RECORDING_FORMAT = 'n20s-propose-recording/0.1';

/** Google Gemini, generateContent with a JSON response schema. */
export function geminiProvider({ apiKey, model = 'gemini-2.5-flash', baseUrl = 'https://generativelanguage.googleapis.com/v1beta', fetch = globalThis.fetch, retries = 3 } = {}) {
  if (!apiKey) throw new Error('No Gemini API key: set GEMINI_API_KEY.');
  return {
    name: 'gemini',
    model,
    async complete({ system, user, schema, temperature = 0, maxOutputTokens = 32768 }) {
      const body = {
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: 'user', parts: [{ text: user }] }],
        generationConfig: { temperature, maxOutputTokens, responseMimeType: 'application/json', responseJsonSchema: schema },
      };
      for (let attempt = 0; ; attempt++) {
        // The key goes in a header, never in the URL, so it cannot end up in an error message.
        const res = await fetch(`${baseUrl}/models/${encodeURIComponent(model)}:generateContent`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
          body: JSON.stringify(body),
        });
        const data = await res.json().catch(() => ({}));
        if ((res.status === 429 || res.status >= 500) && attempt < retries) {
          await new Promise((r) => setTimeout(r, 2000 * 2 ** attempt));
          continue;
        }
        if (!res.ok) throw new Error(`Gemini ${res.status}: ${data?.error?.message ?? res.statusText}`);
        const candidate = data.candidates?.[0];
        const text = (candidate?.content?.parts ?? []).filter((p) => !p.thought && typeof p.text === 'string').map((p) => p.text).join('');
        if (candidate?.finishReason && candidate.finishReason !== 'STOP') throw new Error(`Gemini stopped with ${candidate.finishReason}.`);
        let json;
        try { json = JSON.parse(text); } catch { throw new Error(`Gemini returned no JSON: ${text.slice(0, 200)}`); }
        const u = data.usageMetadata ?? {};
        return { json, usage: { input: u.promptTokenCount ?? 0, output: u.candidatesTokenCount ?? 0, thinking: u.thoughtsTokenCount ?? 0, cached: u.cachedContentTokenCount ?? 0 }, model: data.modelVersion ?? model };
      }
    },
  };
}

/** Waits before retrying a rate-limited or failing call: 2 s, 4 s, 8 s. */
const backoff = (attempt) => new Promise((r) => setTimeout(r, 2000 * 2 ** attempt));
const parseJson = (who, text) => {
  try { return JSON.parse(text); } catch { throw new Error(`${who} returned no JSON: ${String(text).slice(0, 200)}`); }
};

/** Gemini models that generate content, for choosing one. */
geminiProvider.models = async ({ apiKey, baseUrl = 'https://generativelanguage.googleapis.com/v1beta', fetch = globalThis.fetch }) => {
  const res = await fetch(`${baseUrl}/models?pageSize=1000`, { headers: { 'x-goog-api-key': apiKey } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Gemini ${res.status}: ${data?.error?.message ?? res.statusText}`);
  return (data.models ?? []).filter((m) => (m.supportedGenerationMethods ?? []).includes('generateContent'))
    .map((m) => ({ id: m.name.replace(/^models\//, ''), label: m.displayName ?? m.name }));
};

/**
 * Any OpenAI-compatible chat completions API: OpenAI, Azure OpenAI (v1), Mistral,
 * OpenRouter, Ollama, vLLM… The answer is asked as a JSON schema response; a
 * server that does not know json_schema gets json_object and the schema in the prompt.
 */
export function openaiProvider({ apiKey, model, baseUrl = 'https://api.openai.com/v1', fetch = globalThis.fetch, retries = 3 } = {}) {
  if (!model) throw new Error('No model: choose one (N20S_AI_MODEL).');
  const base = baseUrl.replace(/\/$/, '');
  return {
    name: 'openai',
    model,
    async complete({ system, user, schema, temperature = 0, maxOutputTokens = 32768 }) {
      let format = { type: 'json_schema', json_schema: { name: 'answer', schema, strict: false } };
      let withTemperature = true;
      for (let attempt = 0; ; attempt++) {
        const prompt = format.type === 'json_object' ? `${user}\n\nAnswer with one JSON object following this JSON Schema:\n${JSON.stringify(schema)}` : user;
        const res = await fetch(`${base}/chat/completions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
          body: JSON.stringify({
            model, messages: [{ role: 'system', content: system }, { role: 'user', content: prompt }],
            response_format: format, max_completion_tokens: maxOutputTokens, ...(withTemperature ? { temperature } : {}),
          }),
        });
        const data = await res.json().catch(() => ({}));
        const message = data?.error?.message ?? res.statusText;
        // Reasoning models take no temperature; some servers know no json_schema: ask again without.
        if (res.status === 400 && withTemperature && /temperature/i.test(message)) { withTemperature = false; attempt--; continue; }
        if (res.status === 400 && format.type === 'json_schema' && /response_format|json_schema/i.test(message)) { format = { type: 'json_object' }; attempt--; continue; }
        if ((res.status === 429 || res.status >= 500) && attempt < retries) { await backoff(attempt); continue; }
        if (!res.ok) throw new Error(`${model} ${res.status}: ${message}`);
        const choice = data.choices?.[0];
        if (choice?.finish_reason && !['stop', 'tool_calls'].includes(choice.finish_reason)) throw new Error(`${model} stopped with ${choice.finish_reason}.`);
        const u = data.usage ?? {};
        return {
          json: parseJson(model, choice?.message?.content ?? ''),
          usage: { input: u.prompt_tokens ?? 0, output: u.completion_tokens ?? 0, thinking: u.completion_tokens_details?.reasoning_tokens ?? 0, cached: u.prompt_tokens_details?.cached_tokens ?? 0 },
          model: data.model ?? model,
        };
      }
    },
  };
}
openaiProvider.models = async ({ apiKey, baseUrl = 'https://api.openai.com/v1', fetch = globalThis.fetch }) => {
  const res = await fetch(`${baseUrl.replace(/\/$/, '')}/models`, { headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {} });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${res.status}: ${data?.error?.message ?? res.statusText}`);
  return (data.data ?? []).map((m) => ({ id: m.id, label: m.id })).sort((a, b) => a.id.localeCompare(b.id));
};

/** Anthropic Messages API: the answer is the input of a tool whose schema is the answer schema. */
export function anthropicProvider({ apiKey, model = 'claude-sonnet-5-5', baseUrl = 'https://api.anthropic.com/v1', fetch = globalThis.fetch, retries = 3 } = {}) {
  if (!apiKey) throw new Error('No Anthropic API key: set ANTHROPIC_API_KEY.');
  const base = baseUrl.replace(/\/$/, '');
  return {
    name: 'anthropic',
    model,
    async complete({ system, user, schema, temperature = 0, maxOutputTokens = 32000 }) {
      for (let attempt = 0; ; attempt++) {
        const res = await fetch(`${base}/messages`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
          body: JSON.stringify({
            model, system, max_tokens: maxOutputTokens, temperature,
            messages: [{ role: 'user', content: user }],
            tools: [{ name: 'answer', description: 'Give the answer.', input_schema: schema }],
            tool_choice: { type: 'tool', name: 'answer' },
          }),
        });
        const data = await res.json().catch(() => ({}));
        if ((res.status === 429 || res.status === 529 || res.status >= 500) && attempt < retries) { await backoff(attempt); continue; }
        if (!res.ok) throw new Error(`Anthropic ${res.status}: ${data?.error?.message ?? res.statusText}`);
        if (data.stop_reason === 'max_tokens') throw new Error('Anthropic stopped with max_tokens.');
        const call = (data.content ?? []).find((c) => c.type === 'tool_use');
        if (!call) throw new Error(`Anthropic returned no answer (${data.stop_reason}).`);
        const u = data.usage ?? {};
        return { json: call.input, usage: { input: u.input_tokens ?? 0, output: u.output_tokens ?? 0, thinking: 0, cached: u.cache_read_input_tokens ?? 0 }, model: data.model ?? model };
      }
    },
  };
}
anthropicProvider.models = async ({ apiKey, baseUrl = 'https://api.anthropic.com/v1', fetch = globalThis.fetch }) => {
  const res = await fetch(`${baseUrl.replace(/\/$/, '')}/models?limit=100`, { headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Anthropic ${res.status}: ${data?.error?.message ?? res.statusText}`);
  return (data.data ?? []).map((m) => ({ id: m.id, label: m.display_name ?? m.id }));
};

/**
 * The providers a person can choose, and where their settings live in the
 * environment. The key of each comes from its own variable; N20S_AI_PROVIDER,
 * N20S_AI_MODEL and N20S_AI_BASE_URL say which one, which model and where.
 */
export const PROVIDERS = {
  gemini: { label: 'Google Gemini', make: geminiProvider, keyVar: 'GEMINI_API_KEY', model: 'gemini-2.5-flash', baseUrl: 'https://generativelanguage.googleapis.com/v1beta' },
  anthropic: { label: 'Anthropic Claude', make: anthropicProvider, keyVar: 'ANTHROPIC_API_KEY', model: 'claude-sonnet-5-5', baseUrl: 'https://api.anthropic.com/v1' },
  openai: { label: 'OpenAI or compatible (Mistral, OpenRouter, Ollama…)', make: openaiProvider, keyVar: 'OPENAI_API_KEY', model: null, baseUrl: 'https://api.openai.com/v1', keyOptional: true },
};

/** A provider from explicit settings: {provider, apiKey, model, baseUrl}. */
export function makeProvider({ provider = 'gemini', apiKey, model, baseUrl, fetch } = {}) {
  const p = PROVIDERS[provider];
  if (!p) throw new Error(`Unknown AI provider ${provider}: ${Object.keys(PROVIDERS).join(', ')}.`);
  if (!apiKey && !p.keyOptional) throw new Error(`No API key for ${p.label}: set ${p.keyVar}.`);
  return p.make({ apiKey, model: model || p.model || undefined, baseUrl: baseUrl || p.baseUrl, ...(fetch ? { fetch } : {}) });
}

/** Models a provider offers with these settings; checks the key without spending tokens. */
export function listModels({ provider = 'gemini', apiKey, baseUrl, fetch } = {}) {
  const p = PROVIDERS[provider];
  if (!p) throw new Error(`Unknown AI provider ${provider}.`);
  return p.make.models({ apiKey, baseUrl: baseUrl || p.baseUrl, ...(fetch ? { fetch } : {}) });
}

/**
 * AI settings from the environment: N20S_AI_PROVIDER, else the first provider
 * whose key is set (Gemini first). Null when there is none.
 */
export function aiSettingsFromEnv(env = globalThis.process?.env ?? {}, { provider, model } = {}) {
  const id = provider || env.N20S_AI_PROVIDER || Object.keys(PROVIDERS).find((k) => env[PROVIDERS[k].keyVar]) || null;
  if (!id || !PROVIDERS[id]) return null;
  const p = PROVIDERS[id];
  const apiKey = env[p.keyVar] || null;
  if (!apiKey && !(p.keyOptional && env.N20S_AI_BASE_URL)) return null;
  return { provider: id, apiKey, model: model || env.N20S_AI_MODEL || p.model, baseUrl: env.N20S_AI_BASE_URL || p.baseUrl };
}

/** Key of a request: the same prompt and schema always give the same key. */
export async function requestKey({ system, user, schema }) {
  const bytes = new TextEncoder().encode(JSON.stringify([system, user, schema]));
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Wraps a provider and keeps every answer, keyed by request, for replay. */
export function recordingProvider(inner, recording = { format: RECORDING_FORMAT, provider: inner.name, model: inner.model, calls: [] }) {
  return {
    name: inner.name,
    model: inner.model,
    recording,
    async complete(req) {
      const res = await inner.complete(req);
      recording.calls.push({ key: await requestKey(req), element: req.element ?? null, json: res.json, usage: res.usage, model: res.model });
      return res;
    },
  };
}

/** Answers from a recording, for tests and for re-running an evaluation offline. */
export function replayProvider(recording) {
  if (recording?.format !== RECORDING_FORMAT) throw new Error(`Not a recording (format ${recording?.format}).`);
  // Several answers to one request (several passes) are given back in the order they were recorded.
  const byKey = new Map();
  for (const c of recording.calls) byKey.set(c.key, [...(byKey.get(c.key) ?? []), c]);
  const used = new Map();
  return {
    name: recording.provider,
    model: recording.model,
    async complete(req) {
      const key = await requestKey(req);
      const list = byKey.get(key) ?? [];
      const i = used.get(key) ?? 0;
      used.set(key, i + 1);
      const c = list[Math.min(i, list.length - 1)];
      if (!c) throw new Error(`The recording has no answer for ${req.element ?? 'this request'}: the prompt changed since it was recorded.`);
      return { json: c.json, usage: c.usage, model: c.model };
    },
  };
}

/** A provider that answers with a function of the request, for unit tests. */
export function functionProvider(answer, { name = 'function', model = 'test' } = {}) {
  return { name, model, async complete(req) { return { json: await answer(req), usage: { input: 0, output: 0 }, model }; } };
}
