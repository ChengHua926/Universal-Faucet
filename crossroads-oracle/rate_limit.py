"""Best-effort global fixed-window rate limiter for the HTTP API.

Caps requests per minute across all clients (limit <= 0 disables it). Cheap and
thread-safe; not a security control, just backpressure against accidental floods
of source-RPC/signing work.
"""

import time
from threading import RLock


class FixedWindowRateLimiter:
    def __init__(self, limit_per_minute: int) -> None:
        self.limit = int(limit_per_minute)
        self._window_start = int(time.time() // 60)
        self._count = 0
        self._lock = RLock()

    def allow(self) -> bool:
        if self.limit <= 0:
            return True
        now_window = int(time.time() // 60)
        with self._lock:
            if now_window != self._window_start:
                self._window_start = now_window
                self._count = 0
            if self._count >= self.limit:
                return False
            self._count += 1
            return True
