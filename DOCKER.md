# Running with Docker

## Prerequisites

| Tool | Version |
|------|---------|
| Docker Desktop | ≥ 4.x |
| Docker Compose | v2 (bundled with Docker Desktop) |
| MongoDB | Running locally on port 27017 (Windows service) |

> [!NOTE]
> By default MongoDB runs on your **host machine**, not inside Docker. The container
> reaches it via `host.docker.internal:27017`. Make sure your local `mongod` is started
> before running `docker compose up`. Pass `--with-mongo` to `vedaai.sh` (or add
> `-f docker-compose.mongo.yml`) to run MongoDB in a container instead.

---

## 1 · Set up environment files

```bash
# Frontend — copy and fill in your AI provider + key
cp apps/web/.env.example apps/web/.env.local
```

Minimum edits for **apps/web/.env.local**:
```
AI_PROVIDER=gemini           # or anthropic / openai
GEMINI_API_KEY=<your-key>
MONGO_URI=mongodb://host.docker.internal:27017/?...
JWT_SECRET=<any-random-string>
```

---

## 2 · Build & start

```bash
docker compose up --build
```

On first run this will take a few minutes (downloading base images and building the
Next.js app).

---

## 3 · Open the app

| Service | URL |
|---------|-----|
| Frontend (Next.js) | http://localhost:3000 |

---

## Useful commands

```bash
# Start in the background
docker compose up --build -d

# Tail logs
docker compose logs -f frontend

# Stop everything
docker compose down

# Rebuild after code changes
docker compose up --build frontend
```

See also `./vedaai.sh` for a wrapper script around these commands (`up`, `logs`,
`health`, `--with-mongo`, ...).
