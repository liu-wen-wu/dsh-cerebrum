"""Render examples/.demo/timeline.json into a dark dashboard PNG (Pillow only)."""

from __future__ import annotations

import json
import os
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "examples" / ".demo" / "timeline.json"
OUT = ROOT / "examples" / ".demo" / "cerebrum-dashboard.png"

W, H = 1500, 980
BG = (13, 20, 32)
PANEL = (16, 26, 40)
BORDER = (31, 44, 63)
TEXT = (219, 228, 238)
MUTED = (125, 142, 163)
ACCENT = (94, 200, 242)
GRID = (36, 50, 68)


def font(size: int, bold: bool = False) -> ImageFont.FreeTypeFont:
    candidates = [
        "C:/Windows/Fonts/msyhbd.ttc" if bold else "C:/Windows/Fonts/msyh.ttc",
        "C:/Windows/Fonts/simhei.ttf",
        "C:/Windows/Fonts/arial.ttf",
    ]
    for path in candidates:
        if os.path.exists(path):
            try:
                return ImageFont.truetype(path, size)
            except OSError:
                continue
    return ImageFont.load_default()


F_TITLE = font(34, True)
F_SUB = font(17)
F_H2 = font(20, True)
F_BODY = font(16)
F_SMALL = font(13)
F_TINY = font(12)


def lerp_color(a, b, t):
    return tuple(int(a[i] + (b[i] - a[i]) * t) for i in range(3))


def panel(draw, box, title=None):
    x0, y0, x1, y1 = box
    draw.rounded_rectangle(box, radius=14, fill=PANEL, outline=BORDER, width=1)
    if title:
        draw.text((x0 + 18, y0 + 14), title, font=F_H2, fill=TEXT)


def chart(draw, box, series, ymin, ymax, labels, colors, ylabel=None):
    x0, y0, x1, y1 = box
    left, right, top, bottom = x0 + 58, x1 - 18, y0 + 18, y1 - 34
    # grid + y labels
    for i in range(5):
        value = ymin + (ymax - ymin) * i / 4
        y = bottom - (bottom - top) * i / 4
        draw.line([(left, y), (right, y)], fill=GRID, width=1)
        draw.text((left - 8, y - 7), f"{value:.1f}", font=F_TINY, fill=MUTED, anchor="ra")
    n = len(labels)
    if n == 0:
        return
    for idx, values in enumerate(series):
        pts = []
        for i, value in enumerate(values):
            x = left + (right - left) * (i / max(n - 1, 1))
            y = bottom - (bottom - top) * (value - ymin) / (ymax - ymin)
            pts.append((x, y))
        draw.line(pts, fill=colors[idx], width=3, joint="curve")
        for x, y in pts:
            draw.ellipse([x - 3, y - 3, x + 3, y + 3], fill=colors[idx])
    for i, label in enumerate(labels):
        x = left + (right - left) * (i / max(n - 1, 1))
        draw.text((x, bottom + 8), label, font=F_TINY, fill=MUTED, anchor="ma")


