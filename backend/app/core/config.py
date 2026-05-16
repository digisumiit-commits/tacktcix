from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    database_url: str = "postgresql+asyncpg://postgres:postgres@localhost:5432/tacktcix"
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
