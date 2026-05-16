from uuid import UUID

from fastapi import Request
from starlette.middleware.base import BaseHTTPMiddleware

from app.core.config import settings
from app.core.tenant import set_tenant

TENANT_HEADER = settings.tenant_header


class TenantMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        header_value = request.headers.get(TENANT_HEADER)

        if header_value:
            try:
                company_id = UUID(header_value)
                set_tenant(company_id)
            except ValueError:
                pass

        response = await call_next(request)
        return response
