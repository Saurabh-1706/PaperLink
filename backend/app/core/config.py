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

    llm_provider: Literal["gemini", "openai", "null"] = "null"
    gemini_api_key: str | None = None
    openai_api_key: str | None = None
    llm_model: str = "gemini-flash-latest"

    ocr_engine: Literal["paddle", "rapid", "doctr", "stub"] = "paddle"

    render_dpi: int = 300
    render_max_long_edge: int = 3000
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
