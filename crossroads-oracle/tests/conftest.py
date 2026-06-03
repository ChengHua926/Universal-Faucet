"""Shared pytest setup.

oracle.py reads some config at import time, so set harmless defaults before any
test imports it. setdefault won't clobber real values if they're already set.
"""

import os

os.environ.setdefault(
    "ORACLE_CONTRACT_ADDRESS", "0x0000000000000000000000000000000000000000"
)
os.environ.setdefault("LOCAL_PRIVATE_KEY", "0x" + "11" * 32)
