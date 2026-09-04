#!/usr/bin/env node

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline/promises');
const { DatabaseSync } = require('node:sqlite');

const DEFAULT_PROMPT = 'Explain why low-latency inference matters in exactly 100 words.';
const DEFAULT_DB_PATH = path.join('db', 'inference-speed-test.sqlite');

function loadEnv(file = path.join(process.cwd(), '.env')) {
  if (!fs.existsSync(file)) return;

  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)?\s*$/);
    if (!match || process.env[match[1]] !== undefined) continue;
    let value = match[2] || '';
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    } else {
      value = value.replace(/\s+#.*$/, '').trim();
    }
    process.env[match[1]] = value.replace(/\\n/g, '\n');
  }
}

function parseArgs(argv) {
  const options = {
    command: 'benchmark',
    runs: 3,
    maxTokens: 128,
    temperature: 0,
    timeout: 120_000,
    prompt: DEFAULT_PROMPT,
    models: [],
    dbPath: process.env.SPEED_TEST_DB || DEFAULT_DB_PATH,
  };

  const args = [...argv];
  if (args[0] === 'models' || args[0] === 'list') options.command = args.shift();
  if (args[0] === 'benchmark' || args[0] === 'run') args.shift();

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    const next = () => {
      if (i + 1 >= args.length) throw new Error(`Missing value for ${arg}`);
      return args[++i];
    };

    switch (arg) {
      case '-h': case '--help': options.help = true; break;
      case '-l': case '--list-models': options.command = 'models'; break;
      case '-m': case '--model': options.models.push(next()); break;
      case '-a': case '--all': options.all = true; break;
      case '-r': case '--runs': options.runs = positiveInteger(next(), arg); break;
      case '-p': case '--prompt': options.prompt = next(); break;
      case '--max-tokens': options.maxTokens = positiveInteger(next(), arg); break;
      case '--temperature': options.temperature = finiteNumber(next(), arg); break;
      case '--timeout': options.timeout = positiveInteger(next(), arg) * 1000; break;
      case '--db': options.dbPath = next(); break;
      case '--json': options.json = true; break;
      case '--show-output': options.showOutput = true; break;
      default: throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return options;
}

function positiveInteger(value, flag) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) throw new Error(`${flag} must be a positive integer`);
  return number;
}

function finiteNumber(value, flag) {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error(`${flag} must be a number`);
  return number;
}

function configFromEnv() {
  const baseUrl = process.env.CHAT_LLM_BASE_URL?.replace(/\/+$/, '');
  const apiKey = process.env.CHAT_LLM_API_KEY;
  if (!baseUrl) throw new Error('CHAT_LLM_BASE_URL is not set (add it to .env or your shell)');
  if (!apiKey) throw new Error('CHAT_LLM_API_KEY is not set (add it to .env or your shell)');
  try { new URL(baseUrl); } catch { throw new Error('CHAT_LLM_BASE_URL must be a valid URL'); }
  return { baseUrl, apiKey };
}

