# Ollama integration

Status: **research, with a proposed plan; chat v1 built** (2026-11-02, see "Chat v1: what was built"). Nothing else decided. Everything before "Fit with gitlib" records what
the primary sources say; "Fit with gitlib" is read from this repository's code and "Recommendation" is the author's
proposal, so neither is sourced the way the rest is.

## Context

The owner runs an Ollama server on another machine on the LAN (one RTX 3080 Ti, 12 GB VRAM) and wants local models
to answer questions about the data in gitlib, first through a chat panel that slides out from the right. This note
collects what Ollama's own docs and source, Meilisearch's docs and source, the client libraries' repos and registry
entries, TanStack's docs, shadcn/Radix, Docker, MCP and OWASP say about each part of that. It states findings and
leaves the choices to the author. Figures were read on 2026-11-02: Ollama's latest release was v0.40.13
(2026-10-28) [19], Meilisearch's v1.56.1 (2026-11-02) [36] while the compose file pins v1.56.0 [63]. Things that
could not be confirmed at a primary source are marked "unverified".

## Ollama native HTTP API

Base URL `http://localhost:11434`; the server binds `127.0.0.1:11434` unless `OLLAMA_HOST` changes it [15][7].
The API is described as not strictly versioned, expected to stay backward compatible, with deprecations announced in
release notes [7].

### Chat request and response

`POST /api/chat` takes `model`, `messages`, `tools`, `think`, `format`, `options`, `stream` and `keep_alive`.
A message has a `role` (`system`, `user`, `assistant` or `tool`), `content`, and optionally `images`, `thinking`,
`tool_calls` and (on tool results) `tool_name` [1][2]. `POST /api/generate` is the single-prompt form (`prompt`,
`system`, `template`, `suffix`, `raw`, `images`, same `think`/`format`/`options`/`keep_alive`) [1]. An empty `prompt`
(generate) or empty `messages` (chat) loads the model without generating; adding `keep_alive: 0` unloads it [1][15].

```jsonc
// POST /api/chat
{
  "model": "qwen3:8b",
  "messages": [{ "role": "user", "content": "Why is the sky blue?" }],
  "stream": true,                       // default true on the REST API
  "keep_alive": "5m",                   // default; see below
  "options": { "num_ctx": 8192, "temperature": 0.2, "num_predict": 512 }
}
```

### Streaming and the final chunk

Streamed endpoints answer with `application/x-ndjson`, one JSON object per line; `"stream": false` returns one
`application/json` object [4]. Streaming is on by default on the REST API and off by default in Ollama's SDKs [10].
Each chat chunk carries `model`, `created_at`, `message` (partial `content`, `thinking`, `tool_calls`) and `done` [2].
The final chunk (`done: true`) adds `done_reason` and the usage fields below; durations are nanoseconds, and tokens
per second is `eval_count / eval_duration * 10^9` [1][5].

| Field | Meaning |
|---|---|
| `total_duration`, `load_duration` | whole request; model load time [5] |
| `prompt_eval_count`, `prompt_eval_cached_count`, `prompt_eval_duration` | input tokens; tokens read from cache; time on uncached prompt tokens [5] |
| `eval_count`, `eval_duration` | output tokens and time [5] |
| `done_reason` | `stop` and `unload` appear in the docs [1]; the source also returns `load` for an empty-messages preload [20] |

The OpenAPI file's stream-event schema lists only `done` and omits these final-chunk fields, while the usage page
says they arrive on the final chunk [2][5].

### Keep-alive and options

- `keep_alive` accepts a duration string (`"10m"`), seconds, a negative number (keep loaded) or `0` (unload after the
  response). The default is 5 minutes; `OLLAMA_KEEP_ALIVE` sets the server default and the request value overrides it
  [15].
- `options` takes Modelfile parameters such as `num_ctx`, `temperature`, `seed`, `top_k`, `top_p`, `min_p`, `stop`,
  `num_predict` and `num_keep` [1][2][16]. Source defaults: temperature 0.8, top_k 40, top_p 0.9, `num_predict` -1
  (unlimited), `num_keep` 4 [20]. Runner-level options (`num_ctx`, `num_batch`, `num_gpu`, `main_gpu`, `use_mmap`,
  `num_thread`) are labelled "must be set when the model is loaded" in the Go types [20].

### Structured outputs, tools and thinking

- `format` is `"json"` or a JSON Schema object; the reply is a JSON string in `message.content`. Ollama's page
  suggests also putting the schema in the prompt [11][1].
- `tools` is a list of `{ "type": "function", "function": { name, description, parameters } }` with a JSON Schema for
  `parameters`. The model's reply carries `message.tool_calls[].function.{name, arguments}` (arguments is an object).
  The round trip is: append the assistant message with its `tool_calls`, append one `{ "role": "tool", "tool_name",
  "content" }` message per call, call `/api/chat` again with the same `tools` [9][1].
- When streaming, `thinking`, `content` and `tool_calls` arrive in separate partial fields that the client has to
  accumulate and send back together with the tool results [10][9]. Parallel tool calls come back as several entries
  in one `tool_calls` array [9].
- A request that includes `tools` for a model without the `tools` capability is rejected with a capability error
  (HTTP 400) [20]. The capabilities a model has are listed by `/api/show` (`completion`, `tools`, `insert`, `vision`,
  `embedding`, `thinking`, ...) [1][20].
- `think` is `true`, `false`, `null` (model default) or a model-defined level string such as `low`/`medium`/`high`;
  numbers are not accepted. `/api/show` reports the supported `thinking.values` and `default` per model. Reasoning
  comes back in `message.thinking`, separate from `message.content` [12][2].

### Model-management and status endpoints

| Endpoint | Returns |
|---|---|
| `GET /api/version` | `{"version": "..."}` [1] |
| `GET /api/tags` | `models[]`: `name`, `model`, `modified_at`, `size`, `digest`, `details` (`format`, `family`, `parameter_size`, `quantization_level`) [1][2] |
| `POST /api/show` | `modelfile`, `parameters`, `template`, `details`, `model_info` (for example `<arch>.context_length`, `<arch>.embedding_length`), `capabilities`, optional `thinking` [1][12] |
| `GET /api/ps` | loaded models: `name`, `size`, `digest`, `expires_at`, `size_vram`, `context_length` [2] |
| `POST /api/embed` | `input` (string or list), optional `truncate` (default true), `dimensions`, `keep_alive`; returns `embeddings[]` (L2-normalised), `total_duration`, `load_duration`, `prompt_eval_count` [1][13][2] |
| `POST /api/embeddings` | older single-prompt form; the API page says `/api/embed` supersedes it [1] |

The router also registers `/api/pull`, `/api/push`, `/api/create`, `/api/copy`, `/api/delete`, `/api/status` and
the OpenAI/Anthropic-compatible `/v1/*` routes on the same listener [20].

### How errors are reported

| Case | What the docs and source say |
|---|---|
| Normal errors | HTTP status plus `{"error": "message"}` (`application/json`); common codes 400, 404, 429, 500, 502 [3] |
| Error mid-stream | the status line is already 200, so the error arrives as a line `{"error": "..."}` inside the NDJSON stream [3] |
| Model not found | 404; source messages are `model '<name>' not found` and `model "<name>" not found, try pulling it first` [3][20] |
| Model not yet loaded | no interim status is documented; the handler waits on the scheduler and the first chunk arrives after the load (`load_duration` reports it). `OLLAMA_LOAD_TIMEOUT` (default 5m) bounds a stalled load [5][20] |
| Queue full | 503 `server busy, please try again. maximum pending requests exceeded`; `OLLAMA_MAX_QUEUE` default 512 [15][20] |
| Client disconnect | the source maps a cancelled context to status 499 [20] |

## OpenAI-compatible endpoints

Ollama documents an OpenAI-compatible subset at `/v1` (base URL `http://localhost:11434/v1`; the client needs an API
key value but Ollama ignores it) [8]. The same listener also has an Anthropic-compatible `/v1/messages` [7][20].

| Endpoint | Supported per Ollama | Not supported per Ollama |
|---|---|---|
| `/v1/chat/completions` | chat, streaming, JSON mode, `seed`, vision (base64 only), `tools`, `stream_options.include_usage`, `response_format`, `reasoning_effort` / `reasoning.effort`, `temperature`, `top_p`, `max_tokens`, `stop`, penalties | `logprobs`, `tool_choice`, `logit_bias`, `user`, `n`, image URLs [8] |
| `/v1/completions` | streaming, JSON mode, `suffix`, `seed` | `best_of`, `echo`, `logit_bias`, `user`, `n`, `logprobs`; `prompt` must be a string [8] |
| `/v1/embeddings` | `input` as string or array of strings, `encoding format`, `dimensions` | token-array inputs, `user` [8] |
| `/v1/models`, `/v1/models/{model}` | listing and retrieval; `created` is last-modified, `owned_by` defaults to `library` | |
| `/v1/responses` (added v0.13.3) | stateless Responses API, streaming, tools, reasoning summaries | `previous_response_id`, `conversation`, `truncation` [8] |

The OpenAI API has no way to set the context size, so Ollama's page says to create a derived model with a Modelfile
`PARAMETER num_ctx ...` (or use the server environment variable) [8]. Audio endpoints also exist and are outside this
note [8].

## Context window

- **Current default.** The Context length page says the default depends on VRAM: under 24 GiB, 4k; 24 to 48 GiB, 32k;
  48 GiB or more, 256k [14]. The source sets 4,096 / 32,768 / 262,144 using thresholds of 47 and 23 GiB of detected VRAM
  at server start [20]. The release notes put this in v0.15.5 (2026-02-03); v0.17.0 (2026-02-21) says the macOS and
  Windows apps now default by available VRAM [19]. A 12 GB card is in the lowest tier.
- **Earlier defaults.** `OLLAMA_CONTEXT_LENGTH` arrived in v0.5.13 (2025-02-27); the default rose to 4,096 tokens in
  v0.6.7 (2025-04-26); v0.9.3 (2025-06-25) capped the context at what the model was trained for; v0.10.0 added a
  context column to `ollama ps` [19].
