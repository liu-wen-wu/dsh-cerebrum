# 分片角色 v1：自渲染木偶

> 目标：先把「情绪 → 表情、点击 → 反应、呼吸/眨眼」的闭环跑通，再决定要不要接 dsh-pet。
> V1 不依赖 dsh-pet、ffmpeg、任何美术素材——**先验证结构，再换皮**。

## 怎么看

```powershell
# DSH 运行中时（宿主 brain API 默认 18734）
start http://127.0.0.1:18734/puppet
```

- 每 4 秒拉一次 `/render-hints` + `/state`：情绪 → 表情（happy/sad/angry 类 + 腮红 + 小鱼干）；
- 呼吸、眨眼是纯 CSS/JS，不耗网络；
- **点击她 = 摸头**：页面直接 `GET /interact?kind=pet`，cerebrum 做评价、返回新台词，气泡显示。

## 分片结构（当前 SVG 里的部件）

```
tail        尾巴（独立 transform，摆动动画）
body        身体 + 肚子
head        头
hair_front  前发 + 呆毛
ear_l/r     耳鳍
eye_l/r     眼睛（眨眼用 scaleY，瞳孔可做视线跟随）
brow_l/r    眉毛（愤怒时旋转）
blush_l/r   腮红（感激/害羞/开心时显示）
mouth       嘴型（当前用路径，可换参数化）
fish        小鱼干道具（满足/开心时出现）
```

这些 `<g>`/`<path>` 就是"分片"：每片有独立的 `id`、变换原点、可独立替换。换成真实美术时，把对应元素替换成 `<image href="/puppet/parts/xxx.png" x/y/width/height>` 即可，**页面逻辑一行不用改**。

## 换真实美术的操作

1. 按上面的命名把立绘拆成透明 PNG（建议 2× 分辨率，如 680×760）；
2. 放进 `assets/puppet/parts/`（`/puppet/parts/xxx.png` 会自动被静态路由伺服）；
3. 把 SVG 里对应 `<g>` 替换成 `<image>`，`x/y` 对齐原坐标（viewBox 0 0 340 380）；
4. 需要表情参数化时：眼睛/嘴各画 3 套（睁/半闭/闭，微笑/张嘴/惊讶），用 JS 切换 `href`。

## 与 dsh-pet 的关系（要不要对接？）

| 阶段 | 做法 | 是否需要 dsh-pet |
|---|---|---|
| V1（当前） | 浏览器页面自渲染，验证情绪/互动闭环 | **不需要** |
| V2a 桌面常驻 | 把帧序列导出 **webm/pet pack** → dsh-pet `/anim` | 需要（dsh-pet） |
| V2b 高质量角色 | Live2D 拆分绑定 → `model3.json` → dsh-pet-live2d | 需要（Live2D + dsh-pet） |

我们的桥接层已经按"名字"驱动：`render-hints.expression`（joy/…）和 `animation`（idle/work/…）就是给渲染层用的。V2 时只要把 Live2D expression/motion 名字对齐，**cerebrum 侧无需改动**。

## 限制

- 页面是普通浏览器窗口，不是桌面置顶窗（置顶/穿透要靠 dsh-pet 或 Electron）；
- 没有物理（头发/尾巴摆动是 CSS 近似，不是 Live2D 物理）；
- 当前是占位画风，用来验证结构。

## 下一步

1. 把占位 SVG 换成真实分片 PNG（美术）；
2. 加"参数化表情"表：`{eyes, mouth, brows, blush}` 组合 → 15 情绪；
3. 需要桌面常驻时，导出 pet pack / Live2D，走 V2。
