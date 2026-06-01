# Voice Demo Agent Server

This service is a standalone FastAPI + LangGraph bridge for the Volcengine RTC voice demo.

## Endpoints

- `GET /health`
- `POST /v1/chat/completions`

`/v1/chat/completions` is OpenAI-compatible and supports both `stream=true` SSE output and `stream=false` local debugging.

## Local run

```powershell
cd agent-server
copy .env.example .env
python -m pip install -r requirements.txt
python -m uvicorn app.main:app --reload --port 8000
```

## Environment

See `.env.example`.

`AGENT_API_KEY` must match the credential configured for the third-party agent URL used by the backend RTC control plane.

When the agent runs in Docker Compose with the main backend, prefer:

```env
BACKEND_BASE_URL=http://backend:5000
BACKEND_FALLBACK_BASE_URL=http://backend:5000
```

If `BACKEND_BASE_URL` points at the public domain and that route is temporarily unavailable, `BACKEND_FALLBACK_BASE_URL` lets weather and platform-status tools retry through the shared Docker network.

Streaming responses send an initial OpenAI-compatible empty SSE chunk immediately, then continue waiting for the real tool result. This prevents slow weather/status calls from being canceled by the first-chunk timeout.

The agent routes deterministic requests to dedicated tools first:

- time: local server time
- weather: `GET /api/v1/tools/internal/weather`
- platform status: `GET /health/ready`
- general questions: `POST /api/v1/tools/internal/chat`

All backend tool calls use `X-Internal-Api-Key` when `BACKEND_INTERNAL_API_KEY` is configured.

## Docker

```bash
cd agent-server
docker build -t voice-agent-server .
docker run -d --name voice-agent-server --env-file .env -p 8001:8000 voice-agent-server
```

## Docker Compose

The repository also includes a separate compose file so the agent can stay independently deployed while still joining the shared `agentproject-network` used by the main stack.

```bash
cd agent-server
docker compose up -d --build
```

Expose it behind HTTPS and point Volcengine voice chat LLM/agent URL to:

- `https://your-main-domain/agent/v1/chat/completions`
- `https://your-main-domain/agent/health`
