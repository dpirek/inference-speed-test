'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  listModels,
  openResultsDatabase,
  parseArgs,
  parseSseEvent,
  providerFromBaseUrl,
  saveResult,
  summarize,
} = require('../cli');

test('parseArgs supports benchmark options', () => {
  assert.deepEqual(parseArgs(['--model', 'alpha', '--model', 'beta', '--runs', '2', '--json']), {
    command: 'benchmark',
    runs: 2,
    maxTokens: 128,
    temperature: 0,
    timeout: 120000,
    prompt: 'Explain why low-latency inference matters in exactly 100 words.',
    models: ['alpha', 'beta'],
    dbPath: 'inference-speed-test.sqlite',
    json: true,
  });
});

test('parseArgs rejects invalid values', () => {
  assert.throws(() => parseArgs(['--runs', '0']), /positive integer/);
  assert.throws(() => parseArgs(['--wat']), /Unknown argument/);
});

test('parseSseEvent extracts OpenAI data lines', () => {
  assert.deepEqual(
    parseSseEvent('event: message\ndata: {"choices":[{"delta":{"content":"Hi"}}]}'),
    { choices: [{ delta: { content: 'Hi' } }] },
  );
  assert.equal(parseSseEvent('data: [DONE]'), null);
});

test('summarize averages benchmark results', () => {
  const summary = summarize('alpha', [
    { ttftMs: 100, totalMs: 500, tokensPerSecond: 20, tokensEstimated: false },
    { ttftMs: 200, totalMs: 700, tokensPerSecond: 30, tokensEstimated: true },
  ]);
  assert.deepEqual(summary, {
    model: 'alpha', runs: 2, avgTtftMs: 150, avgTotalMs: 600,
    avgTokensPerSecond: 25, tokensEstimated: true,
  });
});

test('listModels returns sorted, unique model IDs', async (context) => {
  const originalFetch = global.fetch;
  context.after(() => { global.fetch = originalFetch; });
  global.fetch = async (url, options) => {
    assert.equal(url, 'https://api.example.test/v1/models');
    assert.equal(options.headers.Authorization, 'Bearer secret');
    return new Response(JSON.stringify({
      data: [{ id: 'zeta' }, { id: 'alpha' }, { id: 'zeta' }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };

  const models = await listModels({
    baseUrl: 'https://api.example.test/v1',
    apiKey: 'secret',
  });
  assert.deepEqual(models, ['alpha', 'zeta']);
});

test('providerFromBaseUrl extracts the provider domain', () => {
  assert.equal(providerFromBaseUrl('https://api.openrouter.ai/v1'), 'openrouter');
  assert.equal(providerFromBaseUrl('https://api.groq.com/openai/v1'), 'groq');
  assert.equal(providerFromBaseUrl('http://localhost:8080/v1'), 'localhost');
});

test('saveResult inserts a complete speed test row', () => {
  const database = openResultsDatabase(':memory:');
  try {
    const id = saveResult(database, {
      model: 'alpha', run: 2, ttftMs: 125.5, totalMs: 725.5,
      tokens: 42, tokensEstimated: false, tokensPerSecond: 70,
      chunks: 12, characters: 168,
    }, {
      baseUrl: 'https://api.openrouter.ai/v1', apiKey: 'not-stored',
    }, {
      maxTokens: 128, temperature: 0, prompt: 'Test prompt',
    });

    const row = database.prepare('SELECT * FROM speed_tests WHERE id = ?').get(id);
    assert.equal(row.provider, 'openrouter');
    assert.equal(row.base_url_host, 'api.openrouter.ai');
    assert.equal(row.model, 'alpha');
    assert.equal(row.run_number, 2);
    assert.equal(row.completion_tokens, 42);
    assert.equal(row.prompt, 'Test prompt');
    assert.equal('api_key' in row, false);
  } finally {
    database.close();
  }
});
