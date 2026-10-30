import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { callOpenRouter, callOpenRouterTurn, OpenRouterError } from '../src/openrouter.js';
import { DEFAULT_CONFIG, saveOpenRouterKey } from '../src/config.js';

const apiKey = 'test-only-private-openrouter-key';
const schema = { type: 'object', properties: { questions: { type: 'array' } }, required: ['questions'], additionalProperties: false };
const result = { questions: [] };
// Retry backoff is recorded rather than slept; retry tests inspect the waits.
const defaults = { prompt: 'Assess only the supplied snapshot.', schema, config: structuredClone(DEFAULT_CONFIG), env: { OPENROUTER_API_KEY: apiKey }, sleep: async () => {} };
const success = (content = JSON.stringify(result), finish_reason = 'stop') => Response.json({ choices: [{ finish_reason, message: { content } }] });

test('default OpenRouter request requires zero-priced structured output and enforces the token budget', async () => {
  let calls = 0;
  let captured;
  const actual = await callOpenRouter({ ...defaults, fetchImpl: async (url, init) => { calls++; captured = { url, init }; return success(); } });
  assert.deepEqual(actual, result);
  assert.equal(calls, 1);
  assert.equal(captured.url, 'https://openrouter.ai/api/v1/chat/completions');
  assert.equal(captured.init.method, 'POST');
  assert.equal(captured.init.redirect, 'error');
  assert.equal(captured.init.headers.Authorization, `Bearer ${apiKey}`);
  assert.ok(captured.init.signal instanceof AbortSignal);
  const body = JSON.parse(captured.init.body);
  assert.equal(body.model, 'openrouter/free');
  assert.deepEqual(body.provider, { require_parameters: true, max_price: { prompt: 0, completion: 0, request: 0 } });
  assert.equal(body.max_completion_tokens, DEFAULT_CONFIG.maxOutputTokens);
  assert.equal(body.reasoning, undefined, 'Do not require reasoning support on otherwise compatible models');
  assert.equal(body.stream, false);
  assert.equal(body.response_format.type, 'json_schema');
  assert.equal(body.response_format.json_schema.strict, true);
  assert.deepEqual(body.response_format.json_schema.schema, schema);
  assert.equal(body.messages[1].content, defaults.prompt);
  assert.ok(!captured.init.body.includes(apiKey));
  assert.equal(body.models, undefined, 'No implicit fallback model list');
});

test('free selections retain zero-price caps even when paid routes are enabled elsewhere', async () => {
  for (const model of ['openrouter/free', 'vendor/model:free']) {
    let body;
    await callOpenRouter({ ...defaults, config: { ...defaults.config, allowPaid: true, model, maxOutputTokens: 768 }, fetchImpl: async (_url, init) => { body = JSON.parse(init.body); return success(); } });
    assert.equal(body.model, model);
    assert.equal(body.max_completion_tokens, 768);
    assert.deepEqual(body.provider.max_price, { prompt: 0, completion: 0, request: 0 });
  }
});

test('paid models require explicit configuration and never silently substitute another model', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls++; return success(); };
  await assert.rejects(callOpenRouter({ ...defaults, config: { ...defaults.config, model: 'vendor/paid-model' }, fetchImpl }), /Paid OpenRouter model.*disabled/);
  assert.equal(calls, 0);
  let body;
  await callOpenRouter({ ...defaults, config: { ...defaults.config, model: 'vendor/paid-model', allowPaid: true, effort: 'low' }, fetchImpl: async (_url, init) => { body = JSON.parse(init.body); return success(); } });
  assert.equal(body.model, 'vendor/paid-model');
  assert.equal(body.provider.max_price, undefined);
  assert.equal(body.reasoning, undefined, 'CLI effort must not impose reasoning support on a selected OpenRouter model');
  assert.equal(body.reasoning_effort, undefined);
});

test('missing authentication fails before a request and an isolated saved key is reused', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'sphinx-openrouter-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const env = { SPHINX_HOME: directory, SPHINX_USER_HOME: directory };
  let calls = 0;
  const fetchImpl = async () => { calls++; return success(); };
  await assert.rejects(callOpenRouter({ ...defaults, env, fetchImpl }), /requires an API key/);
  assert.equal(calls, 0);
  await saveOpenRouterKey(apiKey, env);
  await callOpenRouter({ ...defaults, env, fetchImpl: async (_url, init) => { assert.equal(init.headers.Authorization, `Bearer ${apiKey}`); return success(); } });
});

test('HTTP errors remain actionable without exposing authentication or the provider response body', async () => {
  for (const [status, message, attempts] of [[401, /sphinx auth/, 1], [429, /Provider or account rate limit.*switch this check to your Claude Code or Codex plan/, 4], [400, /structured-output/, 1], [402, /insufficient credits/, 1], [503, /unavailable/, 4], [502, /Request failed/, 4], [404, /No compatible provider/, 4]]) {
    let calls = 0;
    await assert.rejects(callOpenRouter({ ...defaults, fetchImpl: async () => { calls++; return new Response(`server diagnostic ${apiKey}`, { status }); } }), error => {
      assert.match(error.message, message);
      assert.match(error.message, attempts === 1 ? /did not retry automatically/ : /after 4 attempts; Sphinx retried with backoff\./);
      assert.ok(!error.message.includes(apiKey));
      return true;
    });
    assert.equal(calls, attempts, 'Only transient failures retry, and never with a paid fallback');
  }
});

