"""Bounded in-memory cache of signed header reports.

A confirmed header is immutable, so a fresh cached report can be re-served
without re-querying source RPCs or re-signing. LRU-evicted; entries close to
expiry are refreshed so we never hand out a report that's about to go stale.
"""

import time
from collections import OrderedDict
from threading import RLock
from typing import Any

ReportCacheKey = tuple[int, int, int, str, int, bool]


class ReportCache:
    def __init__(self, max_size: int, refresh_seconds: int) -> None:
        self.max_size = max(0, int(max_size))
        self.refresh_seconds = max(0, int(refresh_seconds))
        self._items: OrderedDict[ReportCacheKey, dict[str, Any]] = OrderedDict()
        self._lock = RLock()

    def get(self, key: ReportCacheKey) -> dict[str, Any] | None:
        if self.max_size == 0:
            return None
        with self._lock:
            value = self._items.get(key)
            if value is None:
                return None
            self._items.move_to_end(key)
            return value

    def set(self, key: ReportCacheKey, value: dict[str, Any]) -> None:
        if self.max_size == 0:
            return
        with self._lock:
            self._items[key] = value
            self._items.move_to_end(key)
            while len(self._items) > self.max_size:
                self._items.popitem(last=False)

    def should_refresh(self, report: dict[str, Any], now: int | None = None) -> bool:
        now = int(time.time()) if now is None else int(now)
        expires_at = int(report.get("expiresAt", 0))
        return expires_at - now <= self.refresh_seconds