- **The docs disagree with each other.** The FAQ says the default is 4096 [15]; the Modelfile reference says
  `num_ctx` defaults to 2048 [16]; the Context length page and the source give the VRAM tiers [14][20]. The latter two
  match the release notes [19].
- **How it is chosen.** Layers apply in this order: built-in default (VRAM tier, or `OLLAMA_CONTEXT_LENGTH` if set),
  the model's Modelfile `PARAMETER`, then the request's `options.num_ctx`, which wins [20]. The value is clamped to
  the model's trained context length (and to a minimum of 4; vision models get at least 2,048) [20]. The loaded value is
  visible as `context_length` in `/api/ps` and in the `CONTEXT` column of `ollama ps` [2][14]. If a load runs out of
  memory and the context was automatic, the scheduler retries once with a lower automatic value (32,768, then 4,096)
  [20].
- **Docs recommendation.** Tasks that need large context (web search, agents, coding tools) should use at least 64,000
  tokens [14]; the same page notes larger contexts need more memory [14].
- **What happens when the prompt is too long.** In the current source (`main`, which starts GGUF models through an
  upstream `llama-server` process [20]):
  - `/api/chat` first drops the oldest messages from the front until the rendered prompt fits, always keeping the
    latest message and re-adding any system messages that were in the dropped part [20].
  - If the latest message alone exceeds `num_ctx` and context shift is on (default, except the `deepseek2` family
    unless the request sets `shift`), the prompt tokens are cut: the first `num_keep` tokens (default 4, plus BOS) are
    kept, the tokens right after them are discarded, and the end of the prompt is kept. A warning "truncating input
    prompt" is written to the server log [20]. This is token-level, so a system prompt at the very start survives only
    within those first tokens.
  - With context shift off (`shift: false`) the request fails with HTTP 400 ("the prompt is longer than the context
    length currently available to the model ...") [20].
  - `truncate: false` on the request skips the server-side truncation. Both `truncate` and `shift` exist in the Go
    request types [20] but are not in the OpenAPI schema for chat or generate [2].
  - `/api/embed` truncates input to the context by default (`truncate: true`) and returns an error when
    `truncate: false` and the input is too long [1][2].
  - Nothing in the response says that truncation happened. `prompt_eval_count` is populated from `llama-server`'s
    counts for the prompt it received [20], so it likely reflects the truncated prompt (inference; unverified in the
    docs).
- **For long inputs.** Stuffing README text, notes or code into the prompt competes with the system prompt, history,
  tool definitions and the answer for the same `num_ctx` tokens. Token counts are model-specific and the API has no
  tokenizer endpoint (see the routes in [20]); a client sees token counts only after the call, in `prompt_eval_count`
  [5].

## Network and security of the server

- **Binding.** Ollama binds `127.0.0.1:11434`; `OLLAMA_HOST` changes it (for example `0.0.0.0:11434`). On macOS the
  variable is set with `launchctl setenv`, on Linux with a systemd `Environment=` line, on Windows as a user variable
  [15].
- **No authentication.** The local API "does not require authentication" [6]; API keys apply to `ollama.com` cloud
  requests [6]. In the router source I found CORS and Host-header middleware but no authentication middleware on the
  local routes, and the same listener serves `pull`, `push`, `create`, `copy` and `delete` [20]. An `OLLAMA_AUTH`
  variable exists, but the only use I found is in the Go API client (`api/client.go`), so it looks client-side
  (unverified beyond a code search) [20].
- **What Ollama's FAQ says about exposing it.** It says how to change the bind address and how to front the server
  with a reverse proxy (Nginx with `proxy_set_header Host localhost:11434`), ngrok or Cloudflare Tunnel [15]. The FAQ
  and the other docs pages I read give no security warning about LAN exposure [15][6].
- **CORS and origins.** By default cross-origin requests are allowed from `localhost`, `127.0.0.1` and `0.0.0.0` (any
  port, http or https) plus `app://`, `file://`, `tauri://`, `vscode-webview://` and `vscode-file://`; `OLLAMA_ORIGINS`
  adds more [15][20]. CORS is enforced by browsers, so a server-side `fetch` from the app is not subject to it.
- **Host-header check.** When the server is bound to a loopback address it rejects requests whose `Host` header is
  not loopback, private, unspecified or on an allowed-host list (HTTP 403); when bound to a non-loopback address the
  check is skipped [20].
- **Cloud features.** `OLLAMA_NO_CLOUD=1` (or `disable_ollama_cloud` in `~/.ollama/server.json`) disables cloud models
  and web search [15]. Library tags marked `cloud` run on ollama.com rather than the local GPU [14][21].
- **Reaching it from a container.**
  - A container can make outgoing connections by default; on the default bridge they are masqueraded, so no extra
    configuration is needed to reach another LAN host [60]. The Ollama URL can therefore be the LAN host's name or IP.
  - `host.docker.internal` is for services on the Docker host itself. Docker Desktop resolves it automatically [57].
    On Docker Engine for Linux, add `--add-host host.docker.internal=host-gateway`; `host-gateway` resolves to the
    host's internal IP (by default the default bridge's address) and `host-gateway-ip` in `daemon.json` changes it
    [58][59]. The Compose `extra_hosts` reference does not mention `host-gateway` [61] (unverified whether Compose
    passes it through).
  - A service bound only to the host's loopback is not reachable on those addresses (networking inference, not
    stated in the Docker pages): with Ollama on the Docker host, `OLLAMA_HOST` would need a non-loopback bind [15].
  - If Meilisearch (rather than the app) is the caller, it refuses private-network targets by default; see
    "Retrieval strategies" [33][36].

## Models

All figures below are what the library pages list on 2026-11-02 (the listing had 266 model entries) [21]. The pages
change over time. Capability badges on the library are `tools`, `thinking`, `vision`, `audio`, `embedding` and
`cloud`; a tag's "Context" column is the context window the page lists for it, which is separate from the server's
default `num_ctx` [21][14]. Sizes are download sizes of the weights.

- **Advertising `tools`** (a non-exhaustive sample from the listing): llama3.1, llama3.2, qwen2.5, qwen3, qwen3.5,
  qwen3.6, qwen3.8, gemma4, gpt-oss, mistral, mistral-nemo, mistral-small3.2, ministral-3, granite4, granite4.1,
  phi4-mini, deepseek-r1, cogito, olmo-3, lfm2.5, nemotron-3-nano, functiongemma, smollm2, hermes3 [21]. Ollama's API
  docs say a capability mismatch is an error, and `/api/show` is where to read a model's `capabilities` [20][1].
- **Code-oriented** (by name and page description): qwen2.5-coder ("code-specific Qwen models"), qwen3-coder
  ("agentic and coding tasks"), devstral and devstral-small-2 ("tools to explore codebases"), codestral, codegemma,
  deepseek-coder-v2, granite-code, starcoder2, codellama, deepcoder, yi-coder, opencoder, north-mini-code-1.0 [21].
  Of these, qwen2.5-coder, qwen3-coder, devstral, devstral-small-2 and north-mini-code-1.0 carry the `tools` badge;
  the others show no capability badge [21].
- **Embedding models** (badge `embedding`; the pages say embedding-only models cannot generate text [21]):

| Model | Listed size (tag) | Listed context | Dimensions as stated on the page |
|---|---|---|---|
| nomic-embed-text | 274MB (`latest`, v1.5) | 2K | not stated |
| mxbai-embed-large | 670MB (335m) | 512 | not stated |
| embeddinggemma | 622MB (300m); 239MB (qat q4_0), 338MB (qat q8_0) | 2K | not stated |
| embeddinggemma-2 | 304-378MB (270m), 671-714MB (440m), 918-990MB (570m), 1.3GB (740m) | 256K | 768, with Matryoshka truncation to 128/256/512 [21]; the page text also says an 8K-token context while the tag table says 256K |
| qwen3-embedding | 639MB (0.6b), 2.5GB (4b), 4.7GB (8b, `latest`) | 32K (0.6b), 40K (4b, 8b) | up to 4096, user-defined 32 to 4096 (8B text) |
| bge-m3 | 1.2GB (567m) | 8K | not stated (page text: inputs up to 8192 tokens) |
| all-minilm | 46MB (22m), 67MB (33m) | 512 | not stated |
| snowflake-arctic-embed2 | 1.2GB (568m) | 8K | not stated (page mentions Matryoshka) |
| nomic-embed-text-v2-moe | 958MB | 512 | 768 down to 256 via Matryoshka |
| granite-embedding | 63MB (30m), 563MB (278m) | 512 | not stated |

The vector length of an installed embedding model can be read from `/api/show` (`model_info`, key ending in
`.embedding_length`) [1]. Ollama's embeddings page says the length is model-dependent, typically 384 to 1024 [13].

## Fitting in 12 GB of VRAM