test('a transient 404 or 429 is retried with backoff and completes without user intervention', async () => {
  for (const status of [404, 429]) {
    let calls = 0, charges = 0;
    const waits = [], bodies = [];
    const actual = await callOpenRouter({ ...defaults, beforeCall: async () => { charges++; }, sleep: async ms => { waits.push(ms); },
      fetchImpl: async (_url, init) => { bodies.push(init.body); return ++calls === 1 ? Response.json({ error: { code: status, message: apiKey } }, { status }) : success(); } });
    assert.deepEqual(actual, result);
    assert.equal(calls, 2); assert.equal(charges, 2, 'Every attempt counts as a model call');
    assert.deepEqual(waits, [5000]);
    assert.equal(bodies[0], bodies[1], 'The retry repeats the same request on the same route');
  }
});

test('retries honor Retry-After, stop when the provider asks for a long wait, and stop at the call cap', async () => {
  let waits = [], calls = 0;
  const limited = (header, then = success) => async () => ++calls === 1 ? new Response('', { status: 429, headers: { 'Retry-After': header } }) : then();
  await callOpenRouter({ ...defaults, sleep: async ms => { waits.push(ms); }, fetchImpl: limited('20') });
  assert.deepEqual(waits, [20000]); assert.equal(calls, 2);

  waits = []; calls = 0;
  await assert.rejects(callOpenRouter({ ...defaults, sleep: async ms => { waits.push(ms); }, fetchImpl: limited('3600') }), error => {
    assert.equal(error.retryAfterSeconds, 3600);
    assert.match(error.message, /did not retry automatically/);
    return true;
  });
  assert.deepEqual(waits, []); assert.equal(calls, 1);

  waits = []; calls = 0;
  let charges = 0;
  const capped = async () => { if (++charges > 2) throw new Error('Assessment call limit (2) reached. No additional model request was made.'); };
  await assert.rejects(callOpenRouter({ ...defaults, beforeCall: capped, sleep: async ms => { waits.push(ms); }, fetchImpl: async () => { calls++; return new Response('', { status: 429 }); } }), /Assessment call limit \(2\) reached/);
  assert.equal(calls, 2); assert.deepEqual(waits, [5000, 15000]);
});

test('cancellation during retry backoff stops without another request', async () => {
  const controller = new AbortController();
  let calls = 0;
  const reason = new DOMException('Paused', 'AbortError');
  await assert.rejects(callOpenRouter({ ...defaults, signal: controller.signal,
    sleep: async () => { controller.abort(reason); throw new DOMException('aborted', 'AbortError'); },
    fetchImpl: async () => { calls++; return new Response('', { status: 503 }); } }), error => error === reason);
  assert.equal(calls, 1);
});

test('custom OpenAI-compatible endpoints do not retry a 404, which means a wrong URL or model', async () => {
  let calls = 0;
  const env = { SPHINX_OPENAI_BASE_URL: 'https://llm.example.test/v1', SPHINX_OPENAI_API_KEY: apiKey };
  await assert.rejects(callOpenRouter({ ...defaults, env, config: { ...defaults.config, provider: 'openai', model: 'local-model' }, fetchImpl: async () => { calls++; return new Response('', { status: 404 }); } }), /HTTP 404/);
  assert.equal(calls, 1);
});

test('HTTP rate-limit and availability errors expose a bounded Retry-After delay', async () => {
  for (const [status, header, seconds, attempts] of [[429, '60', 60, 4], [503, ' 1 ', 1, 4], [429, '86400', 86400, 1], [503, '0', 0, 4]]) {
    let calls = 0, charges = 0;
    await assert.rejects(callOpenRouter({ ...defaults, beforeCall: async () => { charges++; }, fetchImpl: async () => {
      calls++;
      return new Response(`private provider response ${apiKey}`, { status, headers: { 'Retry-After': header } });
    } }), error => {
      assert.ok(error instanceof OpenRouterError); assert.equal(error.status, status);
      assert.equal(error.retryAfterSeconds, seconds);
      assert.match(error.message, seconds === 0 ? /retry delay has elapsed/ : new RegExp(`Wait at least ${seconds} second`));
      assert.match(error.message, attempts === 1 ? /did not retry automatically/ : /after 4 attempts/);
      assert.ok(!JSON.stringify(error).includes(apiKey)); assert.ok(!error.message.includes(apiKey));
      return true;
    });
    assert.equal(calls, attempts); assert.equal(charges, attempts);
  }
});

