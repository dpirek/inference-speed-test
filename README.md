# Inference Speed Test

A dependency-free CLI for benchmarking any OpenAI-compatible chat-completions API. It discovers the models available to your API key, measures time to first token (TTFT), total response time, and generation throughput, and saves every run to SQLite.

## Setup

Requires Node.js 22.13 or newer. Copy `.env.example` to `.env` and set:

```dotenv
CHAT_LLM_API_KEY=your-api-key
CHAT_LLM_BASE_URL=https://api.example.com/v1
```

## Usage

```sh
# List every model available to the configured key
npm run models
node cli.js --list-models

# Interactively select a model
npm start

# Benchmark specific or all models
node cli.js --model model-id --runs 5
node cli.js --all --runs 1

# Machine-readable results
node cli.js --model model-id --json

# Choose a different results database
node cli.js --model model-id --db results/benchmarks.sqlite
```

Run `node cli.js --help` for all options. If the provider omits token usage in its streaming response, the CLI marks throughput with `~` and estimates token count from output length.

Successful runs are saved to `db/inference-speed-test.sqlite` by default. The CLI creates the database directory automatically. Each row in the `speed_tests` table includes the model, provider derived from the base URL (`api.openrouter.ai` becomes `openrouter`), timings, token throughput, request settings, and timestamp. Set `SPEED_TEST_DB` or use `--db` to change the location. API keys and generated responses are not stored.

## Programmatic model listing

The exported `listModels()` method uses the same environment variables and returns sorted model IDs:

```js
const { listModels } = require('./cli');

const models = await listModels();
console.log(models);
```

You can also supply configuration directly:

```js
const models = await listModels({
  baseUrl: 'https://api.example.com/v1',
  apiKey: 'your-api-key',
});
```
