"""Application settings. Everything is environment-driven (docs/08-deployment.md)."""
from __future__ import annotations

from functools import lru_cache
from typing import Literal

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    app_name: str = "assessment-mapping-api"
    environment: str = "local"
    log_level: str = "INFO"

    # MongoDB is the primary datastore; GridFS (same database) holds the binaries.
    mongo_uri: str = "mongodb://localhost:27017"
    mongo_db_name: str = "assessment"
    # Multi-document transactions need a replica set. Standalone mongod -> leave false.
    mongo_transactions: bool = False
    redis_url: str = "redis://localhost:6379/0"
    celery_task_always_eager: bool = True

    storage_backend: Literal["gridfs", "local"] = "gridfs"
    gridfs_bucket: str = "documents"
    storage_path: str = "./var/storage"

    # "openai" is accepted but has no adapter yet; it resolves to the null provider.
    llm_provider: Literal["gemini", "groq", "openai", "null"] = "null"
    # Vision (handwriting validation) can run on a different provider from text --
    # "auto" means "whatever LLM_PROVIDER is".
    vision_provider: Literal["auto", "gemini", "groq", "null"] = "auto"
    gemini_api_key: str | None = None
    openai_api_key: str | None = None
    groq_api_key: str | None = None
    llm_model: str = "gemini-flash-latest"
    # Groq deprecates model ids often; verify against GET /openai/v1/models.
    groq_model: str = "openai/gpt-oss-120b"
    # Must be multimodal. Empty disables Groq vision -> OCR text is used as-is.
    groq_vision_model: str = "qwen/qwen3.8-27b"
    groq_base_url: str | None = None
    groq_json_mode: bool = True
    # Groq rejects an image request over 20MB; the cap is on the encoded payload.
    groq_max_image_bytes: int = 20 * 1024 * 1024
    # Total attempts per LLM call, including the first. The provider SDK retries 429s
    # with exponential backoff by default, which is pure latency once a daily quota is
    # gone -- the caller's deterministic fallback is what actually produces the result.
    llm_max_attempts: int = 2
    # After a quota/rate-limit refusal, stop calling the provider for this long
    # (process-local). 0 disables the breaker.
    llm_quota_cooldown_seconds: int = 900

    ocr_engine: Literal["paddle", "rapid", "doctr", "stub"] = "paddle"

    # --- OCR preprocessing -------------------------------------------------
    # Divide out the illumination field before recognition. autocontrast is a single
    # global histogram remap, so a shadow gradient across the page defeats it; the
    # flattening step is local. Moves no pixels -> records Transform.identity(), so
    # docs/03-coordinate-contract.md is unaffected.
    ocr_flatten_background: bool = False
    ocr_flatten_radius: int = 16
    # Hard binarisation is deliberately a SEPARATE flag: RapidOCR's recogniser is
    # trained on natural grayscale crops and a threshold erases faint pencil, which is
    # the exact stroke class handwriting extraction depends on.
    ocr_adaptive_threshold: bool = False

    # --- Line script routing -----------------------------------------------
    # Classify each grouped line as printed / handwritten from detector output alone
    # (no layout model). "telemetry" classifies and logs but routes nothing -- the
    # confusion rate is measured before any behaviour depends on it.
    line_script_mode: Literal["off", "telemetry", "route"] = "telemetry"
    line_script_handwriting_threshold: float = 0.55

    # --- Line recogniser (handwriting) --------------------------------------
    # Selection is config, exactly as ocr_engine is (ADR-004). TrOCR decodes
    # autoregressively: ~0.4-1.2 s/line on CPU, so it stays off unless a GPU is present.
    line_recognizer: Literal["none", "trocr", "stub"] = "none"
    trocr_model: str = "microsoft/trocr-base-handwritten"
    trocr_batch_size: int = 8
    trocr_device: str = "cpu"
    trocr_max_new_tokens: int = 64
    # A line at or above this OCR confidence is never overwritten by the recogniser.
    trocr_high_confidence_floor: float = 0.80

    render_dpi: int = 150
    render_max_long_edge: int = 2000
    max_upload_bytes: int = 50 * 1024 * 1024
    max_pages: int = 200
    searchable_coverage_threshold: float = 0.02

    jwt_secret: str = "change-me"
    jwt_algorithm: str = "HS256"
    jwt_access_ttl_seconds: int = 3600
    jwt_refresh_ttl_seconds: int = 14 * 24 * 3600

    # Per-stage confidence thresholds, tuned from the eval suite.
    block_confidence_threshold: float = 0.60
    question_confidence_threshold: float = 0.70
    answer_confidence_threshold: float = 0.65
    mapping_accept_threshold: float = 0.70
    mapping_review_threshold: float = 0.45
    mapping_ambiguous_margin: float = 0.10


@lru_cache
def get_settings() -> Settings:
    return Settings()


settings = get_settings()