test('canonical HTTP-date Retry-After survives provider error envelopes with only numeric timing metadata', async t => {
  const now = Date.UTC(2026, 9, 15, 22, 0, 0);
  t.mock.method(Date, 'now', () => now);
  for (const [data, delay] of [
    [{ error: { code: 429, message: apiKey, metadata: { error_type: 'rate_limit_exceeded' } } }, 60],
    [{ choices: [{ finish_reason: 'error', error: { code: 502, metadata: { error_type: 'provider_overloaded' } } }] }, 90],
    [{ choices: [{ finish_reason: 'error' }] }, 30],
  ]) {
    let calls = 0;
    await assert.rejects(callOpenRouter({ ...defaults, fetchImpl: async () => {
      calls++; return Response.json(data, { headers: { 'Retry-After': new Date(now + delay * 1000).toUTCString() } });
    } }), error => {
      assert.equal(error.retryAfterSeconds, delay);
      assert.equal(error.code, 'OPENROUTER_PROVIDER_ERROR');
      assert.match(error.message, new RegExp(`Wait at least ${delay} seconds`));
      assert.doesNotMatch(error.message, /GMT|2026/);
      assert.ok(!JSON.stringify(error).includes(apiKey));
      return true;
    });
    assert.equal(calls, 1);
  }
});

test('malformed, unsafe, out-of-range, and body-only retry hints never enter error metadata or messages', async t => {
  const now = Date.UTC(2026, 9, 15, 22, 0, 0);
  t.mock.method(Date, 'now', () => now);
  const data = { error: { code: 429, message: apiKey, retryAfterSeconds: 45, metadata: { retry_after: 45, raw: apiKey } } };
  for (const header of [undefined, apiKey, `Bearer ${apiKey}`, '-1', '1.5', '1e3', 'Infinity', '86401', '9'.repeat(160), '60, 120', '2026-10-15', 'Thu, 32 Oct 2026 22:00:00 GMT', 'Fri, 15 Oct 2026 22:01:00 GMT', new Date(now + 86401_000).toUTCString()]) {
    await assert.rejects(callOpenRouter({ ...defaults, fetchImpl: async () => Response.json(data, { status: 429, headers: header === undefined ? {} : { 'Retry-After': header } }) }), error => {
      assert.equal(error.retryAfterSeconds, undefined);
      assert.doesNotMatch(error.message, /Wait at least|retry delay has elapsed/);
      assert.ok(!JSON.stringify(error).includes(apiKey)); assert.ok(!error.message.includes(apiKey));
      return true;
    });
  }
});

test('retry headers do not suggest waiting as a remedy for authentication or invalid requests', async () => {
  for (const response of [
    () => Response.json({ error: { code: 401 } }, { status: 401, headers: { 'Retry-After': '60' } }),
    () => Response.json({ error: { code: 500, metadata: { error_type: 'authentication' } } }, { headers: { 'Retry-After': '60' } }),
    () => new Response(apiKey, { status: 400, headers: { 'Retry-After': '60' } }),
  ]) await assert.rejects(callOpenRouter({ ...defaults, fetchImpl: async () => response() }), error => {
    assert.equal(error.retryAfterSeconds, undefined);
    assert.doesNotMatch(error.message, /Wait at least/);
    return true;
  });
});

test('network and timeout errors do not leak request credentials', async () => {
  for (const error of [new Error(`request failed with ${apiKey}`), new DOMException(`request ${apiKey}`, 'TimeoutError')]) {
    await assert.rejects(callOpenRouter({ ...defaults, fetchImpl: async () => { throw error; } }), failure => {
      assert.match(failure.message, /Could not reach|timed out/);
      assert.ok(!failure.message.includes(apiKey));
      return true;
    });
  }
});

test('a timeout after HTTP headers identifies the response-body timeout without retrying', async () => {
  let calls = 0, charges = 0, keepAlive;
  try {
    await assert.rejects(callOpenRouter({ ...defaults, config: { ...defaults.config, timeoutSeconds: 0.02 },
      beforeCall: async () => { charges++; }, fetchImpl: async (_url, init) => {
        calls++;
        return new Response(new ReadableStream({ start(controller) {
          // Fetch can reject a timed-out body with a generic AbortError. The
          // combined request signal, not that exception's text, identifies it.
          init.signal.addEventListener('abort', () => controller.error(new DOMException(apiKey, 'AbortError')), { once: true });
          keepAlive = setTimeout(() => controller.error(new Error('Test response unexpectedly stayed open')), 1000);
        } }));
      } }), error => {
        assert.match(error.message, /timed out while reading the response body/);
        assert.match(error.message, /did not retry automatically/);
        assert.doesNotMatch(error.message, /JSON|oversized/);
        assert.ok(!error.message.includes(apiKey)); assert.equal(error.cause, undefined);
        return true;
      });
  } finally { clearTimeout(keepAlive); }
  assert.equal(calls, 1); assert.equal(charges, 1);
});

