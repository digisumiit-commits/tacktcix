"""HTTP health check server for the worker runtime.

Exposes a /health endpoint consumed by Docker healthcheck and load balancers.
Also provides /metrics for Prometheus-style scraping and /status for debug info.
"""

from __future__ import annotations

import json
import threading
import time
from http.server import HTTPServer, BaseHTTPRequestHandler

import structlog

from .config import HealthConfig, get_config

logger = structlog.get_logger(__name__)

# Global state for health reporting — updated by main worker loop
_start_time: float = time.time()
_healthy: bool = True
_last_health_error: str = ""


def set_healthy(healthy: bool, error: str = "") -> None:
    global _healthy, _last_health_error
    _healthy = healthy
    _last_health_error = error


class HealthHandler(BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        # Suppress default access logging; we use structlog
        pass

    def do_GET(self) -> None:
        if self.path == "/health":
            self._handle_health()
        elif self.path == "/status":
            self._handle_status()
        elif self.path == "/metrics":
            self._handle_metrics()
        else:
            self.send_response(404)
            self.end_headers()

    def _handle_health(self) -> None:
        global _healthy
        if _healthy:
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({"status": "healthy"}).encode())
        else:
            self.send_response(503)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(
                json.dumps({
                    "status": "unhealthy",
                    "error": _last_health_error,
                }).encode()
            )

    def _handle_status(self) -> None:
        config = get_config()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(
            json.dumps({
                "worker_id": config.worker.id,
                "uptime_s": time.time() - _start_time,
                "healthy": _healthy,
                "features": {
                    "read_only_rootfs": config.sandbox.read_only_rootfs,
                    "drop_all_capabilities": config.sandbox.drop_all_capabilities,
                    "default_profile": config.sandbox.default_profile,
                },
            }).encode()
        )

    def _handle_metrics(self) -> None:
        uptime = time.time() - _start_time
        lines = [
            "# HELP execution_worker_uptime_seconds Worker uptime\n",
            "# TYPE execution_worker_uptime_seconds gauge\n",
            f"execution_worker_uptime_seconds {uptime}\n",
            "# HELP execution_worker_healthy Health status (1=healthy, 0=unhealthy)\n",
            "# TYPE execution_worker_healthy gauge\n",
            f"execution_worker_healthy {1 if _healthy else 0}\n",
        ]

        # Append heartbeat metrics if the collector is available
        try:
            from .heartbeat_metrics import get_collector

            collector = get_collector()
            lines.append(collector.prometheus_text())
        except (ImportError, RuntimeError):
            pass

        self.send_response(200)
        self.send_header("Content-Type", "text/plain; version=0.0.4")
        self.end_headers()
        self.wfile.write("".join(lines).encode())


class HealthServer:
    """Runs an HTTP health check server in a daemon thread."""

    def __init__(self, config: HealthConfig) -> None:
        self._config = config
        self._server: HTTPServer | None = None
        self._thread: threading.Thread | None = None

    def start(self) -> None:
        self._server = HTTPServer(("0.0.0.0", self._config.port), HealthHandler)
        self._thread = threading.Thread(target=self._server.serve_forever, daemon=True)
        self._thread.start()
        logger.info("health_server_started", port=self._config.port)

    def stop(self) -> None:
        if self._server:
            self._server.shutdown()
            self._server = None
        logger.info("health_server_stopped")