NVIDIA's page lists the GeForce RTX 3080 Ti with a standard 12 GB GDDR6X memory configuration on a 384-bit interface
[62]. Ollama's GPU page lists the RTX 3080 Ti (compute capability 8.6; NVIDIA drivers 550 or newer) as supported
[17]. The memory details below are read from the Ollama source on `main` (head `c1db5f9`, 2026-10-31), which launches
GGUF models through an upstream `llama-server` process [20]. I did not pin the release in which that runner
replaced the earlier one (v0.40.2's notes mention upgrading models "for better performance and compatibility when
running on llama.cpp" [19]), so details may differ on an older install.

### What consumes VRAM

- **Weights.** The scheduler's pre-load estimate uses the model file size as the proxy for weights [20].
- **KV cache.** The same estimator uses `2 (K and V) x layers x kv_heads x head_dim x context x 2 bytes (f16)` and its
  comment calls the result deliberately conservative [20]. As arithmetic on the sample `/api/show` metadata in the
  API reference (32 layers, 8 KV heads, embedding length 4096 over 32 heads, so head size 128) [1]: 128 KiB per token,
  512 MiB at 4,096 tokens, 4 GiB at 32,768. This is a worked example from documentation values, not a measurement of
  any listed model.
- **Compute buffers.** `llama-server`'s log reports separate model, KV and compute buffer sizes, which Ollama parses;
  the scheduler also adds a batch-dependent amount to its estimate, and `OLLAMA_GPU_OVERHEAD` reserves bytes per GPU
  [20].
- **Context x parallel slots.** The server is launched with total context `num_ctx x parallel` and `parallel` slots
  [20]. The FAQ says the same: parallel processing multiplies the context (a 2K context with 4 parallel requests is
  an 8K context with extra memory) and RAM scales with `OLLAMA_NUM_PARALLEL x OLLAMA_CONTEXT_LENGTH` [15].
  `OLLAMA_NUM_PARALLEL` defaults to 1 [15][20]. Embedding models always load with parallel 1, and a list of
  architectures (including `qwen35`, `qwen3vl`, `lfm2`) is forced to 1 [20].

### Knobs that shrink it

| Knob | What it does | Source |
|---|---|---|
| `OLLAMA_CONTEXT_LENGTH` | default `num_ctx` for requests that do not set one (server-wide); a request's `options.num_ctx` still overrides it | [14][20] |
| `options.num_ctx` (per request) | sets the context and so the KV size; it is a load-time option, so a different value forces a reload (next subsection) | [1][20] |
| `options.num_predict` | caps generated tokens (default -1, unlimited); not a load-time option and not part of the memory estimate | [16][20] |
| `OLLAMA_NUM_PARALLEL` | multiplies the context allocation; default 1 | [15][20] |
| `OLLAMA_FLASH_ATTENTION` | on automatically when the backend and devices support it; `1` forces on, `0` off. The FAQ says it can significantly reduce memory as context grows. Source treats CUDA devices with compute capability 6 or higher (except 7.2) as supported | [15][20] |
| `OLLAMA_KV_CACHE_TYPE` | `f16` (default), `q8_0` (about 1/2 the memory of f16, "very small" precision loss), `q4_0` (about 1/4, small to medium loss, more noticeable at larger contexts). The FAQ ties quantisation to Flash Attention being enabled, calls it a global setting, and warns that models with a high GQA count (for example Qwen2) may lose more precision. The value is passed to `llama-server` as `--cache-type-k/-v`; the estimator still assumes f16 | [15][20] |
| `OLLAMA_GPU_OVERHEAD` | reserves VRAM per GPU, in bytes | [20] |
| `OLLAMA_MAX_LOADED_MODELS` | caps co-resident models; default 3 x GPUs | [15] |
| `options.num_gpu` | explicit number of GPU layers (0 = CPU only); default is automatic. It is in the Go types but not in the Modelfile parameter table I read | [20][16] |
| `keep_alive`, `OLLAMA_KEEP_ALIVE` | how long VRAM stays held after the last request | [15] |

### When the model plus context does not fit

- By default `-ngl` is not passed, so `llama-server` picks how many layers go to the GPU from the memory available;
  with `num_gpu` set the count is explicit [20]. The FAQ describes the outcome as `100% GPU`, `100% CPU`, or a split
  such as `48%/52% CPU/GPU` shown by `ollama ps` [15].
- To see the split: `ollama ps` shows `PROCESSOR` and `CONTEXT`; `/api/ps` gives `size` and `size_vram` per model, and
  the CLI computes the CPU share as `(size - size_vram) / size` [2][20]. If even system memory cannot hold the model
  the load returns an error ("model is too large for system memory" in the log) [20].
- The only performance statement in the docs I read is "for best performance ... avoid offloading the model to CPU"
  [14]. No page quantifies the slowdown (no numbers on the cost of partial offload).
- With other models already loaded, the scheduler predicts weights + KV + batch memory and evicts a loaded model
  first if the prediction exceeds 80% of free memory [20]. The FAQ states that when a new model does not fit alongside
  loaded ones the request queues until room is made, and that for GPU inference new models must fit entirely in VRAM
  to be loaded concurrently [15].

### What makes Ollama unload and reload a model

From `needsReload` and the scheduler in `server/sched.go` [20]:

- **Changed load-time options.** A loaded model is reloaded when the request's runner options differ from the loaded
  ones: `num_ctx`, `num_batch`, `num_gpu`, `main_gpu`, `use_mmap`, `num_thread`, `draft_num_predict` (the `Runner`
  struct) [20]. Sampling options (`temperature`, `seed`, `top_p`, `num_predict`, `stop`, ...) are not in that struct
  and do not trigger a reload [20].
- **The `num_ctx` comparison is not "don't care" when omitted.** If both the loaded runner and the new request use the
  automatic context they match; if the loaded runner was loaded with an explicit `num_ctx` and the next request omits
  it, the request is compared as the server default and a differing value reloads [20].
- **Other triggers.** A different `shift` (context shift) setting, changed adapter or projector paths, or a failed
  health ping [20].
- **Reload mechanics.** The scheduler marks the old runner to expire, waits for in-flight requests on it to finish,
  unloads it, then loads the new configuration [20]. Two callers that alternate `num_ctx` on the same model therefore
  pay a load each switch (`load_duration` in the response shows the cost [5]). I did not measure this.
- **Different model.** Each model is its own runner; if both do not fit, the scheduler evicts one to load the other
  [20][15]. A chat model plus an embedding model are two runners.
- **Expiry.** A runner idles out after `keep_alive` (default 5 minutes); a request that specifies `keep_alive` sets the
  runner's timeout, and requests that omit it leave the existing value [15][20]. `keep_alive: 0` unloads once idle [15].
- **Concurrency.** With `OLLAMA_NUM_PARALLEL` at 1, requests to the same model are served one at a time and the rest
  wait in the queue (`OLLAMA_MAX_QUEUE`, default 512) [15][20].

So chat and a batch job that use different `num_ctx` (or any other runner option) on the same model will reload it
between requests; using no explicit `num_ctx`, or the same one, on both avoids that by the source's logic.

### Can the server operator cap what a client requests?

No such control exists in the configuration or code I read. The documented and parsed environment variables include
`OLLAMA_CONTEXT_LENGTH` (a default, not a ceiling), `OLLAMA_NUM_PARALLEL`, `OLLAMA_MAX_QUEUE`,
`OLLAMA_MAX_LOADED_MODELS`, `OLLAMA_KEEP_ALIVE` and `OLLAMA_GPU_OVERHEAD`, with nothing that limits `num_ctx` or
`num_predict` per request [15][20]. A Modelfile `PARAMETER` only sets a default: options are applied in the order
defaults, model parameters, then request, so a request overrides it [20]. The one hard clamp is to the model's
trained context length [20]. Limits on context size, output length, concurrency and who may call at all therefore
live in the calling app (or a proxy in front of Ollama).

### Prompt truncation and counting tokens

What is dropped, and the lack of any truncation signal in the response, are described under "Context window" [20]. There
is no Ollama endpoint for counting tokens before sending: the route table has no tokenize route [20] and the OpenAPI
file has none [2]. The server tokenizes internally for truncation, but a client must estimate in advance and can read
the real count afterwards from `prompt_eval_count` [5][20].

### Listed sizes for tool-capable and code-oriented models

Download sizes and context as the library pages list them on 2026-11-02 (weights only; the KV cache and compute
buffers from the sections above come on top) [21]. Tags above 12 GB are shown for the boundary. A range such as
"6.6-7.6GB" is how the page lists a tag with several variants.

Tool-capable (badge `tools`), tags with a listed size of 12 GB or less, then those above:

| Model | Tags: listed size | Listed context | Other badges |
|---|---|---|---|
| llama3.2 | 1b 1.3GB; 3b 2.0GB | 128K | |
| granite4 | 350m 708MB; 1b 3.3GB; 3b 2.1GB | 32K (350m), 128K | |
| granite4.1 | 3b 2.1GB; 8b 5.3GB | 128K | |
| phi4-mini | 3.8b 2.5GB | 128K | |
| smollm2 | 135m 271MB; 360m 726MB; 1.7b 1.8GB | 8K | |
| functiongemma | 270m 301MB | 32K | |
| qwen3 | 0.6b 523MB; 1.7b 1.4GB; 4b 2.5GB; 8b 5.2GB; 14b 9.3GB | 40K (256K listed for 4b) | thinking |
| qwen3.5 | 0.8b 1.2-1.3GB; 2b 2.7-3.1GB; 4b 3.3-4.0GB; 9b 6.6-7.6GB | 256K | vision, thinking |
| gemma4 | e2b 4.6-7.5GB; e4b 6.6-9.5GB (`latest`); 12b 7.7-8.0GB | 128K (e2b, e4b), 256K (12b) | vision, thinking, audio |
| ministral-3 | 3b 3.0GB; 8b 6.0GB; 14b 9.1GB | 256K | vision |
| llama3.1 | 8b 4.9GB | 128K | |
| qwen2.5 | 0.5b 398MB; 1.5b 986MB; 3b 1.9GB; 7b 4.7GB; 14b 9.0GB | 32K | |
| mistral | 7b 4.4GB | 32K | |
| mistral-nemo | 12b 7.1GB | 1000K | |
| deepseek-r1 | 1.5b 1.1GB; 7b 4.7GB; 8b 5.2GB; 14b 9.0GB | 128K | thinking |
| cogito | 3b 2.2GB; 8b 4.9GB; 14b 9.0GB | 128K | |
| olmo-3 | 7b 4.5GB | 64K | thinking |
| lfm2.5 | 8b 5.2GB | 125K | thinking |
| nemotron-3-nano | 4b 2.8-2.9GB | 256K | thinking |

Tool-capable, listed above 12 GB: gpt-oss 20b 14GB (128K; thinking); devstral 24b 14GB (128K); magistral 24b 14GB (39K;
thinking); lfm2.5 24b 15GB; devstral-small-2 24b 15GB (384K; vision); mistral-small3.2 24b 15GB (128K; vision);
granite4.1 30b 17GB; qwen3.5 27b 17-20GB; gemma4 26b 16-19GB and 31b 19-20GB; qwen3 30b 19GB and 32b 20GB;
qwen3-coder 30b 19GB (256K); qwen3.6 27b 18-19GB; qwen3.8 27b 18GB (256K); glm-4.7-flash 19GB (198K) [21].

Code-oriented:

| Model | Tags: listed size | Listed context | Badge |
|---|---|---|---|
| qwen2.5-coder | 0.5b 398MB; 1.5b 986MB; 3b 1.9GB; 7b 4.7GB; 14b 9.0GB; 32b 20GB | 32K | tools |
| deepseek-coder-v2 | 16b 8.9GB; 236b 133GB | 160K (16b); 4K listed (236b) | none |
| granite-code | 3b 2.0GB; 8b 4.6GB; 20b 12GB; 34b 19GB | 125K (3b, 8b); 8K (20b, 34b) | none |
| codegemma | 2b 1.6GB; 7b 5.0GB | 8K | none |
| starcoder2 | 3b 1.7GB; 7b 4.0GB; 15b 9.1GB | 16K | none |
| codellama | 7b 3.8GB; 13b 7.4GB; 34b 19GB; 70b 39GB | 16K (2K listed for 70b) | none |
| deepcoder | 1.5b 1.1GB; 14b 9.0GB | 128K | none |
| yi-coder | 1.5b 866MB; 9b 5.0GB | 128K | none |
| opencoder | 1.5b 1.4GB; 8b 4.7GB | 4K (1.5b); 8K (8b) | none |
| codestral | 22b 13GB | 32K | none |
| devstral | 24b 14GB | 128K | tools |
| devstral-small-2 | 24b 15GB | 384K | tools, vision |
| qwen3-coder | 30b 19GB; 480b 290GB | 256K | tools |
| north-mini-code-1.0 | 19GB (single size) | 488K | tools, thinking |

Embedding model sizes (all under 1.3 GB per tag) are in the table in "Models" [21].

## Client libraries

Candidates for a Node/TypeScript server, with registry and repository data read on 2026-11-02 [23][24]:

| | Plain `fetch` | `ollama` (ollama-js) | AI SDK + `ollama-ai-provider-v2` | AI SDK + `ai-sdk-ollama` | AI SDK + `@ai-sdk/openai-compatible` | `@tanstack/ai` + `@tanstack/ai-ollama` |
|---|---|---|---|---|---|---|
| Maintainer | none | Ollama (`ollama/ollama-js`, MIT) | community: Nordwest (GitHub redirects to `opencomp-eu/ollama-ai-provider-v2`); Apache-2.0 | community: Jag Reehal; MIT | Vercel; Apache-2.0 | TanStack; MIT |
| Latest on npm | n/a | 0.6.4 (2026-09-29) | 4.1.0 (2026-10-22) | 4.6.1 (2026-10-30) | 3.0.82 (2026-10-30) | 1.0.1 (2026-10-29) for both |
| Repo last push; stars | n/a | 2026-10-16; 4.4k | 2026-11-02; 105 | 2026-10-30; 132 | `vercel/ai` 2026-11-02; 27.7k | `TanStack/ai` 2026-11-02; 3.3k |
| Direct dependencies | 0 | 1 (`whatwg-fetch`) | 2 (`@ai-sdk/provider`, `-utils`); peers `ai ^7`, `zod ^4` | 4 (`ollama`, `jsonrepair`, `@ai-sdk/provider`, `-utils`); peer `ai ^7` | 2 (`@ai-sdk/provider`, `-utils`); peer `zod`; plus `ai` itself (3 deps, 8.5 MB unpacked) | `@tanstack/ai-ollama`: 2 (`ollama`, `@tanstack/ai-utils`); `@tanstack/ai`: 7 deps, 5.8 MB unpacked |
| Unpacked size | 0 | 138 KB | 356 KB | 10.3 MB | 426 KB | 739 KB (adapter) |
| ESM | built in | ESM and CJS exports | ESM and CJS exports | ESM (`type: module`); the AI SDK page says it supports both formats | ESM (`type: module`) | ESM (`type: module`) |
| Browser entry | built in | `ollama/browser` export | not stated | the AI SDK page says it detects Node and browsers | not stated | adapter is server-side in its docs |
| Streaming and abort | read `response.body` NDJSON; abort with `AbortSignal` | `stream: true` returns an async generator; `abort()` aborts all streams on that client instance, so one client per stream is recommended [22] | `streamText` has `abortSignal` and `toUIMessageStreamResponse` / `toTextStreamResponse` [27] | same AI SDK surface [27] | same AI SDK surface; `includeUsage` option for streamed usage [26][27] | SSE via `toServerSentEventsResponse`; `stop()` on the client and an `AbortController` on the server [28] |
| Tool calling | send `tools`, run the loop yourself [9] | yes; `tools` and `tool_name` in docs [9] | the AI SDK's tool support; provider page highlights `think` option for reasoning models [25] | page says it targets reliable tool calling [25] | Ollama's `/v1` accepts `tools` but not `tool_choice` [8] | tools supported; Ollama ignores `toolChoice` [28] |
| Notes | zero dependencies; NDJSON parsing and error-line handling are the app's job [4][3] | SDK streaming is off unless `stream: true` [10]; custom `host` and `headers` options [22]; no change in 0.6.x between 2025-11-13 and 2026-09-29 [23] | `baseURL` default `http://localhost:11434/api`; `.embeddingModel()` factory [25] | uses the official `ollama` client underneath [25] | calls Ollama's OpenAI-compatible endpoints, so per-request `num_ctx` cannot be set [8] | adapter reads `OLLAMA_HOST` or takes a host argument; nests Ollama `options` under `modelOptions.options`; has an `ollamaEmbedding` adapter [28] |

Further notes:

- The AI SDK's own Ollama page lists exactly two Ollama providers, both community-maintained:
  `nordwestt/ollama-ai-provider-v2` ("direct HTTP API integration") and `jagreehal/ai-sdk-ollama` ("built on the
  official Ollama JavaScript client") [25]. The older `ollama-ai-provider` (sgomez) last published 1.2.0 on
  2025-01-17 with a `zod ^3` peer and no AI SDK peer range [23][24].
- `@ai-sdk/openai-compatible` is a Vercel package for any OpenAI-style server; its provider options include
  `baseURL`, `apiKey`, `headers`, `fetch`, `queryParams` and `includeUsage` [26]. The AI SDK docs do not list Ollama
  among their named OpenAI-compatible providers [26].
- TanStack AI exists as a first-party TanStack project (`@tanstack/ai` 1.0.0 on 2026-10-22, 1.0.1 on 2026-10-29). Its
  docs list TanStack Start as a host and show a server route returning `toServerSentEventsResponse(stream)` for a
  `useChat` hook that points at the route [28][24]. Its Ollama adapter wraps `ollama-js` [23][28].
- Zod, AI SDK major versions and peer ranges move quickly (`ai` is at 7.0.160) [23]; check the peer ranges in the
  app's own lockfile before choosing.

## Retrieval strategies for "ask questions about my repos"

| | (a) Stuff metadata, README, notes into the prompt | (b) Lexical retrieval from the existing Meilisearch index | (c) Meilisearch hybrid search with an Ollama embedder | (d) Model-driven tool calls | (e) MCP |
|---|---|---|---|---|---|
| Mechanism (primary source) | `messages` to `/api/chat` [1] | Meilisearch search API; typo tolerance, ranking, crop and highlight [32][35] | `embedders` index setting with `source: "ollama"`, then `hybrid: {embedder, semanticRatio}` in search [35][29] | `tools` in `/api/chat`; app executes the calls [9] | host/client/server protocol [40] |
| Who calls what | app -> Ollama | app -> Meilisearch (existing `SearchBackend`) | Meilisearch -> Ollama `/api/embed` for documents and queries; app -> Meilisearch | model asks, app runs search/read tools | host app owns clients; clients talk to MCP servers |
| Embeddings generated by | none | none | Meilisearch calling Ollama [29][37] | none required | n/a |
| Documented limits | everything shares `num_ctx` (4,096 default on a 12 GB card); truncation drops from the front [14][20] | Meilisearch says full-text works best for keywords or short phrases and points to hybrid for natural-language questions [32]; README text is indexed to 100,000 characters [63] | each document is embedded from `documentTemplate`, cut at `documentTemplateMaxBytes` (default 400) [35]; changing model, template or URL re-embeds [29][35]; private-network targets blocked by default [33] | needs a model with the `tools` badge; a mismatch returns 400 [20]; no `tool_choice` on `/v1` [8] | tool calls need human-in-the-loop capability per spec [41] |
| Extra pieces | none | none (index exists) | an embedding model on the Ollama box; Meilisearch network allow-list | tool definitions, loop, result size limits | an MCP client or server implementation |

### (a) Stuffing

Mechanically it is `messages` content; what limits it is `num_ctx`, the truncation rules and the model's listed
context, all covered above [14][20][21]. Ollama's web-search page suggests at least ~32,000 tokens of context when
tool results can be thousands of tokens each [18].

### (b) Lexical retrieval through the existing index

The repo's search doc records what is indexed: name, paths, technologies, description, notes and the README (first
100,000 characters, because Meilisearch indexes only the first 65,535 word positions of an attribute) [63]. Search
results can be cropped (`attributesToCrop`, `cropLength` default 10 words) and highlighted [35]. Meilisearch's overview
states full-text search suits keyword or short-phrase queries and points to hybrid search for natural-language
questions [32].

### (c) Hybrid and semantic search with an Ollama embedder

- **Not experimental at v1.56.0.** v1.13.0 (2025-02-17) stabilised AI-powered search; `vectorStore` stopped being an
  accepted value for `/experimental-features` and no manual activation is needed [36]. The current experimental-features
  list has no vector-search entry [34].
- **Sources.** Embedder sources are `openAi`, `huggingFace`, `ollama`, `userProvided`, `rest` and `composite` [35]. An
  `ollama` embedder takes `model` (mandatory), optional `url`, optional `apiKey` (a bearer token is sent only if set),
  optional `dimensions` (inferred if omitted), `documentTemplate`, `documentTemplateMaxBytes` and `binaryQuantized`
  [35]. A `rest` embedder is the alternative for any other API [29][35].
- **Which Ollama endpoint.** The `url` must end in `/api/embed` (batch) or `/api/embeddings` (one text per request); the
  default is `http://localhost:11434/api/embeddings` or the `MEILI_OLLAMA_URL` environment variable. This restriction
  came in v1.13.0 [36][37]. Meilisearch's own settings example uses the older `/api/embeddings` path, which Ollama's API
  page marks as superseded by `/api/embed` [35][1].
- **Who generates embeddings.** Meilisearch does, in batches, with caching so only changed documents are re-embedded and
  automatic retries on rate limits [29]. Changing the model, source, template or Ollama URL regenerates all embeddings
  [29][35].
- **Document template.** If `documentTemplate` is unset, Meilisearch embeds all searchable non-null fields, and its docs
  tell users not to rely on that; the rendered text is cut at `documentTemplateMaxBytes` (default 400 bytes) [30][35].
- **Quantization.** `binaryQuantized: true` stores 1 bit per dimension; it cannot be undone. The docs describe it as
  most effective with 1,400+ dimensions and large datasets, less so under 512 dimensions [31][35].
- **Private-network block.** Since v1.34.1 (2026-01-27) Meilisearch refuses requests to hosts that resolve to non-global
  IPs (the fix for an SSRF issue). To reach an Ollama on a private LAN address it needs
  `MEILI_EXPERIMENTAL_ALLOWED_IP_NETWORKS` (CIDR list; `any` allows all), which is marked experimental [36][33][34].
- **Outage behaviour.** v1.56.0 makes indexing give up early when the embedder is overloaded or unavailable, and honour
  `Retry-After` [36].
- **Querying.** `hybrid` takes `embedder` (required) and `semanticRatio` (0.0 keyword to 1.0 semantic; default 0.5)
  [35][29]. Each query needs one embedding call to Ollama.

### (d) Model-driven tool calling

Per Ollama's tool-calling docs the app defines `search_repos`-style functions, the model returns `tool_calls`, the app
runs them and sends `tool` messages back, repeating until there are no more calls [9]. The docs show a multi-turn "agent
loop" in this shape [9]. Model support is per model (`tools` badge, `/api/show` capabilities) [21][1]. The `tool_name`
field, accumulation of streamed partial fields, and parallel calls are covered in the API section [9][10].

### (e) MCP

- Ollama's docs mention MCP only for a Python web-search MCP server example and for third-party tools; they do not
  describe an MCP client or server built into Ollama [18][20]. `ollama-js` has no MCP example in its repository
  tree; `ollama-python` has `examples/web-search-mcp.py` [22][18].
- The MCP specification (2026-07-28) defines a client-host-server architecture: the host creates and manages client
  instances, enforces security policy and consent, and coordinates the LLM; each client talks to exactly one server
  [40]. Its tools page says there should be a human in the loop able to deny tool invocations [41].
- The TypeScript SDK `@modelcontextprotocol/sdk` 1.32.2 has 17 direct dependencies (including `express` and `hono`)
  and is 4.5 MB unpacked [23].
- Meilisearch ships an experimental MCP route (v1.54 or later) exposing four read-only tools: `listIndexes`,
  `describeIndex`, `searchInIndexes`, `facetSearch`, authenticated with an API key sent as a bearer token [39][38]. It
  also has an experimental `/chats` route whose provider sources are `openAi`, `mistral`, `azureOpenAi` and `vLlm`;
  `ollama` is not among them (whether `vLlm` with an Ollama `/v1` URL works is unverified) [35][38]. A `@meilisearch/ai-sdk`
  0.1.0 package supplies search tools for the AI SDK [23][38].

## Streaming from TanStack Start

Pinned version: `@tanstack/react-start` 1.169.4 (published 2026-10-22) [23]; docs and source below are read at that tag.

- **Server route.** A file route's `server.handlers` maps HTTP methods to functions that receive `{ request }` and
  return a `Response` (or promise of one):

  ```ts
  export const Route = createFileRoute('/api/chat')({
    server: { handlers: { POST: async ({ request }) => new Response(stream, { headers: { /* ... */ } }) } },
  })
  ```

  The Server Routes guide at that tag shows `Response` returns and contains no streaming example [42]. TanStack AI's
  example is a Start server route that returns `toServerSentEventsResponse(stream)` and reads `request.signal` to
  detect aborts [28].
- **Server functions.** The "Streaming Data from Server Functions" guide shows two forms: a handler returning a typed
  `ReadableStream<T>`, or an `async function*` that `yield`s values, consumed on the client with `for await` or a stream
  reader [43]. In the source, a result that Seroval can finish synchronously becomes plain JSON; anything else is sent as
  a multiplexed "framed" response with a Start-specific content type [44]. That framing is Start's own wire format,
  not NDJSON or SSE.
- **Choosing.** A server route gives a plain HTTP response that any client (including `fetch` from a non-Start page)
  can read; the Server Routes guide says routes are meant for endpoints called from outside the Start app, and that
  calls from inside the app are better served by server functions [42].
- **Proxy buffering.** Start's guides at that tag say nothing about buffering or compressing streamed responses (the only
  gzip mentions concern static-asset preloading) [42][43][45]. Nginx buffers proxied responses by default
  (`proxy_buffering on`); buffering can be turned off per location or per response with the `X-Accel-Buffering: no`
  header [46]. Whether a given deployment adds buffering is unverified for this app, since the sources do not describe
  one.