test('caller cancellation while reading a response preserves its exact abort reason', async () => {
  const caller = new AbortController(), reason = new Error('Human paused the check.');
  let calls = 0, charges = 0, timer;
  try {
    await assert.rejects(callOpenRouter({ ...defaults, signal: caller.signal,
      beforeCall: async () => { charges++; }, fetchImpl: async (_url, init) => {
        calls++;
        return new Response(new ReadableStream({ start(controller) {
          init.signal.addEventListener('abort', () => controller.error(new Error(apiKey)), { once: true });
          timer = setTimeout(() => caller.abort(reason), 5);
        } }));
      } }), error => error === reason);
  } finally { clearTimeout(timer); }
  assert.equal(calls, 1); assert.equal(charges, 1);
});

test('interrupted, oversized, and malformed bodies have distinct sanitized diagnostics and no retries', async () => {
  const cases = [
    [() => new Response(new ReadableStream({ pull(controller) { controller.error(new Error(`private transport diagnostic ${apiKey}`)); } })), /response body was interrupted before it finished/],
    [() => new Response('x'.repeat(1024 * 1024 + 1) + apiKey), /response exceeded the 1 MiB safety limit/],
    [() => new Response(`{"private":"${apiKey}"`), /returned malformed response JSON/],
  ];
  for (const [response, expected] of cases) {
    let calls = 0, charges = 0;
    await assert.rejects(callOpenRouter({ ...defaults, beforeCall: async () => { charges++; }, fetchImpl: async () => { calls++; return response(); } }), error => {
      assert.match(error.message, expected);
      assert.match(error.message, /No completion was recorded; Sphinx did not retry automatically/);
      assert.ok(!error.message.includes(apiKey)); assert.ok(!JSON.stringify(error).includes(apiKey));
      assert.equal(error.cause, undefined);
      return true;
    });
    assert.equal(calls, 1); assert.equal(charges, 1);
  }
});

test('a failed HTTP response retains status advice and Retry-After when its body is interrupted', async () => {
  let calls = 0, charges = 0;
  await assert.rejects(callOpenRouter({ ...defaults, beforeCall: async () => { charges++; }, fetchImpl: async () => {
    calls++;
    return new Response(new ReadableStream({ pull(controller) { controller.error(new Error(apiKey)); } }), { status: 429, headers: { 'Retry-After': '12' } });
  } }), error => {
    assert.ok(error instanceof OpenRouterError); assert.equal(error.status, 429); assert.equal(error.retryAfterSeconds, 12);
    assert.match(error.message, /HTTP 429: response body was interrupted/);
    assert.match(error.message, /Provider or account rate limit reached/); assert.match(error.message, /Wait at least 12 seconds/);
    assert.ok(!error.message.includes(apiKey)); assert.equal(error.cause, undefined);
    return true;
  });
  assert.equal(calls, 4); assert.equal(charges, 4);
});

test('typed provider failures expose only known categories and numeric status, including HTTP error bodies', async () => {
  const diagnostic = { code: 502, message: apiKey, metadata: { error_type: 'provider_overloaded', provider_name: apiKey, provider_code: apiKey, raw: apiKey } };
  for (const [response, attempts] of [
    [() => Response.json({ id: apiKey, error: diagnostic }), 1],
    [() => Response.json({ choices: [{ finish_reason: 'error', error: diagnostic, message: { content: apiKey } }] }), 1],
    [() => Response.json({ error: diagnostic }, { status: 502 }), 4],
  ]) {
    let charges = 0, requests = 0;
    await assert.rejects(callOpenRouter({ ...defaults, beforeCall: async () => { charges++; }, fetchImpl: async () => { requests++; return response(); } }), error => {
      assert.ok(error instanceof OpenRouterError);
      assert.equal(error.code, 'OPENROUTER_PROVIDER_ERROR');
      assert.equal(error.status, 502);
      assert.equal(error.errorType, 'provider_overloaded');
      assert.match(error.message, /code: 502; error_type: provider_overloaded/);
      assert.match(error.message, /temporarily overloaded/);
      assert.ok(!error.message.includes(apiKey));
      assert.ok(!JSON.stringify(error).includes(apiKey));
      assert.equal(error.cause, undefined);
      return true;
    });
    // Only the failed HTTP status is retried; a 200 response already generated output.
    assert.equal(charges, attempts); assert.equal(requests, attempts);
  }
});

test('unknown provider diagnostics stay unclassified and safe; typed causes take precedence over status', async () => {
  for (const diagnostic of [undefined, { code: apiKey, message: apiKey, metadata: { error_type: apiKey } }, { code: 9999, metadata: { error_type: 'constructor' } }]) {
    await assert.rejects(callOpenRouter({ ...defaults, fetchImpl: async () => Response.json({ choices: [{ finish_reason: 'error', error: diagnostic }] }) }), error => {
      assert.equal(error.code, 'OPENROUTER_PROVIDER_ERROR');
      assert.equal(error.status, undefined); assert.equal(error.errorType, undefined);
      assert.match(error.message, /no error code or category returned/);
      assert.ok(!error.message.includes(apiKey));
      return true;
    });
  }
  await assert.rejects(callOpenRouter({ ...defaults, fetchImpl: async () => Response.json({ error: { code: 500, metadata: { error_type: 'authentication' } } }, { status: 500 }) }), error => {
    assert.match(error.message, /error_type: authentication/);
    assert.match(error.message, /sphinx auth/);
    assert.doesNotMatch(error.message, /internal error/);
    return true;
  });
});

