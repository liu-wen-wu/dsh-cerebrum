"""Render the retention (20y) + daily-token forecast figure."""

from __future__ import annotations

import json
import math
import os
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "examples" / ".demo" / "forecast.json"
OUT = ROOT / "docs" / "assets" / "forecast.png"

W, H = 1500, 640
BG = (13, 20, 32)
PANEL = (16, 26, 40)
BORDER = (31, 44, 63)
TEXT = (219, 228, 238)
MUTED = (125, 142, 163)
GRID = (36, 50, 68)


def font(size: int, bold: bool = False):
    for path in (
        "C:/Windows/Fonts/msyhbd.ttc" if bold else "C:/Windows/Fonts/msyh.ttc",
        "C:/Windows/Fonts/simhei.ttf",
        "C:/Windows/Fonts/arial.ttf",
    ):
        if os.path.exists(path):
            try:
                return ImageFont.truetype(path, size)
            except OSError:
                continue
    return ImageFont.load_default()


F_TITLE = font(30, True)
F_SUB = font(15)
F_H2 = font(19, True)
F_SMALL = font(12)


def panel(draw, box, title=None):
    draw.rounded_rectangle(box, radius=14, fill=PANEL, outline=BORDER, width=1)
    if title:
        draw.text((box[0] + 18, box[1] + 12), title, font=F_H2, fill=TEXT)


def main() -> None:
    data = json.loads(DATA.read_text(encoding="utf-8"))
    img = Image.new("RGB", (W, H), BG)
    draw = ImageDraw.Draw(img)

    draw.text((44, 28), "记忆保持率（20 年）与日常 token 成本", font=F_TITLE, fill=TEXT)
    draw.text(
        (44, 74),
        f"幂律 R(t,S) = (1 + {data['assumptions']['powerLaw'].split('=')[1].strip()}) · 每轮成本受常驻/情节/工作记忆上限约束",
        font=F_SUB,
        fill=MUTED,
    )

    # ---- Left: retention over 0..20y ----
    panel(draw, (44, 106, 880, 560), "保持率 vs 时间（对数横轴，0.1 → 20 年）")
    left, right, top, bottom = 108, 860, 158, 508
    log_min, log_max = -1, 3.86

    def x_of(day):
        value = 0 if day <= 0 else (max(log_min, min(log_max, math.log10(day))) - log_min) / (log_max - log_min)
        return left + (right - left) * value

    def y_of(r):
        return bottom - (bottom - top) * r

    for i in range(5):
        value = i / 4
        y = y_of(value)
        draw.line([(left, y), (right, y)], fill=GRID, width=1)
        draw.text((left - 10, y - 7), f"{int(value * 100)}%", font=F_SMALL, fill=MUTED, anchor="ra")
    for label, day in [("1d", 1), ("1m", 30), ("1y", 365), ("10y", 3650), ("20y", 7300)]:
        x = x_of(day)
        draw.line([(x, top), (x, bottom)], fill=GRID, width=1)
        draw.text((x, bottom + 10), label, font=F_SMALL, fill=MUTED, anchor="ma")

    F = 19 / 81  # RETENTION_FACTOR in lib/core/retention.js
    colors = {
        1: (242, 94, 106),
        10: (242, 166, 94),
        90: (94, 200, 242),
        365: (127, 224, 176),
        3650: (224, 140, 240),
        7300: (240, 240, 240),
    }
    labels = {1: "S=1 天", 10: "S=10 天", 90: "S=90 天", 365: "S=365 天", 3650: "S=10 年", 7300: "S=20 年"}
    days = [0.1 * (200 ** (i / 120)) for i in range(121)]
    for S, color in colors.items():
        pts = [(x_of(d), y_of((1 + F * d / S) ** -0.5)) for d in days]
        draw.line(pts, fill=color, width=3, joint="curve")
    lx = 62
    for S, color in colors.items():
        draw.line([(lx, 118), (lx + 16, 118)], fill=color, width=3)
        draw.text((lx + 22, 110), labels[S], font=F_SMALL, fill=MUTED)
        lx += 24 + draw.textlength(labels[S], font=F_SMALL) + 18

    # ---- Right: daily tokens ----
    panel(draw, (910, 106, 1456, 560), "日常 token 成本（随每日轮数线性增长）")
    rx0, rx1, ry0, ry1 = 966, 1440, 170, 500
    turn_rates = data["tokenCost"]["turnRates"]
    scenarios = data["tokenCost"]["scenarios"]
    colors2 = {0: (242, 94, 106), 1: (94, 200, 242), 2: (127, 224, 176)}
    max_tokens = max(s["dailyTokens"][str(n)] for s in scenarios for n in turn_rates)

    def x2(n):
        return rx0 + (rx1 - rx0) * (n / turn_rates[-1])

    def y2(v):
        return ry1 - (ry1 - ry0) * (v / max_tokens)

    for i in range(5):
        value = i / 4
        y = y2(max_tokens * value)
        draw.line([(rx0, y), (rx1, y)], fill=GRID, width=1)
        draw.text((rx0 - 8, y - 7), f"{int(max_tokens * value / 1000)}k", font=F_SMALL, fill=MUTED, anchor="ra")
    for n in turn_rates:
        draw.text((x2(n), ry1 + 10), f"{n}", font=F_SMALL, fill=MUTED, anchor="ma")
    for idx, scenario in enumerate(scenarios):
        pts = [(x2(n), y2(scenario["dailyTokens"][str(n)])) for n in turn_rates]
        draw.line(pts, fill=colors2[idx], width=3, joint="curve")
        draw.text((rx0 + 8, 112 + idx * 24), f"{scenario['name']}：每轮 ~{scenario['perTurnTokens']}t", font=F_SMALL, fill=colors2[idx])

    draw.text((966, 520), "注：情节记忆只在置信达标时注入（单胜者），常驻层有 360 字符上限。", font=font(11), fill=MUTED)

    OUT.parent.mkdir(parents=True, exist_ok=True)
    img.save(OUT)
    print(f"wrote {OUT}")


if __name__ == "__main__":
    main()
