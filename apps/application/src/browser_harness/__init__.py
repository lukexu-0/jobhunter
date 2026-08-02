from __future__ import annotations

import os

DEFAULT_SESSION_TIMEOUT_SECONDS = 14_400

os.environ["ANONYMIZED_TELEMETRY"] = "false"
os.environ["BROWSER_USE_ACTION_TIMEOUT_S"] = str(
    DEFAULT_SESSION_TIMEOUT_SECONDS
)

__all__ = ("DEFAULT_SESSION_TIMEOUT_SECONDS",)
