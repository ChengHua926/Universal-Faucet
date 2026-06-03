"""Shared pytest setup.

The Model B modules read configuration lazily (inside functions, not at import),
so no environment defaults are needed here. Kept as the package's conftest anchor.
"""
