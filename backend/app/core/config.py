from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    app_name: str = "tacktcix-api"
    debug: bool = False

    database_url: str = "postgresql+asyncpg://tacktcix:tacktcix@localhost:5432/tacktcix"
    database_pool_size: int = 20
    database_max_overflow: int = 10

    redis_url: str = "redis://localhost:6379/0"

    qdrant_url: str = "http://localhost:6333"
    neo4j_url: str = "bolt://localhost:7687"

    tenant_header: str = "X-Company-Id"

    model_config = {"env_prefix": "TACKTCIX_", "env_file": ".env"}


settings = Settings()
