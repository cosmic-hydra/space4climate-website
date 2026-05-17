# opencode proxy

This proxy exposes an OpenAI-compatible API-key provider endpoint and forwards requests to an opencode-compatible upstream.

It also includes an MCP server that can trigger and inspect OpenCode GitHub Actions workflow runs.

## What it does

- Exposes local endpoints under `/v1/*`.
- Accepts compatibility aliases:
	- `POST /inference/chat/completions` -> `/v1/chat/completions`
	- `GET /inference/models` -> `/v1/models`
	- `POST /inference/responses` -> `/v1/responses`
- Requires an incoming provider key when `PROVIDER_API_KEY` is set.
- Replaces incoming authorization with `OPENCODE_API_KEY` for upstream calls.
- Optionally forces a fixed model using `OPENCODE_MODEL`.
- Returns a local `/v1/models` response when `OPENCODE_MODEL` is set, which helps clients that validate provider setup by listing models first.

## Important limitation (Copilot routing)

GitHub Copilot's built-in backend cannot be redirected to a custom proxy endpoint.

What this means in practice:
- You can use this proxy with OpenAI-compatible provider integrations that allow a custom base URL and key.
- You cannot make native Copilot chat silently switch to this proxy just by "touching" an agent name.
- To use opencode with an API key in VS Code, configure a custom model provider/inference endpoint (where supported), then pick that model explicitly.

## Setup

1. Copy `.env.example` values into your shell environment.
2. Start the proxy:

```bash
cd opencode-proxy
PORT=4141 \
OPENCODE_BASE_URL=https://api.opencode.example \
OPENCODE_API_KEY=your_real_key \
OPENCODE_MODEL=your_model \
PROVIDER_API_KEY=local_provider_key \
npm start
```

3. Point your OpenAI-compatible client/provider config to:

- Base URL: `http://127.0.0.1:4141/v1`
- API Key: value of `PROVIDER_API_KEY`

If you leave `PROVIDER_API_KEY` empty, any bearer token is accepted.

## Health check

```bash
curl -s http://127.0.0.1:4141/healthz
```

`/healthz` now includes request counters so you can verify if traffic reached this proxy.

Inspect recent request metadata:

```bash
curl -s http://127.0.0.1:4141/debug/requests | jq
```

Look at `userAgent`, `path`, `proxiedRequests`, and `rejectedAuth` to confirm which client actually hit the proxy.

Example model list with provider key:

```bash
curl -s http://127.0.0.1:4141/v1/models \
	-H "Authorization: Bearer local_provider_key"
```

## MCP server (OpenCode workflow bridge)

The file `mcp-server.mjs` exposes these MCP tools:

- `opencode_dispatch`: dispatches `.github/workflows/opencode.yml` with `prompt` and optional `model`
- `opencode_list_runs`: lists recent workflow runs
- `opencode_get_run`: fetches run details and logs for a run id

### Required environment

- `GITHUB_OWNER`: GitHub org/user (for example `cosmic-hydra`)
- `GITHUB_REPO`: repo name (for example `space4climate-website`)
- `OPENCODE_WORKFLOW_ID` (optional, default `opencode.yml`)
- `OPENCODE_DEFAULT_MODEL` (optional, default `opencode-default-model`)

You must also authenticate GitHub CLI:

```bash
gh auth status || gh auth login
```

### Run MCP server locally

```bash
cd opencode-proxy
GITHUB_OWNER=cosmic-hydra GITHUB_REPO=space4climate-website npm run mcp
```

### VS Code MCP config example

```json
{
	"servers": {
		"opencode": {
			"command": "npm",
			"args": ["run", "mcp", "--prefix", "/workspaces/space4climate-website/opencode-proxy"],
			"env": {
				"GITHUB_OWNER": "cosmic-hydra",
				"GITHUB_REPO": "space4climate-website"
			}
		}
	}
}
```
