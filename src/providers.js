// AI providers behind one method:
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