function headers(apiKey) {
  return { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' };
}

function providerFromBaseUrl(baseUrl) {
  const hostname = new URL(baseUrl).hostname.toLowerCase();
  if (hostname === 'localhost' || /^[\d.:]+$/.test(hostname)) return hostname;
  const parts = hostname.replace(/^www\./, '').split('.');
  return parts.length > 1 ? parts[parts.length - 2] : parts[0];
}

function openResultsDatabase(file = process.env.SPEED_TEST_DB || DEFAULT_DB_PATH) {
  if (file !== ':memory:') {
    fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  }
  const database = new DatabaseSync(file);
  database.exec(`
    CREATE TABLE IF NOT EXISTS speed_tests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      provider TEXT NOT NULL,
      base_url_host TEXT NOT NULL,
      model TEXT NOT NULL,
      run_number INTEGER NOT NULL,
      ttft_ms REAL NOT NULL,
      total_ms REAL NOT NULL,
      completion_tokens INTEGER NOT NULL,
      tokens_estimated INTEGER NOT NULL CHECK (tokens_estimated IN (0, 1)),
      tokens_per_second REAL NOT NULL,
      chunks INTEGER NOT NULL,
      characters INTEGER NOT NULL,
      max_tokens INTEGER NOT NULL,
      temperature REAL NOT NULL,
      prompt TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS speed_tests_model_created_at
      ON speed_tests (model, created_at);
    CREATE INDEX IF NOT EXISTS speed_tests_provider_created_at
      ON speed_tests (provider, created_at);
  `);
  return database;
}

function saveResult(database, result, config, options) {
  const provider = providerFromBaseUrl(config.baseUrl);
  const baseUrlHost = new URL(config.baseUrl).host;
  const saved = database.prepare(`
    INSERT INTO speed_tests (
      provider, base_url_host, model, run_number, ttft_ms, total_ms,
      completion_tokens, tokens_estimated, tokens_per_second, chunks,
      characters, max_tokens, temperature, prompt
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    provider,
    baseUrlHost,
    result.model,
    result.run,
    result.ttftMs,
    result.totalMs,
    result.tokens,
    result.tokensEstimated ? 1 : 0,
    result.tokensPerSecond,
    result.chunks,
    result.characters,
    options.maxTokens,
    options.temperature,
    options.prompt,
  );
  return Number(saved.lastInsertRowid);
}

async function fetchModels(config, timeout) {
  const response = await fetch(`${config.baseUrl}/models`, {
    headers: headers(config.apiKey),
    signal: AbortSignal.timeout(timeout),
  });
  if (!response.ok) throw await httpError(response, 'Could not list models');
  const payload = await response.json();
  const rawModels = Array.isArray(payload) ? payload : payload.data;
  if (!Array.isArray(rawModels)) throw new Error('The models endpoint returned an unexpected response');
  return [...new Set(rawModels.map((model) => typeof model === 'string' ? model : model.id).filter(Boolean))].sort();
}

/**
 * List the model IDs available to the configured API key.
 *
 * When called without arguments, this loads CHAT_LLM_BASE_URL and
 * CHAT_LLM_API_KEY from the current process or its .env file.
 */
async function listModels(config, timeout = 120_000) {
  if (!config) {
    loadEnv();
    config = configFromEnv();
  }
  return fetchModels(config, timeout);
}

async function chooseModel(models) {
  if (models.length === 0) throw new Error('The API returned no models');
  process.stdout.write('\nAvailable models:\n');
  models.forEach((model, index) => process.stdout.write(`  ${index + 1}. ${model}\n`));
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question(`\nSelect a model [1]: `)).trim() || '1';
    const selection = Number(answer);
    if (!Number.isInteger(selection) || selection < 1 || selection > models.length) {
      throw new Error(`Choose a number from 1 to ${models.length}`);
    }
    return models[selection - 1];
  } finally {
    rl.close();
  }
}

async function benchmark(config, model, options, runNumber) {
  const started = performance.now();
  let firstTokenAt;
  let text = '';
  let chunkCount = 0;
  let completionTokens;

  const response = await fetch(`${config.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: headers(config.apiKey),
    signal: AbortSignal.timeout(options.timeout),
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: options.prompt }],
      max_tokens: options.maxTokens,
      temperature: options.temperature,
      stream: true,
      stream_options: { include_usage: true },
    }),
  });
  if (!response.ok) throw await httpError(response, `Inference failed for ${model}`);
  if (!response.body) throw new Error('The inference response did not include a stream');

  const decoder = new TextDecoder();
  let buffer = '';
  for await (const bytes of response.body) {
    buffer += decoder.decode(bytes, { stream: true });
    const events = buffer.split(/\r?\n\r?\n/);
    buffer = events.pop() || '';
    for (const event of events) {
      const parsed = parseSseEvent(event);
      if (!parsed) continue;
      if (parsed.usage?.completion_tokens != null) completionTokens = parsed.usage.completion_tokens;
      const content = parsed.choices?.[0]?.delta?.content;
      if (typeof content === 'string' && content.length > 0) {
        if (firstTokenAt === undefined) firstTokenAt = performance.now();
        chunkCount += 1;
        text += content;
        if (options.showOutput && !options.json) process.stdout.write(content);
      }
    }
  }

  const ended = performance.now();
  if (firstTokenAt === undefined) firstTokenAt = ended;
  const estimated = completionTokens == null;
  const tokens = completionTokens ?? Math.max(1, Math.round(text.length / 4));
  const generationSeconds = Math.max((ended - firstTokenAt) / 1000, 0.001);
  return {
    model,
    run: runNumber,
    ttftMs: firstTokenAt - started,
    totalMs: ended - started,
    tokens,
    tokensEstimated: estimated,
    tokensPerSecond: tokens / generationSeconds,
    chunks: chunkCount,
    characters: text.length,
  };
}

function parseSseEvent(event) {
  const data = event.split(/\r?\n/)
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trimStart())
    .join('\n');
  if (!data || data === '[DONE]') return null;
  try { return JSON.parse(data); } catch { return null; }
}

async function httpError(response, context) {
  const body = (await response.text()).slice(0, 500).replace(/\s+/g, ' ').trim();
  return new Error(`${context}: HTTP ${response.status}${body ? ` — ${body}` : ''}`);
}

