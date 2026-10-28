"""Render the v3 forgetting-curve figure (power law vs exponential, spacing effect)."""

from __future__ import annotations

import json
import os
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "examples" / ".demo" / "retention.json"
OUT = ROOT / "docs" / "assets" / "forgetting-curves.png"

W, H = 1500, 720
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


F_TITLE = font(32, True)
F_SUB = font(16)
F_H2 = font(20, True)
F_BODY = font(15)
F_SMALL = font(13)


def panel(draw, box, title=None):
    draw.rounded_rectangle(box, radius=14, fill=PANEL, outline=BORDER, width=1)
    if title:
        draw.text((box[0] + 18, box[1] + 12), title, font=F_H2, fill=TEXT)


def main() -> None:
    data = json.loads(DATA.read_text(encoding="utf-8"))
    img = Image.new("RGB", (W, H), BG)
    draw = ImageDraw.Draw(img)

    draw.text((44, 30), "遗忘曲线与持久记忆（v3 保持模型）", font=F_TITLE, fill=TEXT)
    draw.text(
        (44, 76),
        "幂律 R(t) = (1 + 19/81 · t/S)^(−0.5)  ·  稳定性 S 由检索难度与间隔更新  ·  幂律长尾 = 持久记忆",
        font=F_SUB,
        fill=MUTED,
    )

    # ---- Left: retention curves -------------------------------------------
    panel(draw, (44, 116, 900, 520), "不同稳定性的保持曲线（对数时间轴，0.1 天 → 10 年）")
    left, right, top, bottom = 110, 880, 192, 436
    days = data["days"]
    log_min, log_max = -1, 3.6  # log10 days

    def x_of(day):
        value = 0 if day <= 0 else (max(log_min, min(log_max, __import__("math").log10(day))) - log_min) / (log_max - log_min)
        return left + (right - left) * value

    def y_of(r):
        return bottom - (bottom - top) * r

    for i in range(5):
        value = i / 4
        y = y_of(value)
        draw.line([(left, y), (right, y)], fill=GRID, width=1)
        draw.text((left - 10, y - 8), f"{int(value * 100)}%", font=F_SMALL, fill=MUTED, anchor="ra")
    for label, day in [("1h", 1 / 24), ("1d", 1), ("1w", 7), ("1m", 30), ("1y", 365), ("10y", 3650)]:
        x = x_of(day)
        draw.line([(x, top), (x, bottom)], fill=GRID, width=1)
        draw.text((x, bottom + 10), label, font=F_SMALL, fill=MUTED, anchor="ma")

    colors = {
        "weak": (242, 94, 106),
        "medium": (242, 166, 94),
        "strong": (94, 200, 242),
        "permastore": (127, 224, 176),
    }
    for curve in data["curves"]:
        color = colors[curve["key"]]
        pts = [(x_of(d), y_of(r)) for d, r in zip(days, curve["points"]) if d > 0]
        draw.line(pts, fill=color, width=3, joint="curve")

    exp_pts = [(x_of(d), y_of(r)) for d, r in zip(days, data["exponential"]["points"]) if d > 0]
    for i in range(0, len(exp_pts) - 1, 2):
        draw.line([exp_pts[i], exp_pts[i + 1]], fill=(150, 160, 175), width=2)

    # Legend above the plot: endpoint labels collide with the curves.
    legend = [
        ("弱 S=1 天", colors["weak"]),
        ("中 S=10 天", colors["medium"]),
        ("强 S=90 天", colors["strong"]),
        ("图式 S=365 天", colors["permastore"]),
        ("指数（同起点）", (150, 160, 175)),
    ]
    lx = 62
    for label, color in legend:
        draw.line([(lx, 172), (lx + 18, 172)], fill=color, width=3)
        draw.text((lx + 24, 163), label, font=F_SMALL, fill=MUTED)
        lx += 24 + draw.textlength(label, font=F_SMALL) + 20

    # ---- Right: spacing effect -------------------------------------------
    panel(draw, (930, 116, 1456, 520), "间隔效应：同样 6 次复习")
    rx0, rx1, ry0, ry1 = 990, 1436, 192, 436

    def x2(day):
        return rx0 + (rx1 - rx0) * min(day, 365) / 365

    def y2(r):
        return ry1 - (ry1 - ry0) * r

    for i in range(5):
        value = i / 4
        y = y2(value)
        draw.line([(rx0, y), (rx1, y)], fill=GRID, width=1)
        draw.text((rx0 - 8, y - 8), f"{int(value * 100)}%", font=F_SMALL, fill=MUTED, anchor="ra")
    for day in (0, 90, 180, 270, 365):
        x = x2(day)
        draw.text((x, ry1 + 10), f"{day}d", font=F_SMALL, fill=MUTED, anchor="ma")

    for key, color, label in (("massed", (242, 94, 106), "集中复习"), ("spaced", (127, 224, 176), "间隔复习")):
        schedule = data["spacing"][key]
        series = schedule["series"]
        pts = [(x2(point["day"]), y2(point["r"])) for point in series]
        draw.line(pts, fill=color, width=3, joint="curve")
        for mark in schedule["marks"]:
            x, y = x2(mark["day"]), y2(mark["r"])
            draw.ellipse([x - 4, y - 4, x + 4, y + 4], outline=color, width=2)
        draw.text(
            (rx0 + 6, 468 if key == "spaced" else 490),
            f"{label}：S={schedule['stability']} 天 · 365 天保有 {int(schedule['day365'] * 100)}%",
            font=F_SMALL,
            fill=color,
        )

    draw.text((rx0 + 6, 508), "圈 = 一次成功复习（复习后回到 100%）", font=font(11), fill=MUTED)

    # ---- Footer ----------------------------------------------------------
    draw.rounded_rectangle([44, 548, 1456, 672], radius=12, fill=PANEL, outline=BORDER)
    draw.text((64, 560), "读法", font=F_H2, fill=TEXT)
    draw.text((64, 592), "· 同样 90% 的起点，指数模型约 10 年后归零，幂律模型仍保留 10–55%（取决于稳定性）。", font=F_BODY, fill=MUTED)
    draw.text((64, 616), "· 弱记忆（S=1 天）10 年后 3.4%，图式/永久候选（S=365 天）54.7%：这正是“持久记忆”的数学形态。", font=F_BODY, fill=MUTED)
    draw.text((64, 640), "· 间隔复习（1/3/7/16/35/75 天）比集中复习（每天）多出约 60% 稳定性，365 天后保有率高 12 个百分点。", font=F_BODY, fill=MUTED)

    OUT.parent.mkdir(parents=True, exist_ok=True)
    img.save(OUT)
    print(f"wrote {OUT}")


if __name__ == "__main__":
    main()
