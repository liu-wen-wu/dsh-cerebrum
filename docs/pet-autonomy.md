# 让大肥鱼拥有自主性、学习能力，以及能自己/被动地长出新动作

> 目标：宠物不再只是"事件→动画"的反映器，而是有内部驱动、会从结果里学、还能在运行时扩展动作库的个体。
> 所有能力都建立在已有的两套系统上：dsh-cerebrum（大脑：情绪/目标/技能/记忆）+ dsh-pet（外壳：锁/动画/气泡/碎碎念）。

## 1. 自主性：从"被事件驱动"到"被内部状态驱动"

### 1.1 驱动模型（urgency）

每 5 秒（面板轮询同一拍）计算一次"此刻想不想做点什么"：

```
urgency = 0.45·情绪强度 + 0.25·沉默时长 + 0.20·(DA−0.5)·2 + 0.10·随机
```

| 项 | 来源 | 直觉 |
|---|---|---|
| 情绪强度 | `affect.emotion.intensity` | 越激动越想表达 |
| 沉默时长 | 距上次会话活动（5 分钟封顶） | 没人理我，我该刷存在感 |
| 多巴胺 | `neuromods.da` | 奖励/动机高时更爱主动 |
| 随机 | 探索噪声 | 防止神经系统变成钟摆 |

`urgency > 0.55` 且距上次自主行为 ≥ 90 秒 → 执行一个动作。阈值与冷却在 `config.ui.autonomy`（默认开）。

### 1.2 动作空间

| 动作 | 实现 | 频率 |
|---|---|---|
| 播放注册的动作/表情 | `lock` → `POST /dsh-pet-7340/anim {url}` → `release` | 主体（按情绪匹配 + 权重） |
| 说话 | `POST /broadcast {text}`（情绪台词来自 `/render-hints`） | 由既有桥接负责 |
| 模型碎碎念 | `POST /whisper`（由 dsh-pet 调模型生成） | 可选、低频（成本） |
| 内部整理 | 触发巩固（不产生画面） | 空闲时 |

### 1.3 与既有桥接的分工

- **桥接**（已实现）：情绪**变化**时推一次台词，保证"表情跟得上心情"；
- **自主层**（本次实现）：情绪**持续**高位、或长时间无人互动时，主动做一个动作。
- 两者共用同一把占用锁，不会打架（锁住即独占演出）。

## 2. 学习能力：结果驱动的权重

### 2.1 动作层面的学习（已经实现）

```
播放动作 → 记录 (assetId, turnSum, at)
  ├─ 120 秒内用户有互动（turnMemory 变化）→ 权重 +0.12（成功）
  └─ 120 秒内无互动              → 权重 −0.08（失败）
权重 ∈ [0.05, 1]，下次按权重 softmax/轮盘选择
```

权重存在浏览器 `localStorage['cerebrum.petWeights']`，主机侧 `pet-assets.json` 也记录 `uses/successes`。
效果：**没人理的表情会自然退场，被互动的表情越用越顺手**。

### 2.2 语义层面的学习（复用大脑既有机制）

- 每次互动的情绪结果写入 affect → 影响以后的 `render-hints`（同一动作会对应不同台词）；
- 重复出现的"情境→结果"通过 `cerebrum_consolidate` 沉淀成 **skills**（when→do），自主层可优先执行被技能覆盖的动作；
- 好感度（affinity）是情绪史积分，决定宠物**主动程度**与语气（未来可把 urgency 系数挂到 affinity 上）。

### 2.3 未来的增强（路线图）

- 上下文 bandit：按"用户忙/闲 + 时间段"分组学习，而不仅是全局权重；
- 技能成型：`{情绪, 时间, 最近失败} → 动作` 的规则由巩固自动生成；
- 负反馈学习：被"批评"（scold 互动）时，对应的动作权重额外惩罚。

## 3. 动态增加新动作/表情

### 3.1 被动添加（用户投喂，已实现）

```powershell
# 1. 把素材放进目录（webm/mp4/gif/png/jpg/webp，≤10MB）
C:\Users\<you>\.dsh\cerebrum\pet-assets\开心转圈.webm

# 2. 让模型注册它（或直接调工具）
cerebrum_pet_asset {
  operation: "add",
  file: "开心转圈.webm",
  emotion: "joy",          # 对应哪种情绪下播放
  tags: ["庆祝", "转圈"]
}
# → 返回 publicUrl: http://127.0.0.1:18734/asset/开心转圈.webm
```

- 主机新增只读端点 `GET /asset/<name>`（路径净化、扩展名白名单、10MB 上限、同源/Host 校验）；
- 自主层从 `GET /pet-assets?emotion=joy` 取候选，用 dsh-pet 的 `POST /anim {url}` 播放；
- 也支持远程素材：`url: "https://cdn.example.com/xxx.webm"`（dsh-pet 要求 http/https）。

**素材规范**：透明 webm（VP9 alpha）或动图；建议 360p 以内、2–6 秒循环友好。

### 3.2 主动生成（模型侧）

- **台词/气泡**：已经无限——`broadcast`/`whisper` 由模型写；
- **表情包**：dsh-pet 自带 23 张 meme（`GET /config` 可见名称+描述，如"哪来的电脑病毒"），模型可以按情绪语义选择并配上文字；
- **组合动作**：把 `anim → 停顿 → broadcast → throw` 编排成"小剧场"（占用锁内完成），无需新素材即可产生新行为；
- **真·新画面**需要图像/视频生成模型，属于后续接入项（生成 → 写入 pet-assets → 自动注册）。

### 3.3 与 dsh-pet 原生机制的关系

| 能力 | 归属 |
|---|---|
| 播放任意动画（含远程 URL） | dsh-pet `/anim` |
| 占用/释放演出锁 | dsh-pet `/lock` |
| 气泡文本 / 模型碎碎念 | dsh-pet `/broadcast` `/whisper` |
| 动作注册、情绪绑定、权重学习 | **dsh-cerebrum（本插件）** |
| 素材托管（只读） | **dsh-cerebrum `/asset`** |

## 4. 数据与配置

| 项 | 位置 |
|---|---|
| 素材 | `$DSH_HOME/cerebrum/pet-assets/` |
| 注册表 | `$DSH_HOME/cerebrum/pet-assets/pet-assets.json` |
| 学习权重（浏览器侧） | `localStorage['cerebrum.petWeights']` |
| 开关 | `ui.autonomy`（默认 true）、`ui.drivePet`（默认 true） |
| 节奏 | 冷却 90 秒、阈值 0.55、无互动判定 120 秒（可调常量） |

## 5. 验收方式

```powershell
# 注册一个素材后
curl http://127.0.0.1:18734/pet-assets?emotion=joy
# 等 1–2 分钟不发言，观察桌面大肥鱼是否主动播放该动作
# 摸头/回话 → 该动作权重上升；继续无视 → 权重下降
```

测试覆盖：`test/petassets.test.mjs`（注册/权重边界/情绪匹配/静态服务/路径穿越防护）。