function mean(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function summarize(model, results) {
  return {
    model,
    runs: results.length,
    avgTtftMs: mean(results.map((result) => result.ttftMs)),
    avgTotalMs: mean(results.map((result) => result.totalMs)),
    avgTokensPerSecond: mean(results.map((result) => result.tokensPerSecond)),
    tokensEstimated: results.some((result) => result.tokensEstimated),
  };
}

function printResult(result) {
  const estimate = result.tokensEstimated ? '~' : '';
  process.stdout.write(
    `  Run ${result.run}: TTFT ${result.ttftMs.toFixed(0)} ms | ` +
    `${estimate}${result.tokensPerSecond.toFixed(1)} tok/s | ` +
    `${result.totalMs.toFixed(0)} ms total | ${estimate}${result.tokens} tokens\n`,
  );
}

function printSummary(summaries) {
  process.stdout.write('\nSummary\n');
  process.stdout.write(`${'Model'.padEnd(32)} ${'TTFT'.padStart(10)} ${'Speed'.padStart(14)} ${'Total'.padStart(11)}\n`);
  for (const item of summaries) {
    const estimate = item.tokensEstimated ? '~' : '';
    process.stdout.write(
      `${truncate(item.model, 32).padEnd(32)} ` +
      `${`${item.avgTtftMs.toFixed(0)} ms`.padStart(10)} ` +
      `${`${estimate}${item.avgTokensPerSecond.toFixed(1)} tok/s`.padStart(14)} ` +
      `${`${item.avgTotalMs.toFixed(0)} ms`.padStart(11)}\n`,
    );
  }
  if (summaries.some((item) => item.tokensEstimated)) {
    process.stdout.write('\n~ Token count estimated from output length because the API did not return usage.\n');
  }
}

function truncate(value, width) {
  return value.length <= width ? value : `${value.slice(0, width - 1)}…`;
}

function printHelp() {
  process.stdout.write(`Usage:
  node cli.js                         Interactively choose and test a model
  node cli.js models                  List models available with the env credentials
  node cli.js --list-models           List models using a flag
  node cli.js --model MODEL           Test one model
  node cli.js --all                   Test every available model

Options:
  -l, --list-models       List models available to the configured API key
  -m, --model MODEL       Model to test (repeatable)
  -a, --all               Test all discovered models
  -r, --runs NUMBER       Runs per model (default: 3)
  -p, --prompt TEXT       Benchmark prompt
      --max-tokens N      Maximum output tokens (default: 128)
      --temperature N     Sampling temperature (default: 0)
      --timeout SECONDS   Request timeout (default: 120)
      --db PATH           SQLite results file (default: db/inference-speed-test.sqlite)
      --show-output       Print generated text while testing
      --json              Emit machine-readable JSON
  -h, --help              Show this help

Environment:
  CHAT_LLM_BASE_URL       OpenAI-compatible API base URL, usually ending in /v1
  CHAT_LLM_API_KEY        API bearer token
  CHAT_LLM_MODEL          Optional default model
  SPEED_TEST_DB           Optional SQLite results file path
`);
}

async function main() {
  loadEnv();
  const options = parseArgs(process.argv.slice(2));
  if (options.help) return printHelp();
  const config = configFromEnv();
  const discoveredModels = await listModels(config, options.timeout);

  if (options.command === 'models' || options.command === 'list') {
    if (options.json) process.stdout.write(`${JSON.stringify(discoveredModels, null, 2)}\n`);
    else discoveredModels.forEach((model) => process.stdout.write(`${model}\n`));
    return;
  }

  let selectedModels = options.models;
  if (options.all) selectedModels = discoveredModels;
  if (selectedModels.length === 0 && process.env.CHAT_LLM_MODEL) selectedModels = [process.env.CHAT_LLM_MODEL];
  if (selectedModels.length === 0) {
    if (!process.stdin.isTTY) throw new Error('No model selected. Use --model MODEL or --all.');
    selectedModels = [await chooseModel(discoveredModels)];
  }

  const unknownModels = selectedModels.filter((model) => !discoveredModels.includes(model));
  if (unknownModels.length && !options.json) {
    process.stderr.write(`Warning: not returned by /models: ${unknownModels.join(', ')}\n`);
  }

  const results = [];
  const database = openResultsDatabase(options.dbPath);
  try {
    for (const model of selectedModels) {
      if (!options.json) process.stdout.write(`\nBenchmarking ${model} (${options.runs} run${options.runs === 1 ? '' : 's'})\n`);
      for (let run = 1; run <= options.runs; run += 1) {
        if (options.showOutput && !options.json) process.stdout.write(`\n--- Output (run ${run}) ---\n`);
        const result = await benchmark(config, model, options, run);
        result.provider = providerFromBaseUrl(config.baseUrl);
        result.databaseId = saveResult(database, result, config, options);
        results.push(result);
        if (options.showOutput && !options.json) process.stdout.write('\n--- Metrics ---\n');
        if (!options.json) printResult(result);
      }
    }
  } finally {
    database.close();
  }

  const summaries = selectedModels.map((model) => summarize(model, results.filter((result) => result.model === model)));
  if (options.json) process.stdout.write(`${JSON.stringify({ database: options.dbPath, results, summaries }, null, 2)}\n`);
  else {
    printSummary(summaries);
    process.stdout.write(`\nSaved ${results.length} result${results.length === 1 ? '' : 's'} to ${options.dbPath}\n`);
  }
}

if (require.main === module) {
  main().catch((error) => {
    const detail = error.name === 'TimeoutError' ? 'Request timed out' : error.message;
    process.stderr.write(`Error: ${detail}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  benchmark,
  fetchModels,
  listModels,
  loadEnv,
  openResultsDatabase,
  parseArgs,
  parseSseEvent,
  providerFromBaseUrl,
  saveResult,
  summarize,
};
