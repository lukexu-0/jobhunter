from __future__ import annotations

import os

os.environ["ANONYMIZED_TELEMETRY"] = "false"
os.environ["BROWSER_USE_ACTION_TIMEOUT_S"] = "3600"

__all__: tuple[str, ...] = ()
