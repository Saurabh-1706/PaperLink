# Deployment & Local Development

**Status:** Implemented (Phase 0); production polish outstanding (Phase 11)

## Local development

The application runs in Docker Compose. This is deliberate: PaddleOCR, PyMuPDF and
poppler are painful to install natively on Windows, and containerising them keeps the
dev environment identical to production.

**MongoDB is the exception — it runs on the host, not in compose.** The local machine
already has MongoDB Server installed as a Windows service, and the data lives there
rather than in a container volume.

```bash
docker compose up --build
```

Services:

| Service | Purpose |
|---|---|
| `redis` | Celery broker + cache |
| `api` | FastAPI |
| `worker` | Celery worker (OCR, pipelines) |

MongoDB (host, not a compose service) is the primary datastore + GridFS binaries.

### Host MongoDB prerequisites

The containers reach the host database at `host.docker.internal:27017`
(`extra_hosts: host.docker.internal:host-gateway` makes that name resolve on Linux as
well as Docker Desktop). For that to work, the host mongod must accept connections from
the Docker bridge, which the default install does not:

1. Edit `C:\Program Files\MongoDB\Server\8.3\bin\mongod.cfg` (elevated) and widen the
   bind list to include the Docker/WSL host address:

   ```yaml
   net:
     port: 27017
     bindIp: 127.0.0.1,172.19.160.1   # vEthernet (WSL) address on this machine
   ```

   Keep `127.0.0.1` in the list so native (non-Docker) runs still work. Do not use
   `bindIpAll: true` unless the machine is on a trusted network — this mongod has no
   authentication enabled.
2. Restart the service (elevated): `Restart-Service MongoDB`.
3. If it is still unreachable, allow inbound TCP 27017 on the Docker/WSL adapter in
   Windows Firewall.

The WSL adapter address can change when the host reboots; if the containers suddenly
cannot reach Mongo, re-check it with
`Get-NetIPAddress -AddressFamily IPv4 | Where-Object InterfaceAlias -match 'WSL|Docker'`
and update `bindIp`.

Check it from inside a container with:

```bash
docker compose exec api python -c "import pymongo,os;print(pymongo.MongoClient(os.environ['MONGO_URI'],serverSelectionTimeoutMS=3000).admin.command('ping'))"
```

The host mongod is a **standalone** server, so `MONGO_TRANSACTIONS=false`: the Unit of
Work degrades to discarding unflushed writes instead of a real rollback, which is why
writes are idempotent and flushed late. To get real transactions back, convert the host
server to a single-node replica set (`replication.replSetName: rs0` in `mongod.cfg`,
then `rs.initiate()`), set `MONGO_TRANSACTIONS=true`, and add `&replicaSet=rs0` to
`MONGO_URI`.

## Configuration

All configuration is environment variables, loaded via pydantic-settings. `.env.example`
is committed; `.env` is not.

| Variable | Purpose |
|---|---|
| `MONGO_URI` / `MONGO_DB_NAME` | MongoDB connection |
| `MONGO_TRANSACTIONS` | `true` only on a replica set; enables real rollback (host mongod is standalone -> `false`) |
| `REDIS_URL` | Broker + cache |
| `STORAGE_BACKEND` | `gridfs` (default) or `local` |
| `GRIDFS_BUCKET` / `STORAGE_PATH` | Storage target |
| `LLM_PROVIDER` | `gemini` (default) or `openai` |
| `GEMINI_API_KEY` / `OPENAI_API_KEY` | Provider credentials |
| `OCR_ENGINE` | `paddle` (default) or `doctr` |
| `RENDER_DPI` | Page render DPI (default 300) |
| `JWT_SECRET`, `JWT_*_TTL` | Auth |
| `*_CONFIDENCE_THRESHOLD` | Per-stage thresholds, tuned from the eval suite |

Provider and engine selection is config, never an import — see
[ADR-004](decisions/ADR-004-provider-interfaces.md).

## Indexes

MongoDB has no schema to migrate. Index declarations live in `app/db/session.py` and are
applied on release, never automatically on application start.

```bash
make indexes
```

## Production

- Multi-stage Docker images
- `docker-compose.prod.yml`
- Seeded demo organization for evaluation
- README with a scripted end-to-end demo

## Observability

Structured logging carries `request_id` and `assessment_id` on every line, so a single
slow or failed assessment can be traced across the API and the worker. LLM calls log
token counts.