test('truncated, refused, malformed, and provider-error responses never pass', async () => {
  const cases = [
    [() => success('{"questions":', 'length'), /output limit/],
    [() => success(JSON.stringify(result), 'content_filter'), /refused or filtered/],
    [() => success('This is not JSON'), /malformed assessment JSON/],
    [() => success(null), /no assessment text/],
    [() => Response.json({ error: { message: apiKey } }), /provider error/],
    [() => new Response(`not valid json ${apiKey}`), /malformed response JSON/],
    [() => Response.json({ choices: [] }), /no completed assessment choice/],
    [() => Response.json(null), /invalid|malformed|no assessment|did not finish/i],
  ];
  for (const [response, pattern] of cases) {
    await assert.rejects(callOpenRouter({ ...defaults, fetchImpl: async () => response() }), error => {
      assert.match(error.message, pattern);
      assert.ok(!error.message.includes(apiKey));
      return true;
    });
  }
});

test('a BOM or one ```json fence parses as on the CLI routes, while prose around the JSON is still rejected', async () => {
  const json = JSON.stringify(result), fenced = '```json\n' + json + '\n```';
  for (const content of [fenced, '```\n' + json + '\n```', '\uFEFF' + json, '\uFEFF' + fenced + '\n']) {
    assert.deepEqual(await callOpenRouter({ ...defaults, fetchImpl: async () => success(content) }), result);
  }
  for (const content of ['Here is the assessment:\n' + fenced, fenced + '\nLet me know if you need more.', 'Assessment: ' + json]) {
    let calls = 0;
    await assert.rejects(callOpenRouter({ ...defaults, fetchImpl: async () => { calls++; return success(content); } }), error => {
      assert.match(error.message, /malformed assessment JSON/);
      assert.equal(error.code, 'INVALID_REVIEW_ACTION');
      return true;
    });
    assert.equal(calls, 1);
  }
});

test('output-limit errors identify the actual budget and safe usage counts without accepting partial JSON', async () => {
  let calls = 0;
  await assert.rejects(callOpenRouter({ ...defaults, config: { ...defaults.config, allowPaid: true, model: 'deepseek/deepseek-v3.2', maxOutputTokens: 2500 }, fetchImpl: async () => {
    calls++;
    return Response.json({
      choices: [{ finish_reason: 'length', native_finish_reason: apiKey, message: { content: JSON.stringify(result), reasoning: apiKey } }],
      usage: { completion_tokens: 2500, completion_tokens_details: { reasoning_tokens: 2490 } },
    });
  } }), error => {
    assert.match(error.message, /finish_reason: length; request budget: 2500 tokens, including reasoning/);
    assert.match(error.message, /2500 completion tokens, 2490 reasoning tokens/);
    assert.match(error.message, /Increase maxOutputTokens in your global Sphinx configuration/);
    assert.match(error.message, /did not retry automatically/);
    assert.ok(!error.message.includes(apiKey));
    return true;
  });
  assert.equal(calls, 1);
});

test('free-router output-limit errors name the openrouter-free preset and its budget', async () => {
  const truncated = async () => Response.json({ choices: [{ finish_reason: 'length', message: { content: '' } }], usage: { completion_tokens: 4096, completion_tokens_details: { reasoning_tokens: 4096 } } });
  await assert.rejects(callOpenRouter({ ...defaults, config: { ...defaults.config, model: 'openrouter/free', maxOutputTokens: 4096 }, fetchImpl: truncated }), error => {
    assert.match(error.message, /request budget: 4096 tokens/);
    assert.match(error.message, /openrouter-free preset needs a 16384-token output budget/);
    assert.match(error.message, /sphinx config --max-output-tokens 16384/);
    assert.match(error.message, /sphinx config --preset openrouter-free/);
    return true;
  });
  await assert.rejects(callOpenRouter({ ...defaults, config: { ...defaults.config, model: 'openrouter/free', maxOutputTokens: 16384 }, fetchImpl: truncated }), error => {
    assert.match(error.message, /openrouter-free preset already uses its 16384-token maximum/);
    assert.ok(!error.message.includes('--max-output-tokens'));
    return true;
  });
  await assert.rejects(callOpenRouter({ ...defaults, config: { ...defaults.config, allowPaid: true, model: 'deepseek/deepseek-v3.2' }, fetchImpl: truncated }), error => {
    assert.ok(!error.message.includes('openrouter-free'));
    assert.match(error.message, /Increase maxOutputTokens/);
    return true;
  });
});

