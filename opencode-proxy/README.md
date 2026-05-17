# opencode proxy

This proxy forwards OpenAI-style API requests to an opencode-compatible upstream.

## What it does

- Exposes local endpoints under /v1/*.
- Accepts POST /inference/chat/completions and maps it to /v1/chat/completions.
- Replaces the incoming auth token with OPENCODE_API_KEY.
- Optionally forces a fixed model using OPENCODE_MODEL.

## Important limitation

The GitHub Copilot extension does not support replacing its backend API endpoint with a custom proxy.
Use this proxy with clients that support a custom OpenAI-compatible base URL.

## Setup

1. Export environment variables from .env.example values.
2. Start the proxy:

```bash
cd opencode-proxy
PORT=4141 OPENCODE_BASE_URL=https://api.opencode.example OPENCODE_API_KEY=your_real_key OPENCODE_MODEL=your_model npm start
```

3. Point your OpenAI-compatible client to:

- Base URL: http://127.0.0.1:4141/v1
- API Key: any placeholder value (the proxy injects OPENCODE_API_KEY)

## Health check

```bash
curl -s http://127.0.0.1:4141/healthz
```