def main() -> None:
    data = json.loads(DATA.read_text(encoding="utf-8"))
    timeline = data["timeline"]
    final = data["finalState"]
    verdict = data["verdict"]

    img = Image.new("RGB", (W, H), BG)
    draw = ImageDraw.Draw(img)

    # Header
    draw.text((48, 34), "dsh-cerebrum · 仿脑认知架构运行轨迹", font=F_TITLE, fill=TEXT)
    draw.text(
        (48, 82),
        f"生成 {data['generatedAt']}   ·   {final['personality']['label']}   ·   "
        f"情景记忆 {final['memory']['episodes']} 条 / 概念 {final['memory']['concepts']} 个   ·   "
        f"工作记忆 {len(final.get('workingMemory', []))}/4   ·   补全 {final['memory'].get('completions', 0)} 次   ·   永久候选 {final['memory'].get('permastore', 0)}",
        font=F_SUB,
        fill=MUTED,
    )

    # Stat strip
    stats = [
        ("当前情绪", f"{final['affect']['emotion']['label']} · {final['affect']['emotion']['intensity']:.2f}", "情绪强度"),
        ("效价 valence", f"{final['affect']['valence']:+.2f}", "−1 消极 … +1 积极"),
        ("唤醒 arousal", f"{final['affect']['arousal']:.2f}", "0 平静 … 1 高唤醒"),
        ("DA / 5-HT", f"{final['neuromods']['da']:.2f} / {final['neuromods']['ser']:.2f}", "奖赏 / 耐心"),
        ("NE / ACh", f"{final['neuromods']['ne']:.2f} / {final['neuromods']['ach']:.2f}", "警觉 / 学习率"),
    ]
    sx, sy, sw, sh = 48, 118, 274, 82
    for i, (label, value, sub) in enumerate(stats):
        x = sx + i * (sw + 14)
        draw.rounded_rectangle([x, sy, x + sw, sy + sh], radius=12, fill=PANEL, outline=BORDER)
        draw.text((x + 14, sy + 10), label, font=F_TINY, fill=MUTED)
        draw.text((x + 14, sy + 28), value, font=font(21, True), fill=TEXT)
        draw.text((x + 14, sy + 58), sub, font=F_TINY, fill=MUTED)

    labels = [f"T{r['turn']}" for r in timeline]

    # Emotion + core affect
    panel(draw, (48, 222, 1452, 552), "核心情感与情绪强度（每个点为一次评价结果）")
    chart(
        draw,
        (48, 268, 1452, 462),
        [
            [r["valence"] for r in timeline],
            [r["mood"] for r in timeline],
            [r["arousal"] * 2 - 1 for r in timeline],
        ],
        -1,
        1,
        labels,
        [(94, 200, 242), (143, 123, 240), (242, 166, 94)],
    )
    legend = [("效价", (94, 200, 242)), ("心境", (143, 123, 240)), ("唤醒（映射到 −1..1）", (242, 166, 94))]
    lx = 1020
    for name, color in legend:
        draw.line([(lx, 242), (lx + 22, 242)], fill=color, width=3)
        draw.text((lx + 28, 233), name, font=F_TINY, fill=MUTED)
        lx += 36 + draw.textlength(name, font=F_TINY)

    # Emotion strip
    strip_y = 500
    emotion_colors = {
        "joy": (242, 208, 94), "gratitude": (242, 166, 94), "pride": (224, 140, 240),
        "relief": (127, 214, 193), "curiosity": (94, 200, 242), "calm": (125, 142, 163),
        "frustration": (242, 94, 106), "anxiety": (242, 166, 94), "fear": (201, 79, 124),
        "sadness": (94, 107, 143), "anger": (224, 82, 82), "guilt": (160, 107, 214),
        "shame": (138, 107, 176), "hope": (168, 214, 94), "contentment": (143, 214, 168),
    }
    for i, row in enumerate(timeline):
        x = 150 + (1250) * (i / max(len(timeline) - 1, 1))
        r = 8 + row["intensity"] * 12
        color = emotion_colors.get(row["emotionKey"], (125, 142, 163))
        draw.ellipse([x - r, strip_y - r, x + r, strip_y + r], fill=color)
        draw.text((x, strip_y + 26), row["emotion"], font=F_TINY, fill=MUTED, anchor="ma")

    # Neuromodulators
    panel(draw, (48, 570, 1452, 860), "神经调质：DA 奖赏 / 5-HT 耐心 / NE 警觉 / ACh 学习率")
    chart(
        draw,
        (48, 610, 1452, 830),
        [
            [r["neuromods"]["da"] for r in timeline],
            [r["neuromods"]["ser"] for r in timeline],
            [r["neuromods"]["ne"] for r in timeline],
            [r["neuromods"]["ach"] for r in timeline],
        ],
        0,
        1,
        labels,
        [(242, 208, 94), (94, 242, 166), (242, 94, 106), (94, 155, 242)],
    )
    lx = 1010
    for name, color in [("DA", (242, 208, 94)), ("5-HT", (94, 242, 166)), ("NE", (242, 94, 106)), ("ACh", (94, 155, 242))]:
        draw.line([(lx, 840), (lx + 20, 840)], fill=color, width=3)
        draw.text((lx + 26, 831), name, font=F_TINY, fill=MUTED)
        lx += 34 + draw.textlength(name, font=F_TINY)

    # Verdict footer
    draw.rounded_rectangle([48, 872, 1452, 956], radius=12, fill=PANEL, outline=BORDER)
    draw.text((66, 884), "判断系统", font=F_SMALL, fill=MUTED)
    draw.text(
        (66, 904),
        f"{verdict['system']} · 置信 {verdict['confidence'] * 100:.0f}% · 建议：{verdict['choice']}",
        font=F_BODY,
        fill=(127, 224, 176),
    )
    draw.text((66, 930), verdict["question"], font=F_TINY, fill=MUTED)

    img.save(OUT)
    print(f"wrote {OUT}")


if __name__ == "__main__":
    main()