test('non-budget failures have distinct advice and never recommend increasing tokens', async () => {
  const cases = [
    [{ choices: [{ finish_reason: 'content_filter', message: { content: apiKey } }] }, /refused or filtered/],
    [{ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(result), refusal: apiKey } }] }, /refused or filtered/],
    [{ choices: [{ finish_reason: 'tool_calls', message: { content: JSON.stringify(result) } }] }, /requested tool calls/],
    [{ choices: [{ finish_reason: 'error', error: { code: 429, message: apiKey } }] }, /provider error.*rate limit/],
    [{ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(result) }, error: { code: 503, message: apiKey } }] }, /provider error.*unavailable/],
    [{ error: { code: 401, message: apiKey } }, /provider error.*sphinx auth/],
    [{ choices: [{ finish_reason: apiKey, native_finish_reason: apiKey }] }, /unrecognized finish reason/],
    [{ choices: {} }, /no completed assessment choice/],
  ];
  for (const [data, pattern] of cases) {
    let calls = 0;
    await assert.rejects(callOpenRouter({ ...defaults, fetchImpl: async () => { calls++; return Response.json(data); } }), error => {
      assert.match(error.message, pattern);
      assert.match(error.message, /No completion was recorded/);
      assert.ok(!error.message.includes('maxOutputTokens'));
      assert.ok(!error.message.includes(apiKey));
      return true;
    });
    assert.equal(calls, 1);
  }
});

test('empty completed content reports reasoning usage without exposing malformed usage metadata', async () => {
  for (const content of [null, '', '   ']) {
    await assert.rejects(callOpenRouter({ ...defaults, fetchImpl: async () => Response.json({
      choices: [{ finish_reason: 'stop', message: { content, reasoning: apiKey } }],
      usage: { completion_tokens: apiKey, completion_tokens_details: { reasoning_tokens: 2500 } },
    }) }), error => {
      assert.match(error.message, /no assessment text/);
      assert.match(error.message, /2500 reasoning tokens/);
      assert.ok(!error.message.includes(apiKey));
      return true;
    });
  }
});

test('oversized API bodies are rejected even if the provider ignores its output token budget', async () => {
  await assert.rejects(callOpenRouter({
    ...defaults,
    fetchImpl: async () => success(JSON.stringify({ padding: 'x'.repeat(1024 * 1024 + 1) })),
  }), /exceeded the 1 MiB safety limit/);
});

const nativeTools = [{ type: 'function', function: { name: 'read_diff', description: 'Read an immutable diff.', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false } } }];
const nativeCall = { id: 'diff-1', type: 'function', function: { name: 'read_diff', arguments: '{"path":"worker.js"}' } };

test('native reviewer requests preserve tool calls and observations with free-only routing', async () => {
  const messages = [{ role: 'system', content: 'Use read-only tools.' }, { role: 'user', content: 'Review the change.' }, { role: 'assistant', content: null, tool_calls: [nativeCall] }, { role: 'tool', tool_call_id: 'diff-1', content: '{"text":"+return dedupe(id)"}' }];
  let body, charged = false;
  const result = await callOpenRouterTurn({ ...defaults, schema: undefined, messages, tools: nativeTools, beforeCall: async () => { charged = true; }, fetchImpl: async (_url, init) => {
    assert.equal(charged, true); body = JSON.parse(init.body);
    return Response.json({ choices: [{ finish_reason: 'tool_calls', message: { content: null, tool_calls: [nativeCall], reasoning_details: [{ type: 'reasoning.encrypted', data: 'opaque-provider-state' }] } }] });
  } });
  assert.deepEqual(body.messages, messages);
  assert.deepEqual(body.tools, nativeTools);
  assert.equal(body.response_format, undefined);
  assert.equal(body.tool_choice, 'required');
  assert.deepEqual(body.provider.max_price, { prompt: 0, completion: 0, request: 0 });
  assert.deepEqual(result.calls, [{ id: 'diff-1', name: 'read_diff', arguments: { path: 'worker.js' } }]);
  assert.deepEqual(result.message.reasoning_details, [{ type: 'reasoning.encrypted', data: 'opaque-provider-state' }]);
});

test('forced final synthesis preserves history schemas while selecting exactly one finish tool', async () => {
  const finishTool = { type: 'function', function: { name: 'finish_review', parameters: { type: 'object', properties: {}, additionalProperties: false } } };
  const toolChoice = { type: 'function', function: { name: 'finish_review' } };
  const tools = [...nativeTools, finishTool];
  const messages = [{ role: 'assistant', content: null, tool_calls: [nativeCall] }, { role: 'tool', tool_call_id: 'diff-1', content: 'immutable code observation' }];
  const finishCall = { id: 'finish-1', type: 'function', function: { name: 'finish_review', arguments: '{}' } };
  let requests = 0, charges = 0;
  const options = { ...defaults, schema: undefined, messages, tools, toolChoice, beforeCall: async () => { charges++; } };
  const response = await callOpenRouterTurn({ ...options, fetchImpl: async (_url, init) => {
    requests++;
    const body = JSON.parse(init.body);
    assert.deepEqual(body.tools, tools); assert.deepEqual(body.messages, messages);
    assert.deepEqual(body.tool_choice, toolChoice);
    assert.deepEqual(body.provider.max_price, { prompt: 0, completion: 0, request: 0 });
    return Response.json({ choices: [{ finish_reason: 'tool_calls', message: { tool_calls: [finishCall] } }] });
  } });
  assert.deepEqual(response.calls, [{ id: 'finish-1', name: 'finish_review', arguments: {} }]);
  assert.equal(requests, 1); assert.equal(charges, 1);
  for (const tool_calls of [[nativeCall], [finishCall, nativeCall], [finishCall, { ...finishCall, id: 'finish-2' }]]) {
    await assert.rejects(callOpenRouterTurn({ ...options, fetchImpl: async () => Response.json({ choices: [{ finish_reason: 'tool_calls', message: { tool_calls } }] }) }), /did not return the required reviewer tool.*No tools.*executed/);
  }
});

