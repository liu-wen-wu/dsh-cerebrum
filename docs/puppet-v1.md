# 分片角色 v1：表情木偶（用 dsh-pet 原始素材）

> 目标：先把「情绪 → 表情、点击 → 反应、待机动画」的闭环跑通，再决定要不要做 Live2D 分片。
> **注意**：dsh-pet 的素材是**表情包**（单帧 meme 图），不是可拆分的立绘；要"完整角色"需要自己提供分层立绘（见文末）。

## 怎么看

```powershell
# DSH 运行中时（宿主 brain API 默认 18734）
start http://127.0.0.1:18734/puppet
```

- 每 4 秒拉一次 `/render-hints` + `/state`：情绪 → meme 表情 + 待机动画（呼吸/跳/抖/降饱和）；
- **点击她 = 摸头**：`GET /interact?kind=pet` → cerebrum 评价 → 表情/台词立即变；
- 素材来源：安装的 dsh-pet（`assets/memes/*.png`），本地只读；**不随本仓库/包分发**（CC BY-NC-SA）。

## 情绪 → 表情映射

| 情绪 key | meme | 动作 |
|---|---|---|
| joy | 可爱 | 跳两下 |
| gratitude / pride | 厉害了我的鲸 | 跳 |
| relief / contentment | 吃饱饱摸肚子 | 呼吸放缓 |
| curiosity / confusion | 大师这个区是什么意思 | 歪头（CSS） |
| hope | 大的药来了 | 跳 |
| fear / anxiety | 压力一只大肥鱼 | 发抖 |
| anger | 电死你 | 抖动 |
| guilt | 完蛋了把黄油删了 | 降饱和 |
| shame | 哪来的电脑病毒 | 降饱和 |
| sadness / frustration | 死掉了 | 降饱和 |
| surprise | 大的要来啦 | 抖 |
| calm | 哦鲸鲸 | 呼吸 |

映射表在 `assets/puppet/index.html` 的 `MEME_BY_EMOTION`，新增情绪/换图只改这一个对象。

## 坐标校准（对齐不同立绘）

表情特效按立绘坐标叠加（viewBox 0 0 406 376），默认锚点是按当前桌宠图估的。打开：

```
/puppet?debug=1
```

会显示网格 + 4 个锚点（眼睛 ×2 红点、嘴 绿点、腮红 ×2 橙点）。用 URL 参数实时微调，直到对准：

```
/puppet?debug=1&eyeL=166&eyeR=242&eyeY=150&mouthX=203&mouthY=190&cheekY=182
```

可调参数：`eyeL eyeR eyeY eyeRx eyeRy mouthX mouthY cheekL cheekR cheekY browY skin`（`skin` 是遮罩肤色，默认 `#f6e7e2`）。
校准好把值写进页面 `A` 对象即可（或告诉我数值，我固化）。


## 数据流

```
cerebrum /render-hints ──► 页面（emotionKey/intensity/line）
        /state        ──► 页面（valence/arousal/记忆数）
        /interact     ◄── 点击摸头（唯一允许的情绪写入）
        /asset/meme-* ◄── 本地 PNG（旧宿主回退路径）
        /puppet/memes ◄── 新版宿主直接给出清单（指向 dsh-pet 安装目录）
```

## 为什么不是"分片部件"

真正的分片（head/eye/mouth/arm/tail 各自 PNG + 轴心 + 骨骼）需要**分层立绘**：

1. 找原画/自己画 2 套以上表情的**分层 PSD**（2048px，按部件命名）；
2. 导出透明 PNG 到 `assets/puppet/parts/`；
3. 把页面里 `<img id="face">` 换成按部件拼装的 `<canvas>`/`<svg>`；
4. 需要骨骼、物理、眼神跟随时，走 Live2D（Cubism）导出 `.model3.json`，接 dsh-pet-live2d。

**现在这版适合先验证情绪闭环**，视觉上是"表情包会说话"，不是"完整角色"。

## 限制

- meme 图是单帧、带自带背景/文字，作为"本体"会有跳变感；
- 页面是普通窗口，不置顶（置顶走 dsh-pet / Live2D）；
- 素材版权：CC BY-NC-SA 4.0（署名、非商用、同协议），仅本地使用，不入库。

## 下一步选项

1. **继续表情包路线**：把 27 张 meme 全接进情绪映射 + 加"随机自言自语"，1 天内可完成；
2. **真分片**：你提供/绘制分层立绘，我做部件拼装 + 参数化表情（眼睛/嘴/眉毛）；
3. **Live2D**：按 `docs/pet-autonomy.md` §6 的流程做，dsh-pet-live2d 直接认模型。
