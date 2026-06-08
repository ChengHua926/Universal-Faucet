#!/usr/bin/env python3
from __future__ import annotations

import math
import shutil
import subprocess
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont


ROOT = Path(__file__).resolve().parents[2]
FRAMES = Path("/private/tmp/drip-core-flow-frames")
OUT = ROOT / "docs/demo/drip-core-flow.mp4"

WIDTH = 1200
HEIGHT = 760
FPS = 30
SECONDS = 15

BG = "#1e1e2e"
PANEL = "#181825"
TEXT = "#cdd6f4"
MUTED = "#a6adc8"
COMMAND = "#a6e3a1"
HEADER = "#89b4fa"
ACCENT = "#f9e2af"
CURSOR = "#f5e0dc"


def font(size: int) -> ImageFont.FreeTypeFont:
    candidates = [
        "/System/Library/Fonts/Menlo.ttc",
        "/Library/Fonts/Menlo.ttc",
        "/System/Library/Fonts/Monaco.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf",
    ]
    for candidate in candidates:
        if Path(candidate).exists():
            return ImageFont.truetype(candidate, size)
    return ImageFont.load_default()


FONT = font(22)
SMALL = font(18)
LINE = 30
LEFT = 58
TOP = 88
MAX_VISIBLE_LINES = 20


STEPS = [
    (
        "drip identity",
        [
            ("Identity", HEADER),
            ("  address: 0x5d3db8ed9c9d3a145650c2baba17a2e3f8ba8c35", TEXT),
            ("  status:  ready", TEXT),
        ],
        1.9,
    ),
    (
        "drip start --threads 1",
        [
            ("Mining started", HEADER),
            ("  threads: 1", TEXT),
            ("  pool:    stratum+ssl://p3333.m269.opf-mainnet-rofl-55.rofl.app:443", TEXT),
            ("  log:     ~/.config/drip/xmrig.log", MUTED),
        ],
        2.1,
    ),
    (
        "drip status",
        [
            ("Local miner", HEADER),
            ("  status: running", TEXT),
            ("", TEXT),
            ("Pool", HEADER),
            ("  upstream: connected", COMMAND),
            ("  shares:   1", TEXT),
            ("  work:     20,000", TEXT),
            ("  owed:     740 atomic xmr", ACCENT),
        ],
        2.8,
    ),
    (
        "drip checkpoint",
        [
            ("Voucher checkpoint", HEADER),
            ("  cumulative: 740", ACCENT),
            ("  cache:      updated", COMMAND),
        ],
        1.8,
    ),
    (
        "drip withdraw base-sepolia eth 0x1111111111111111111111111111111111111111",
        [
            ("Withdraw preview", HEADER),
            ("  target:    base-sepolia eth", TEXT),
            ("  recipient: 0x1111111111111111111111111111111111111111", TEXT),
            ("  status:    ready for relayer handoff", COMMAND),
        ],
        2.6,
    ),
    (
        "drip stop",
        [
            ("Mining stopped", HEADER),
            ("  local XMRig process stopped", TEXT),
            ("  voucher helper stopped", TEXT),
        ],
        1.6,
    ),
]


def visible_transcript(t: float) -> list[tuple[str, str]]:
    lines: list[tuple[str, str]] = [
        ("drip core flow", ACCENT),
        ("proof-of-work faucet CLI", MUTED),
        ("", TEXT),
    ]
    elapsed = 0.45
    for command, output, duration in STEPS:
        command_time = min(0.9, max(0.45, len(command) * 0.018))
        output_time = duration - command_time
        if t < elapsed:
            break

        local = t - elapsed
        if local < command_time:
            chars = max(0, min(len(command), math.floor(len(command) * local / command_time)))
            lines.append(("$ " + command[:chars] + "█", COMMAND))
            break

        lines.append(("$ " + command, COMMAND))
        reveal = min(1.0, max(0.0, (local - command_time) / max(output_time, 0.01)))
        shown = math.floor(len(output) * reveal + 0.001)
        for line in output[:shown]:
            lines.append(line)
        if shown < len(output):
            lines.append(("", TEXT))
            break
        lines.append(("", TEXT))
        elapsed += duration

    if t > SECONDS - 1.1:
        lines.append(("core loop complete", ACCENT))

    return lines[-MAX_VISIBLE_LINES:]


def draw_frame(t: float) -> Image.Image:
    image = Image.new("RGB", (WIDTH, HEIGHT), BG)
    draw = ImageDraw.Draw(image)

    draw.rounded_rectangle((32, 32, WIDTH - 32, HEIGHT - 32), radius=18, fill=PANEL)
    draw.ellipse((58, 55, 76, 73), fill="#f38ba8")
    draw.ellipse((86, 55, 104, 73), fill="#f9e2af")
    draw.ellipse((114, 55, 132, 73), fill="#a6e3a1")
    draw.text((WIDTH - 255, 54), "drip / local miner", fill=MUTED, font=SMALL)

    y = TOP
    for line, color in visible_transcript(t):
        draw.text((LEFT, y), line, fill=color, font=FONT)
        y += LINE

    progress = min(1.0, t / SECONDS)
    draw.rounded_rectangle((56, HEIGHT - 60, WIDTH - 56, HEIGHT - 52), radius=4, fill="#313244")
    draw.rounded_rectangle(
        (56, HEIGHT - 60, 56 + int((WIDTH - 112) * progress), HEIGHT - 52),
        radius=4,
        fill=CURSOR,
    )
    return image


def main() -> None:
    if FRAMES.exists():
        shutil.rmtree(FRAMES)
    FRAMES.mkdir(parents=True)
    OUT.parent.mkdir(parents=True, exist_ok=True)

    frame_count = FPS * SECONDS
    for index in range(frame_count):
        image = draw_frame(index / FPS)
        image.save(FRAMES / f"frame-{index:04d}.png")

    subprocess.run(
        [
            "ffmpeg",
            "-y",
            "-framerate",
            str(FPS),
            "-i",
            str(FRAMES / "frame-%04d.png"),
            "-c:v",
            "libx264",
            "-pix_fmt",
            "yuv420p",
            "-movflags",
            "+faststart",
            str(OUT),
        ],
        check=True,
    )


if __name__ == "__main__":
    main()