test('Anthropic investigative and final requests use auto while other models retain wire tool constraints', async () => {
  const finishTool = { type: 'function', function: { name: 'finish_review', parameters: { type: 'object', properties: {}, additionalProperties: false } } };
  const tools = [...nativeTools, finishTool];
  const finishChoice = { type: 'function', function: { name: 'finish_review' } };
  const finishCall = { id: 'finish-1', type: 'function', function: { name: 'finish_review', arguments: '{}' } };
  for (const model of ['anthropic/claude-haiku-5.5', 'anthropic/claude-haiku-4.5', 'qwen/qwen3-coder-next', 'openrouter/free']) {
    for (const final of [false, true]) {
      let requests = 0, charges = 0;
      const expected = final ? finishCall : nativeCall;
      const result = await callOpenRouterTurn({ ...defaults, schema: undefined, config: { ...defaults.config, model, allowPaid: true },
        messages: [{ role: 'user', content: 'Investigate the supplied immutable evidence.' }], tools, ...(final ? { toolChoice: finishChoice } : {}),
        beforeCall: async () => { charges++; }, fetchImpl: async (_url, init) => {
          requests++;
          const body = JSON.parse(init.body);
          assert.equal(body.model, model); assert.deepEqual(body.tools, tools);
          assert.deepEqual(body.tool_choice, model.startsWith('anthropic/') ? 'auto' : final ? finishChoice : 'required');
          assert.equal(body.provider.require_parameters, true);
          assert.deepEqual(body.provider.max_price, model === 'openrouter/free' ? { prompt: 0, completion: 0, request: 0 } : undefined);
          assert.equal(body.max_completion_tokens, defaults.config.maxOutputTokens);
          assert.equal(body.models, undefined); assert.equal(body.reasoning, undefined);
          return Response.json({ choices: [{ finish_reason: 'tool_calls', message: { tool_calls: [expected] } }] });
        },
      });
      assert.equal(result.calls[0].name, expected.function.name);
      assert.equal(requests, 1); assert.equal(charges, 1);
    }
  }
});

test('Anthropic auto selection never accepts text-only output or an unrelated final tool', async () => {
  const finishTool = { type: 'function', function: { name: 'finish_review', parameters: { type: 'object', properties: {}, additionalProperties: false } } };
  const finishChoice = { type: 'function', function: { name: 'finish_review' } };
  const finishCall = { id: 'finish-1', type: 'function', function: { name: 'finish_review', arguments: '{}' } };
  for (const [final, toolCalls] of [[false, []], [true, []], [true, [nativeCall]], [true, [finishCall, nativeCall]]]) {
    let requests = 0, charges = 0;
    await assert.rejects(callOpenRouterTurn({ ...defaults, schema: undefined, messages: [],
      config: { ...defaults.config, model: 'anthropic/claude-haiku-5.5', allowPaid: true }, tools: [...nativeTools, finishTool],
      ...(final ? { toolChoice: finishChoice } : {}), beforeCall: async () => { charges++; },
      fetchImpl: async (_url, init) => {
        requests++; assert.equal(JSON.parse(init.body).tool_choice, 'auto');
        return Response.json({ choices: [{ finish_reason: toolCalls.length ? 'tool_calls' : 'stop', message: { content: apiKey, tool_calls: toolCalls } }] });
      },
    }), error => {
      assert.equal(error.code, 'INVALID_REVIEW_ACTION');
      assert.match(error.message, toolCalls.length ? /did not return the required reviewer tool.*No tools.*executed/ : /returned 0 reviewer tool calls/);
      assert.ok(!error.message.includes(apiKey));
      return true;
    });
    assert.equal(requests, 1); assert.equal(charges, 1);
  }
});

test('invalid forced tools fail before any budget charge or request', async () => {
  let requests = 0, charges = 0;
  for (const toolChoice of ['none', {}, null, { type: 'function', function: { name: 'shell' } }, { type: 'function', function: { name: 'read_diff', extra: apiKey } }]) {
    await assert.rejects(callOpenRouterTurn({ ...defaults, schema: undefined, messages: [], tools: nativeTools, toolChoice,
      beforeCall: async () => { charges++; }, fetchImpl: async () => { requests++; return success(); },
    }), /required reviewer tool/);
  }
  assert.equal(requests, 0); assert.equal(charges, 0);
});

