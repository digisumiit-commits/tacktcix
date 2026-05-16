from contextvars import ContextVar
from uuid import UUID

tenant_ctx: ContextVar[UUID | None] = ContextVar("tenant_id", default=None)


def set_tenant(company_id: UUID) -> None:
    tenant_ctx.set(company_id)


def get_tenant() -> UUID | None:
    return tenant_ctx.get()