## Right-side slide-out panel

- **shadcn/ui `Sheet`.** The docs describe it as extending the Dialog component to display content that complements
  the main content, with `side` set on `SheetContent` to `top`, `right`, `bottom` or `left` [47]. The registry source
  imports `Dialog` from `radix-ui` as `SheetPrimitive`, defaults `side` to `"right"`, and always renders a
  `SheetOverlay` (a `fixed inset-0 bg-black/50` layer) and a close button unless `showCloseButton={false}` [48][47]. The
  `Sheet` root passes its props to the Radix `Dialog.Root`, so `modal` and `onOpenChange` are available [48].
- **Radix `Dialog` `modal` (default `true`).** The docs say `modal` set to `true` disables interaction with outside
  elements and leaves only the dialog content visible to screen readers [49]. In the source [50]:

  | | `modal` true (default) | `modal={false}` |
  |---|---|---|
  | Focus | trapped inside the content (`trapFocus` when open) | not trapped (`trapFocus={false}`) |
  | Pointer events outside | disabled (`disableOutsidePointerEvents`) | enabled |
  | Overlay | rendered; wrapped in `RemoveScroll` | `Dialog.Overlay` returns `null`, so shadcn's `SheetOverlay` renders nothing |
  | Other content for assistive tech | hidden via `hideOthers` | not hidden |
  | Outside click / focus | dismisses the dialog | still goes through `DismissableLayer` and dismisses unless `onInteractOutside` / `onPointerDownOutside` calls `preventDefault()` |
  | Escape | dismisses | dismisses unless `onEscapeKeyDown` calls `preventDefault()` |

  In the non-modal branch, clicking the trigger is excluded from outside-dismissal so it does not close and reopen
  [50]. The Radix docs list "Supports modal and non-modal modes" among the features [49].
