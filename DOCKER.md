# Running with Docker

## Prerequisites

| Tool | Version |
|------|---------|
| Docker Desktop | ≥ 4.x |
| Docker Compose | v2 (bundled with Docker Desktop) |
| MongoDB | Running locally on port 27017 (Windows service) |

> [!NOTE]
> MongoDB runs on your **host machine**, not inside Docker. The containers reach it via
> `host.docker.internal:27017`. Make sure your local `mongod` is started before running
> `docker compose up`.

---

## 1 · Set up environment files

```bash
# Backend — copy and fill in your LLM API key
cp backend/.env.example backend/.env

# Frontend — copy and fill in your AI provider + key
cp frontend/.env.example frontend/.env.local
```

Minimum edits for **backend/.env**:
```
LLM_PROVIDER=gemini          # or anthropic / openai
GEMINI_API_KEY=<your-key>
JWT_SECRET=<any-random-string>
```

Minimum edits for **frontend/.env.local**:
```
AI_PROVIDER=gemini           # or anthropic / openai
GEMINI_API_KEY=<your-key>
```

---

## 2 · Build & start

```bash
docker compose up --build
```

On first run this will take a few minutes (downloading base images, installing Python
packages, and building the Next.js app).

---

## 3 · Open the app

| Service | URL |
|---------|-----|
| Frontend (Next.js) | http://localhost:3000 |
| API (FastAPI docs) | http://localhost:8000/docs |
| Redis | localhost:6379 |

---

## Useful commands

```bash
# Start in the background
docker compose up --build -d

# Tail logs for all services
docker compose logs -f

# Tail logs for one service
docker compose logs -f frontend
docker compose logs -f api
docker compose logs -f worker

# Stop everything
docker compose down

# Rebuild a single service after code changes
docker compose up --build frontend
docker compose up --build api worker
```
