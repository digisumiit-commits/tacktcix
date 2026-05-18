import os
from pydantic_settings import BaseSettings

_DEFAULT_DATABASE_URL = "postgresql+asyncpg://postgres:postgres@localhost:5432/tacktcix"


def _resolve_database_url(raw: str) -> str:
    """Fall back to common cloud-provider env vars when the default is still set."""
    if raw and raw != _DEFAULT_DATABASE_URL:
        return raw
    for key in ("NEON_DATABASE_URL", "DATABASE_URL", "POSTGRES_URL", "SUPABASE_DATABASE_URL"):
        val = os.getenv(key, "")
        if val:
            # Neon / Vercel Postgres use the postgres:// scheme; asyncpg wants postgresql://
            if val.startswith("postgres://"):
                val = "postgresql+asyncpg" + val[len("postgres"):]
            elif "://" in val and not val.startswith("postgresql"):
                # Generic URL from another provider — assume it works with asyncpg
                pass
            return val
    return raw


class Settings(BaseSettings):
    database_url: str = _DEFAULT_DATABASE_URL
    neo4j_uri: str = "bolt://localhost:7687"
    neo4j_user: str = "neo4j"
    neo4j_password: str = "password"
    qdrant_url: str = "http://localhost:6333"
    redis_url: str = "redis://localhost:6379/0"
    ai_model_api_key: str = ""
    ai_model_base_url: str = "https://api.deepseek.com/v1"
    default_model: str = "deepseek-chat"

    model_config = {"env_prefix": "TACKTCIX_", "env_file": ".env"}


settings = Settings()
settings.database_url = _resolve_database_url(settings.database_url)