- Current versions: `radix-ui` 1.8.1 and `@radix-ui/react-dialog` 1.3.1 (both 2026-10-12) [23]; the app depends on
  `radix-ui ^1.8.1` [63]. Source read: `radix-ui/primitives` at `eb3a2b7` [50].

## Risk model

OWASP Top 10 for LLM Applications, 2025 edition (the index lists LLM01 to LLM10 as the current list) [56]:

| Entry | What OWASP states | In this app |
|---|---|---|
| LLM01 Prompt Injection | Inputs can alter model behaviour even if not human-readable; indirect injection comes from external content such as files; RAG does not fully mitigate it; one listed scenario is an altered repository document steering a RAG app. Mitigations include segregating untrusted content, least privilege, output-format validation and human approval for high-risk actions [51] | README text, notes, descriptions and GitHub issue text enter the prompt and are untrusted input, whoever wrote them |
| LLM02 Sensitive Information Disclosure | Applications can expose sensitive data through output; it lists credentials and confidential business data; restrictions in the system prompt may be bypassed via prompt injection; mitigations include least-privilege access and restricting data sources [52] | the data reaching the model includes private repo content, notes and issues; the app has no login, so anyone who can reach the page can ask about it |
| LLM06 Excessive Agency | Damaging actions follow from manipulated or mistaken model output when the system has excessive functionality, permissions or autonomy; mitigations are fewer and narrower tools, minimal permissions, avoiding open-ended tools and user approval for high-impact actions [53] | tools that only read (search, read a README, list issues) bound the blast radius; any tool that writes notes, edits issues or runs commands would widen it |
| LLM05 Improper Output Handling (also relevant) | Model output passed downstream unvalidated can cause XSS and similar; markdown generated by the model and rendered by the browser is a listed example; encode output [54] | the chat reply is likely to be rendered as markdown, and `react-markdown` is already a dependency; the OWASP prompt-injection page lists an injected image link that exfiltrates the conversation [51] |
| LLM10 Unbounded Consumption (also relevant) | Uncontrolled inference leads to denial of service and cost; examples include variable-length input floods and inputs that keep exceeding the context window [55] | one 12 GB GPU shared by anyone who can reach an unauthenticated app and by the search-indexing job |

## Fit with gitlib

Everything from here to the Recommendation was read from this repository's code, not from the sources above. Figures
and behaviours from the sections above are cited by their numbers.

### What a chat could see

| Data | Where it lives | Notes |
|---|---|---|
| Repo records: name, paths, technologies, notes, description, favorite | `RepoRecord` (`packages/core/src/models.ts`); tables `repos`, `repo_notes`, `repo_descriptions`, `repo_technologies`, `repo_favorites` in `gitlib.db` | Cheap, structured, already loaded by `GitLibApp.loadRepositories()` |
| README text | `readReadmeText` (`packages/core/src/search/documents.ts`): any casing or extension, capped at 100,000 chars, Markdown flattened to plain text | `loadRepoReadme` in `app.ts` is a second reader that only looks for `README.md` and keeps the Markdown |
| Planning issues and projects | `local_issues`, `projects`, `project_repos` in `planning.db` (`planning/migrations.ts`) | The user's own words; cannot be rebuilt, so tools must start read-only |
| GitHub community scores | `github_community_profiles` (opaque JSON `payload`) in `gitlib.db` | Cached, works offline |
| GitHub issues and PRs | `githubGet` in `apps/web/src/server/github.server.ts`: live REST, 10 s timeout | Costs rate limit (60 an hour without a token) |
| Commit history | Contribution graph shells out to `git` (`server/contributions.ts`) | The Docker image already ships `git` |
| Files inside repos | Mounted read-only at `/home/node/git` in Docker | Nothing in the app reads arbitrary repo files today; code questions would be the first feature to do so |
| Search | `GitLibApp.searchRepositories` -> Meilisearch | Returns repo ids plus 24-word highlighted snippets only (`attributesToRetrieve: ["id"]` in `meilisearch-backend.ts`) |

