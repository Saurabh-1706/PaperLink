/**
 * Application settings, environment-driven (docs/08-deployment.md).
 * Port of backend/app/core/config.py, narrowed to what Phase 1 needs.
 */

function str(name: string, fallback: string): string {
  return process.env[name] ?? fallback;
}

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function csv(name: string, fallback: string[]): string[] {
  const raw = process.env[name];
  if (!raw) return fallback;
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export const settings = {
  mongoUri: str("MONGO_URI", "mongodb://localhost:27017"),
  mongoDbName: str("MONGO_DB_NAME", "assessment"),
  gridfsBucket: str("GRIDFS_BUCKET", "documents"),

  geminiApiKey: process.env.GEMINI_API_KEY ?? "",
  geminiModelCascade: csv("GEMINI_MODEL_CASCADE", [
    "gemini-2.5-flash",
    "gemini-2.5-flash-lite",
    "gemini-2.0-flash",
  ]),
  get geminiVisionModelCascade(): string[] {
    return csv("GEMINI_VISION_MODEL_CASCADE", this.geminiModelCascade);
  },
  llmQuotaCooldownSeconds: num("LLM_QUOTA_COOLDOWN_SECONDS", 900),
  llmRequestsPerMinute: num("LLM_REQUESTS_PER_MINUTE", 15),

  renderDpi: num("RENDER_DPI", 200),
  renderMaxLongEdge: num("RENDER_MAX_LONG_EDGE", 2000),
  maxUploadBytes: num("MAX_UPLOAD_BYTES", 50 * 1024 * 1024),
  maxPages: num("MAX_PAGES", 200),
  searchableCoverageThreshold: num("SEARCHABLE_COVERAGE_THRESHOLD", 0.02),
  blockConfidenceThreshold: num("BLOCK_CONFIDENCE_THRESHOLD", 0.6),

  jwtSecret: str("JWT_SECRET", "change-me"),
  jwtAlgorithm: str("JWT_ALGORITHM", "HS256"),
  jwtAccessTtlSeconds: num("JWT_ACCESS_TTL_SECONDS", 3600),
  jwtRefreshTtlSeconds: num("JWT_REFRESH_TTL_SECONDS", 14 * 24 * 3600),
} as const;
