#!/usr/bin/env python3
"""TCP delay proxy for simulating inter-node network latency.

Usage:
    delay_proxy.py <listen_port> <target_port> <delay_ms>

Listens on 127.0.0.1:<listen_port>, forwards bidirectionally to
127.0.0.1:<target_port>. Each forwarded chunk is sleep-delayed by
<delay_ms> milliseconds in both directions, simulating a per-leg one-way
link latency (round-trip = 2 * delay_ms). <delay_ms> may be fractional.
"""
from __future__ import annotations

import asyncio
import sys


async def pipe(reader: asyncio.StreamReader, writer: asyncio.StreamWriter, delay: float) -> None:
    try:
        while True:
            chunk = await reader.read(65536)
            if not chunk:
                break
            if delay > 0:
                await asyncio.sleep(delay)
            writer.write(chunk)
            await writer.drain()
    except (ConnectionResetError, BrokenPipeError, asyncio.IncompleteReadError):
        pass
    finally:
        try:
            writer.close()
        except Exception:
            pass


async def handle(
    client_reader: asyncio.StreamReader,
    client_writer: asyncio.StreamWriter,
    target_host: str,
    target_port: int,
    delay: float,
) -> None:
    try:
        up_r, up_w = await asyncio.open_connection(target_host, target_port)
    except OSError:
        client_writer.close()
        return
    await asyncio.gather(
        pipe(client_reader, up_w, delay),
        pipe(up_r, client_writer, delay),
    )


async def main(listen_port: int, target_port: int, delay_ms: float) -> None:
    delay = delay_ms / 1000.0
    server = await asyncio.start_server(
        lambda r, w: handle(r, w, "127.0.0.1", target_port, delay),
        "127.0.0.1",
        listen_port,
    )
    async with server:
        await server.serve_forever()


if __name__ == "__main__":
    if len(sys.argv) != 4:
        print(f"usage: {sys.argv[0]} <listen_port> <target_port> <delay_ms>", file=sys.stderr)
        sys.exit(2)
    asyncio.run(main(int(sys.argv[1]), int(sys.argv[2]), float(sys.argv[3])))