### Seams and conventions to reuse

- **Backend interface with an injected fake.** `SearchBackend` (`search/types.ts`) is passed into the `GitLibApp`
  constructor, so tests never need Meilisearch. CI runs `typecheck`, `vitest` and `build` with no network services,
  so an LLM client needs the same shape.
- **Optional by default, with a typed "unavailable" error.** `SearchUnavailableError` lets callers fall back, and
  `docs/search-options.md` records "a plain `gitlib list` must not depend on it". The same rule applies to Ollama:
  nothing but the chat panel may need it.
- **Config.** `[search]` in `config.toml` plus `GITLIB_MEILI_HOST` / `GITLIB_MEILI_API_KEY` overrides
  (`packages/core/src/config.ts`), mirrored in `docker-compose.yml` (`x-gitlib-env`), `.env.example`,
  `apps/web/.env.example` and the README. An Ollama host and model follow the same five touch points.
- **Core is UI-agnostic and already holds a network client** (`MeilisearchBackend`), so an Ollama client plus
  retrieval can live in `packages/core` and serve both the web chat and a CLI `ask` command.
- **Web server functions** are one file per feature in `apps/web/src/server/*.ts`, each a `createServerFn` over
  `getApp()`.
- **Where the panel mounts.** `RootComponent` in `apps/web/src/routes/__root.tsx` renders `NavBar` and `Outlet`. A panel
  mounted there survives navigation, and `NavBar` has room for a toggle.
- **Page context.** `/repos/$` carries the repo's `relativePath` in its splat, so the chat can default its scope to the
  repo on screen.
- **UI primitives.** `components/ui/dialog.tsx` wraps `radix-ui`'s Dialog; there is no `sheet.tsx` yet.

### Things the code forces you to deal with

1. **Client disconnects do not reach the model.** `apps/web/server.mjs` pipes the response body through
   (`Readable.fromWeb(response.body).pipe(res)`), so streaming itself is not buffered there. But it builds the `Request`
   without a `signal`, so closing the panel or pressing Stop would leave Ollama generating. TanStack AI's example reads
   `request.signal` to detect aborts [28], and Ollama frees its slot when the client connection ends [20], so the
   missing link is in this file.
2. **Docker networking.** Ollama is on another LAN machine, so inside the container `localhost` is wrong; the host must
   be that machine's address, and Ollama must be bound beyond loopback there [15][60].
3. **No login, by design.** `GITLIB_BIND=0.0.0.0` is the documented homelab mode, and Ollama has no authentication
   either [6]. Every existing endpoint already exposes notes, READMEs and planning data to anyone on the LAN, so a chat
   does not widen *data* exposure. It does let anyone who can reach the app spend the GPU's time (OWASP LLM10 [55]),
   and any tool beyond read-only would be a new write surface with nothing in front of it.
4. **`MarkdownBody` is not safe for model output as it stands.** It renders absolute `http(s)` images
   (`components/markdown-body.tsx`). OWASP's prompt-injection page lists an injected image link that exfiltrates the
   conversation [51]; a hostile README or issue could make the model emit one, and the browser would fetch it. The chat
   needs a renderer that shows images as alt text only.
5. **The Meilisearch index is repo-grained.** One document per repo (primary key = repo id), whole README in one
   attribute. That suits "which repos mention X" but not "what does section Y of repo Z's README say". Reading a README
   for the model means reading it from disk, as `buildSearchDocument` does, and semantic search over long READMEs would
   mean a separate chunked index rather than extending `gitlib_repos` (an embedder sees only the first
   `documentTemplateMaxBytes`, 400 by default [35]).
6. **Two README readers disagree.** `readReadmeText` and `loadRepoReadme` accept different filenames; a chat should
   pick one on purpose rather than add a third.
7. **The Settings page is theme-only and browser-local** (`localStorage`), while every other setting is server
   config. A model picker could be per browser; the server URL cannot.
8. **Writes need a confirmation step.** Planning data cannot be rebuilt (`migrations.ts` is append-only for that
   reason). The existing "Add to planning" button is the precedent for a human-confirmed write; a model should not call
   a write tool unattended (OWASP LLM06 [53]).

### Work queue and context budget for a 12 GB card

The question: with one RTX 3080 Ti, can the app run work one repo at a time, or otherwise limit the prompts and context
that pass through the GPU? Yes, at two layers. Only the first is under the app's control.

**What the sources say that decides the design.**

- Context: the default on a card under 24 GiB is 4k tokens, and Ollama's docs recommend at least 64k for agents and
  tools [14]. That recommendation cannot be met on 12 GB with a useful model, so the design has to work in a small
  context.
- No server-side cap: nothing lets the operator limit `num_ctx` or `num_predict` per request; limits live in the
  calling app [15][20].
- Silent truncation: an over-long prompt loses its oldest messages first; if the latest message alone is too long,
  everything after its first few tokens is cut until the end fits. Nothing in the response says so, and there is no
  tokenizer endpoint [20]. The app must budget before it sends.
- Concurrency: with `OLLAMA_NUM_PARALLEL=1` (the default) requests to a loaded model are served one at a time; the order
  of waiters and any priority are not documented, and there is no priority in the code read. A full scheduler queue
  returns HTTP 503. A client that disconnects frees Ollama's slot; whether the runner stops decoding is unverified. A
  request stays open while a model loads (`docs/dependabot-watch.md` section 11).
- Reloads: changing `num_ctx` between requests to the same model reloads it, and sampling options do not [20].

**Layer 1, in the app (proposed).**

- *One global lane, concurrency 1.* Every Ollama call (chat turn, report prose, embedding) goes through one queue.
  "One repo at a time" is not what protects the GPU; one request at a time and a bounded prompt are. Repo-by-repo is a
  good *ordering* for batch work, because results persist per repo and a stopped run resumes cleanly.
- *Priority.* Interactive chat ahead of scheduled work. Ollama gives no priority, so the app does it: the batch job is
  our own code, so a chat message can abort the in-flight batch request and requeue that item. Items are small and
  idempotent (one PR is one item), so an abort wastes little.
- *A token budget per item.* Facts first (already known without the model), then trimmed prose (PR body, release notes,
  the tail of a CI log); summarise in pieces only when a single source is too big. Estimate tokens from characters,
  and calibrate with `prompt_eval_count` from earlier responses [5]. Cap output with `num_predict`.
- *One `num_ctx` for every call*, so the model is not reloaded when chat and batch alternate.
- *Why it matters here.* `MAX_README_CHARS` in `documents.ts` is 100,000 characters, roughly 25k tokens by a chars/4
  rule of thumb (an estimate, not a count). That does not fit a small context, so "put the README in the prompt" is not
  an option on this card: chat needs retrieval of the relevant part.
- *Process boundary.* An in-process queue in the web server cannot see a separate scheduled CLI process. Either run
  scheduled work through the web process, or share a lease row in SQLite (see `docs/dependabot-watch.md` section 11.5
  for the locking facts and the difference between `Store` and the planning store).

**Layer 2, on the Ollama server.** Only the server can protect against other clients on the LAN and against a bug in
this app. The settings that matter are `OLLAMA_NUM_PARALLEL`, `OLLAMA_MAX_QUEUE`, `OLLAMA_MAX_LOADED_MODELS`,
`OLLAMA_CONTEXT_LENGTH`, `OLLAMA_KV_CACHE_TYPE`, `OLLAMA_KEEP_ALIVE` and `OLLAMA_HOST` [15][20]; the table in "Knobs
that shrink it" says what each does.

## Recommendation

A proposal, not a decision. It is the author's reading of the findings above; the reasons are the cited facts.

1. **Put an LLM seam in `packages/core`.** An interface (chat with streaming and an abort signal, list models, plus
   embed later), an Ollama implementation, a typed `LlmUnavailableError`, a fake for tests, and config that follows the
   Meilisearch precedent: a table in `config.toml` plus `GITLIB_OLLAMA_HOST` and `GITLIB_OLLAMA_MODEL`, added to compose,
   both `.env.example` files and the README. When Ollama is unreachable the panel says so and nothing else changes.
2. **Use the official `ollama` package behind that seam.** One dependency, 138 KB, streaming as an async generator,
   per-request `options` including `num_ctx`, and a custom `host` [22][23]. Create one client per request, because
   `abort()` stops every stream on a client [22]. Plain `fetch` is the zero-dependency alternative if the NDJSON handling
   is preferred in-house. Avoid the OpenAI-compatible route (`@ai-sdk/openai-compatible`): it cannot set `num_ctx` [8],
   which is the one setting this card cannot do without. Leave the AI SDK and TanStack AI for later: TanStack AI is
   first-party but reached 1.0 on 2026-10-22 [23], and the seam makes swapping it in a local change.