test('native reviewer accepts bounded multi-tool batches, including completed stop responses with no text', async () => {
  for (const count of [3, 8]) for (const finish_reason of ['tool_calls', 'stop']) {
    const tool_calls = Array.from({ length: count }, (_, index) => ({ ...nativeCall, id: `read-${index}` }));
    let requests = 0, charges = 0;
    const response = await callOpenRouterTurn({ ...defaults, schema: undefined, messages: [], tools: nativeTools,
      beforeCall: async () => { charges++; }, fetchImpl: async (_url, init) => {
        requests++;
        const body = JSON.parse(init.body);
        assert.equal(body.tool_choice, 'required');
        assert.equal(body.models, undefined);
        assert.deepEqual(body.provider.max_price, { prompt: 0, completion: 0, request: 0 });
        return Response.json({ choices: [{ finish_reason, message: { content: null, tool_calls } }] });
      },
    });
    assert.equal(response.calls.length, count);
    assert.equal(response.message.tool_calls.length, count);
    assert.equal(requests, 1); assert.equal(charges, 1);
  }
});

test('native batch failures distinguish zero calls from overflow without disclosing output or retrying', async () => {
  for (const finish_reason of ['stop', 'tool_calls']) for (const count of [0, 9]) {
    let requests = 0, charges = 0;
    const tool_calls = Array.from({ length: count }, (_, index) => ({ ...nativeCall, id: `read-${index}` }));
    await assert.rejects(callOpenRouterTurn({ ...defaults, schema: undefined, messages: [], tools: nativeTools,
      beforeCall: async () => { charges++; }, fetchImpl: async () => {
        requests++;
        return Response.json({ choices: [{ finish_reason, message: { content: apiKey, reasoning: apiKey, tool_calls } }], usage: { completion_tokens: 120, completion_tokens_details: { reasoning_tokens: 100 } } });
      },
    }), error => {
      assert.equal(error.code, 'INVALID_REVIEW_ACTION');
      assert.equal(error.recoverable, true);
      assert.match(error.message, new RegExp(`returned ${count} reviewer tool calls`));
      assert.ok(error.message.includes(`finish_reason: ${finish_reason}`));
      assert.match(error.message, /120 completion tokens, 100 reasoning tokens/);
      assert.match(error.message, count === 0 ? /requires a workspace call or finish_review/ : /batch limit of 8.*No tools from this response were executed/);
      assert.match(error.message, /did not retry automatically/);
      assert.ok(!error.message.includes(apiKey));
      return true;
    });
    assert.equal(requests, 1); assert.equal(charges, 1);
  }
});

test('native reviewer rejects fabricated tools, malformed arguments, duplicate IDs and partial output', async () => {
  const cases = [
    { tool_calls: [{ ...nativeCall, function: { name: 'shell', arguments: '{}' } }] },
    { tool_calls: [{ ...nativeCall, function: { name: 'read_diff', arguments: '{' } }] },
    { tool_calls: [{ ...nativeCall, function: { name: 'read_diff', arguments: '[]' } }] },
    { tool_calls: [nativeCall, nativeCall] },
    { tool_calls: [] },
  ];
  for (const message of cases) await assert.rejects(callOpenRouterTurn({ ...defaults, schema: undefined, messages: [], tools: nativeTools, fetchImpl: async () => Response.json({ choices: [{ finish_reason: 'tool_calls', message }] }) }));
  await assert.rejects(callOpenRouterTurn({ ...defaults, schema: undefined, messages: [], tools: nativeTools, fetchImpl: async () => Response.json({ choices: [{ finish_reason: 'length', message: { tool_calls: [nativeCall] } }] }) }), /output limit/);
});

test('native reviewer preserves raw reasoning continuation when structured details are absent', async () => {
  for (const field of ['reasoning', 'reasoning_content']) {
    const response = await callOpenRouterTurn({ ...defaults, schema: undefined, messages: [], tools: nativeTools, fetchImpl: async () => Response.json({ choices: [{ finish_reason: 'tool_calls', message: { content: null, tool_calls: [nativeCall], [field]: 'opaque continuation text' } }] }) });
    assert.equal(response.message.reasoning, 'opaque continuation text');
  }
});

test('all request types await the budget callback and cancellation prevents network access', async () => {
  let requests = 0;
  const fetchImpl = async () => { requests++; return success(); };
  for (const call of [callOpenRouter, callOpenRouterTurn]) {
    await assert.rejects(call({ ...defaults, messages: [], tools: nativeTools, fetchImpl, beforeCall: async () => { throw new Error('budget exhausted'); } }), /budget exhausted/);
    const controller = new AbortController(); controller.abort(new Error('human cancelled'));
    await assert.rejects(call({ ...defaults, messages: [], tools: nativeTools, fetchImpl, signal: controller.signal }), /human cancelled/);
  }
  assert.equal(requests, 0);
});