3. **Pick a model by size, then test.** Start with an 8B-class tool-capable model: listed weights are about 5 GB for
   `qwen3:8b`, `llama3.1:8b` and `granite4.1:8b`, and 6 GB for `ministral-3:8b` [21]. That leaves several GB for the KV
   cache; the worked arithmetic above (the API reference's sample model: 32 layers, 8 KV heads) puts it near 1 GiB at
   8k tokens, which is an estimate for that shape and not a measurement of any listed model. 14B-class tags list about 9 GB [21], which leaves little headroom at larger contexts. Confirm on the
   real card that `size_vram` equals `size` in `/api/ps` (the "Verify against your server" commands). Set one explicit
   `num_ctx`, starting at 8192, in the app for every call, and consider `OLLAMA_KV_CACHE_TYPE=q8_0` on the server if
   more context is needed (about half the KV memory, "very small" precision loss, applies to every model) [15].
4. **Retrieval: tools over the index you already have.** Give the model a small read-only tool set (`search_repos`
   over the existing Meilisearch search, `get_repo` for metadata, `read_readme` returning a bounded section, `list_issues`
   for planning), cap every tool result at roughly 1-2k tokens, and cap the loop at a few turns [9][20]. Defer
   Meilisearch hybrid search: it needs the `MEILI_EXPERIMENTAL_ALLOWED_IP_NETWORKS` allow-list so Meilisearch may call a
   LAN Ollama [33], a chunked index (finding 5 above), and an embedding model resident beside the chat model. Revisit
   once you see where keyword search fails.
5. **Transport: a streaming server route.** A `POST /api/chat` route that returns a streamed `Response` (NDJSON or SSE)
   and reads `request.signal` [28][42]. Change `server.mjs` so a closed client connection aborts the `Request` (an
   `AbortController` fed by `res.on("close")`), and test both `npm run web` and the production build, since the two
   servers differ. A server function that `yield`s is the alternative [43], at the cost of Start's own wire format.
6. **UI: a non-modal panel in the root layout.** Build it from the existing Radix Dialog with `modal={false}`, so there is
   no overlay, focus is not trapped and the page stays usable [49][50]; call `preventDefault` in `onInteractOutside` and
   `onPointerDownOutside` so a click on the page does not close it [50]. Add a toggle to `NavBar`, show a scope chip
   (all repos, or the repo from `/repos/$`), and render replies with an image-free variant of `MarkdownBody`. Keep the
   conversation in the browser and send the history with each request; the server stays stateless.
7. **Safety defaults.** Read-only tools in v1. Tool results and README text are untrusted input, so wrap them as data
   and never let them add tools or change scope. Any write goes through a human-confirmed button, like "Add to planning".
8. **Ollama server settings for the 3080 Ti box.** Keep `OLLAMA_NUM_PARALLEL=1`; set `OLLAMA_CONTEXT_LENGTH` to the same
   value the app uses; keep `OLLAMA_MAX_LOADED_MODELS` at its default unless you see evictions (a small embedding model
   can stay resident beside the chat model); pick `OLLAMA_KEEP_ALIVE` long enough that chat does not reload the model
   on every message, but short enough to free VRAM if the card does other work; bind with `OLLAMA_HOST` to a LAN address
   and restrict who can reach port 11434 with a firewall or proxy, since Ollama has no authentication [6][15].
9. **One lane for all model calls.** Build the work queue described above before the first scheduled job runs, so
   the Dependabot job (`docs/dependabot-watch.md`) lands in a queue that already exists.
10. **Order of work.** (a) Run the verify commands from the container and confirm `size_vram == size` with the chosen
    model. (b) Seam, fake, config. (c) Streaming route and panel with no tools. (d) Tools. (e) The lane, shared with
    scheduled work.

Questions only the owner can answer: which model is already pulled on the server, whether that GPU also drives a
display or other workloads (that changes how much VRAM is really free), whether chat history should survive a reload,
and whether the panel should be per repo or global.

## Chat v1: what was built

The first slice of the Recommendation is built (see the README's Chat section). It was exercised end to end against a
stand-in Ollama (streaming, Stop, mid-stream errors, an unreachable server, a phone-width screen, the production server)
but **not against a real model**, so model quality, tool use and how much fits in 12 GB are untested.

| Recommendation | Built | Where it differs |
|---|---|---|
| 1. A seam in `packages/core` | `ChatBackend`, `OllamaBackend`, `LlmUnavailableError`, `[ollama]` config with `GITLIB_OLLAMA_*` overrides, an injected fake for tests | none |
| 2. The official `ollama` package | Plain `fetch` | The NDJSON handling is about 60 lines, tested against a real local HTTP server, adds no dependency, and gives direct per-request abort and `num_ctx`. Swapping is local to `OllamaBackend`. |
| 3. Pick a model by size, one `num_ctx` | The panel lists what the server has installed; configured model, else the first one; `num_ctx` 8192 on every call; replies capped at 1,024 tokens | The size advice is not enforced: nothing checks the model fits in VRAM |
| 4. Tools over the Meilisearch index | **Not built.** The system prompt carries a capped list of every repository (3,000 characters) plus, on a repo's page, its notes (1,500) and README (6,000), in delimited blocks the model is told to treat as data | Tool calling needs a real model to tune; the caps keep the fixed part of the prompt near 2,800 tokens of an 8,192 window |
| 5. A streaming route | `POST /api/chat`, NDJSON; `server.mjs` aborts the request when the browser disconnects; history is cut to fit before sending | none |
| 6. A non-modal panel | `ui/sheet.tsx` over Radix Dialog with `modal={false}`, mounted in the root layout; from 1,024 px the page makes room for it | none |
| 7. Safety defaults | Read-only; the system prompt is built only on the server (a `system` turn from the browser is refused); replies render without images | none |
| 8. Ollama server settings, 9. one lane | Not built (server-side settings are the owner's; the lane belongs with the first scheduled job) | |

Found while building, none caused by this feature:

- **Two copies of `@tanstack/router-core` are installed** (react-router pins 1.171.38, Start 1.171.39), so Start's
  type for a route's `server` option is not applied. `routes/api.chat.ts` carries a `@ts-expect-error` that becomes an
  error once the versions agree.
- **The dev server can hold two copies of `@gitlib/core`**, which makes `instanceof` fail across them (an expected
  error came back as a 500). The chat code uses `isGitLibError`, a brand check added to core.
- **The top bar already overflowed at 375 px** before the new button. The link list now scrolls sideways and **Ask**
  stays pinned.

## Unverified and version-dependent items

- Memory-estimation and truncation behaviour is read from Ollama `main` (llama-server runner); older installs may behave differently. The release that introduced that runner was not pinned [20][19].
- Whether `prompt_eval_count` reflects the truncated prompt is inferred from code, not stated in the docs [5][20].
- The docs contradict each other on the default `num_ctx` (FAQ 4096, Modelfile 2048, Context length page and source: VRAM tiers) [14][15][16][20].
- The OpenAPI stream-event schema omits the final-chunk usage fields that the usage page describes [2][5].
- `OLLAMA_AUTH` appears client-side only in a code search; I did not trace every use [20].
- Whether Compose passes `host-gateway` through `extra_hosts` is not covered by the Compose reference [61].
- Whether Meilisearch's `/chats` `vLlm` source works against Ollama's `/v1` was not checked [35].
- Library page figures (sizes, contexts, dimensions) are as listed and can change; embeddinggemma-2's page gives both 8K (text) and 256K (table) for context [21].
- Nothing here was measured on the owner's server; VRAM numbers are from documentation and arithmetic.

## Verify against your server

You asked for commands to run yourself; I could not reach your server and did not guess its address. Replace the
placeholders. Response shapes come from the API reference and OpenAPI file [1][2].

```bash
export OLLAMA=http://<your-ollama-host>:11434

# Is it up? (the root path answers with plain text)
curl -s $OLLAMA/
# -> Ollama is running

# Version
curl -s $OLLAMA/api/version
# -> {"version":"0.40.x"}

# Installed models
curl -s $OLLAMA/api/tags | jq '.models[] | {name, size, details}'
# -> {"models":[{"name","model","modified_at","size","digest","details":{"format","family","parameter_size","quantization_level"}}]}

# What a model can do, and its trained context / embedding length
curl -s $OLLAMA/api/show -d '{"model":"<model>"}' \
  | jq '{capabilities, thinking, ctx: (.model_info | with_entries(select(.key|test("context_length|embedding_length"))))}'
# -> capabilities such as ["completion","tools","thinking"]; embedding models list "embedding"

# Running models: VRAM use, split and allocated context
curl -s $OLLAMA/api/ps | jq '.models[] | {name, size, size_vram, context_length, expires_at, cpu_pct: (100*(.size-.size_vram)/.size)}'
# -> {"models":[{"name","model","size","digest","details","expires_at","size_vram","context_length"}]}
#    size_vram == size means fully on the GPU; the cpu_pct field is computed here, the way `ollama ps` does it

# One-shot chat (non-streaming)
curl -s $OLLAMA/api/chat -d '{
  "model": "<model>",
  "messages": [{"role": "user", "content": "Reply with the single word: ok"}],
  "stream": false,
  "options": {"num_ctx": 4096, "num_predict": 32}
}'
# -> {"model","created_at","message":{"role":"assistant","content":"..."},"done":true,"done_reason":"stop",
#     "total_duration","load_duration","prompt_eval_count","prompt_eval_duration","eval_count","eval_duration"}

# Streaming shape: one JSON object per line, last line has "done":true and the usage fields
curl -sN $OLLAMA/api/chat -d '{"model":"<model>","messages":[{"role":"user","content":"Count to three."}]}'

# Tool support (expect HTTP 400 and an error string if the model lacks the tools capability)
curl -s $OLLAMA/api/chat -d '{"model":"<model>","stream":false,
  "messages":[{"role":"user","content":"Use the tool to get the temperature in Paris."}],
  "tools":[{"type":"function","function":{"name":"get_temperature","description":"Get the current temperature for a city",
    "parameters":{"type":"object","required":["city"],"properties":{"city":{"type":"string"}}}}}]}'
# -> message.tool_calls[0].function.{name,arguments}

# Embeddings
curl -s $OLLAMA/api/embed -d '{"model":"<embedding-model>","input":["first text","second text"]}' \
  | jq '{model, vectors: (.embeddings|length), dims: (.embeddings[0]|length), prompt_eval_count}'
# -> {"model","embeddings":[[...],[...]],"total_duration","load_duration","prompt_eval_count"}

# OpenAI-compatible listing
curl -s $OLLAMA/v1/models | jq '.data[].id'

# Reachability from inside a container on the app's Docker network (uses the curl image from Docker's own example)
docker run --rm curlimages/curl -s http://<your-ollama-host>:11434/api/version
```

To watch a reload happen, call `/api/chat` twice with different `options.num_ctx` and compare `load_duration` in the two
final chunks; `/api/ps` shows the allocated `context_length` afterwards [5][2].

## Sources

Read on 2026-11-02 unless noted. For GitHub-hosted docs the file path and commit are given because the rendered pages
track `main`.

1. Ollama API reference, `docs/api.md` (`ollama/ollama` main, head `c1db5f9`, 2026-10-31): https://github.com/ollama/ollama/blob/main/docs/api.md. Notes that API docs are moving to docs.ollama.com/api; sample version strings in it are examples.
2. Ollama OpenAPI spec, `docs/openapi.yaml` (spec version 0.1.0, same commit): https://github.com/ollama/ollama/blob/main/docs/openapi.yaml
3. Ollama docs, Errors: https://docs.ollama.com/api/errors
4. Ollama docs, Streaming (API): https://docs.ollama.com/api/streaming
5. Ollama docs, Usage: https://docs.ollama.com/api/usage
6. Ollama docs, Authentication: https://docs.ollama.com/api/authentication
7. Ollama docs, API introduction: https://docs.ollama.com/api/introduction
8. Ollama docs, OpenAI compatibility: https://docs.ollama.com/api/openai-compatibility
9. Ollama docs, Tool calling: https://docs.ollama.com/capabilities/tool-calling
10. Ollama docs, Streaming (capability): https://docs.ollama.com/capabilities/streaming
11. Ollama docs, Structured outputs: https://docs.ollama.com/capabilities/structured-outputs
12. Ollama docs, Thinking: https://docs.ollama.com/capabilities/thinking
13. Ollama docs, Embeddings: https://docs.ollama.com/capabilities/embeddings
14. Ollama docs, Context length: https://docs.ollama.com/context-length
15. Ollama docs, FAQ: https://docs.ollama.com/faq
16. Ollama docs, Modelfile reference: https://docs.ollama.com/modelfile
17. Ollama docs, GPU: https://docs.ollama.com/gpu
18. Ollama docs, Web search (includes an MCP server section): https://docs.ollama.com/capabilities/web-search
19. Ollama release notes (GitHub Releases); read v0.5.13, v0.6.7, v0.9.3, v0.10.0, v0.15.5, v0.17.0, v0.40.2; latest at reading was v0.40.13 (2026-10-28): https://github.com/ollama/ollama/releases
20. Ollama Go source, `ollama/ollama` main, head `c1db5f9` (2026-10-31): `server/routes.go`, `server/sched.go`, `server/prompt.go`, `llm/llama_server.go`, `llm/server.go`, `envconfig/config.go`, `api/types.go`, `cmd/cmd.go`, `ml/device.go`, `types/model/capability.go`: https://github.com/ollama/ollama
21. Ollama model library: listing https://ollama.com/library and per-model pages and `/tags` pages (for example https://ollama.com/library/gemma4 and https://ollama.com/library/gemma4/tags); figures as listed on 2026-11-02.
22. `ollama-js` repository, README, `examples/` and file tree (`ollama/ollama-js` main, `c276d07`, 2026-10-16): https://github.com/ollama/ollama-js
23. npm registry metadata for `ollama` 0.6.4, `ai` 7.0.160, `@ai-sdk/openai-compatible` 3.0.82, `ollama-ai-provider-v2` 4.1.0, `ai-sdk-ollama` 4.6.1, `ollama-ai-provider` 1.2.0, `@tanstack/ai` 1.0.1, `@tanstack/ai-ollama` 1.0.1, `@tanstack/react-start` 1.169.4, `@modelcontextprotocol/sdk` 1.32.2, `@meilisearch/ai-sdk` 0.1.0, `radix-ui` 1.8.1, `@radix-ui/react-dialog` 1.3.1: `https://registry.npmjs.org/<package>`
24. GitHub repository metadata (last push, stars) for `ollama/ollama-js`, `vercel/ai`, `TanStack/ai`, `jagreehal/ai-sdk-ollama`, `sgomez/ollama-ai-provider` and `nordwestt/ollama-ai-provider-v2` (redirects to `opencomp-eu/ollama-ai-provider-v2`), via the GitHub API.
25. AI SDK docs, Ollama community providers (`vercel/ai` main, `51ca5b7`): https://ai-sdk.dev/providers/community-providers/ollama
26. AI SDK docs, OpenAI Compatible Providers: https://ai-sdk.dev/providers/openai-compatible-providers
27. AI SDK reference, `streamText` (`content/docs/07-reference/01-ai-sdk-core/02-stream-text.mdx`, same commit): https://github.com/vercel/ai
28. TanStack AI docs, Ollama adapter and Quick Start, plus `examples/ts-react-chat/src/routes/api.tanchat.ts` (`TanStack/ai` main, `13b1ca9`): https://tanstack.com/ai/latest/docs/adapters/ollama
29. Meilisearch docs, Hybrid and semantic search overview (`meilisearch/documentation` main, `ae2b2c9`, 2026-10-30): https://www.meilisearch.com/docs/capabilities/hybrid_search/overview
30. Meilisearch docs, Document template best practices: https://www.meilisearch.com/docs/capabilities/hybrid_search/advanced/document_template_best_practices
31. Meilisearch docs, Binary quantization: https://www.meilisearch.com/docs/capabilities/hybrid_search/advanced/binary_quantization
32. Meilisearch docs, Full-text search overview: https://www.meilisearch.com/docs/capabilities/full_text_search/overview
33. Meilisearch docs, Self-hosting configuration reference (allow requests to private networks): https://www.meilisearch.com/docs/resources/self_hosting/configuration/reference
34. Meilisearch docs, Experimental features overview (`resources/help/experimental_features_overview.mdx`): https://www.meilisearch.com/docs
35. Meilisearch OpenAPI spec 1.56.0 (`assets/release-assets/meilisearch-openapi.json` in the docs repo): embedder settings, `HybridQuery`, search crop parameters, chat sources. https://github.com/meilisearch/documentation
36. Meilisearch release notes: v1.8.0 (2024-05-06, Ollama embedder), v1.13.0 (2025-02-17), v1.34.1 (2026-01-27), v1.56.0 (2026-10-26); v1.56.1 (2026-11-02) is the latest: https://github.com/meilisearch/meilisearch/releases
37. Meilisearch source, `crates/milli/src/vector/embedder/ollama.rs` at tag v1.56.0: https://github.com/meilisearch/meilisearch/blob/v1.56.0/crates/milli/src/vector/embedder/ollama.rs
38. Meilisearch docs, Agentic search overview: https://www.meilisearch.com/docs/capabilities/agentic_search/overview
39. Meilisearch docs, Model Context Protocol (MCP) integration: https://www.meilisearch.com/docs/getting_started/integrations/mcp
40. Model Context Protocol specification 2026-07-28, Architecture: https://modelcontextprotocol.io/specification/2026-07-28/architecture
41. Model Context Protocol specification 2026-07-28, Tools: https://modelcontextprotocol.io/specification/2026-07-28/server/tools
42. TanStack Start docs, Server Routes, at tag `@tanstack/react-start@1.169.4` (`TanStack/router`): https://tanstack.com/start/latest/docs/framework/react/guide/server-routes
43. TanStack Start docs, Streaming Data from Server Functions, same tag: https://tanstack.com/start/latest/docs/framework/react/guide/streaming-data-from-server-functions
44. TanStack Start source `packages/start-server-core/src/server-functions-handler.ts`, same tag: https://github.com/TanStack/router
45. TanStack Start docs, Hosting guide and Production checklist, same tag (searched for buffering and compression): https://tanstack.com/start/latest/docs/framework/react/guide/hosting
46. nginx docs, `ngx_http_proxy_module` (`proxy_buffering`, `X-Accel-Buffering`): https://nginx.org/en/docs/http/ngx_http_proxy_module.html
47. shadcn/ui docs, Sheet (Radix base; `shadcn-ui/ui` main, `4aaea19`): https://ui.shadcn.com/docs/components/radix/sheet
48. shadcn/ui registry source `apps/v4/registry/new-york-v4/ui/sheet.tsx`, same commit: https://github.com/shadcn-ui/ui
49. Radix Primitives docs, Dialog (`radix-ui/website`, `402e749`): https://www.radix-ui.com/primitives/docs/components/dialog
50. Radix Primitives source, `packages/react/dialog/src/dialog.tsx` and `packages/react/dismissable-layer/src/dismissable-layer.tsx` (`radix-ui/primitives`, `eb3a2b7`, 2026-10-14): https://github.com/radix-ui/primitives
51. OWASP Top 10 for LLM Applications 2025, LLM01 Prompt Injection: https://genai.owasp.org/llmrisk/llm01-prompt-injection/
52. OWASP LLM02:2025 Sensitive Information Disclosure: https://genai.owasp.org/llmrisk/llm022025-sensitive-information-disclosure/
53. OWASP LLM06:2025 Excessive Agency: https://genai.owasp.org/llmrisk/llm062025-excessive-agency/
54. OWASP LLM05:2025 Improper Output Handling: https://genai.owasp.org/llmrisk/llm052025-improper-output-handling/
55. OWASP LLM10:2025 Unbounded Consumption: https://genai.owasp.org/llmrisk/llm102025-unbounded-consumption/
56. OWASP Top 10 for LLM Applications, index of the 2025 list: https://genai.owasp.org/llm-top-10/
57. Docker Desktop docs, networking how-tos, "Connect a container to a service on the host": https://docs.docker.com/desktop/features/networking/networking-how-tos/
58. Docker CLI reference, `docker container run` (`--add-host`, `host-gateway`): https://docs.docker.com/reference/cli/docker/container/run/
59. Docker CLI reference, `dockerd` ("Configure host gateway IP"): https://docs.docker.com/reference/cli/dockerd/
60. Docker Engine docs, Networking overview: https://docs.docker.com/engine/network/
61. Compose file reference, services, `extra_hosts`: https://docs.docker.com/reference/compose-file/services/#extra_hosts
62. NVIDIA, GeForce RTX 3080 / 3080 Ti specifications: https://www.nvidia.com/en-us/geforce/graphics-cards/30-series/rtx-3080-3080ti/
63. gitlib repository (this worktree): `docs/search-options.md` and `docker-compose.yml` (pins `getmeili/meilisearch:v1.56.0`; `apps/web/package.json` depends on `radix-ui ^1.8.1`).
