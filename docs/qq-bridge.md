# QQ 通道：让大肥鱼在 QQ 里说话

> 现状：**发送已打通**（UI 自动化，验证过粘贴回读）；**接收/双向聊天**需要额外的协议端（NapCat/LLOneBot）或脆弱的 UI 轮询。

## 1. 已实现：发送（scripts/qq-send.ps1）

```powershell
# 消息文本走 base64（避免 PowerShell 编码问题）
$msg = "🐋 任务完成，记得看一眼~"
$b64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($msg))
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\qq-send.ps1 -TextB64 $b64
```

原理：

1. 找到 `QQ` 主窗口 → `SetForegroundWindow` 置前（**不是前台就中止**，避免误输入到别的窗口）；
2. 点击输入框（窗口底部 `bottom-30` 处，坐标已实测校准）；
3. 把文本放进剪贴板 → `Ctrl+V` → **`Ctrl+A`/`Ctrl+C` 回读校验**（确认粘贴确实落在输入框）；
4. 校验通过才按 `Enter` 发送；失败返回 exit 2，绝不盲发。

限制：

- 只发送到**当前打开的会话**，不切换聊天对象；
- QQ NT 是 Chromium 壳，无障碍树默认关闭（UIA 只能看到 `Chrome Legacy Window`），无法可靠定位控件；
- QQ 更新后输入框位置可能变化（需要重新校准 `bottom-30`）。

## 2. 接收：两条路

### A. 协议端（推荐，双向聊天）

QQ NT 的第三方协议端（如 **NapCatQQ** / **LLOneBot**）会启动本地 HTTP/WebSocket 服务，暴露：

```
POST /send_msg        {message_type:"private", user_id, message}
GET  /get_msg         拉取新消息（带 sender、群号、时间）
WS   订阅事件         message / notice / request …
```

接入方式（一次性）：

1. 安装协议端并登录同一个 QQ；
2. 记下它的 `http://127.0.0.1:<port>` 与 token；
3. 在 cerebrum 侧加一个 `qq` provider（同 imagegen 的 provider 结构）：
   - 拉消息 → 写入情景记忆（`cerebrum_remember`，标签 `qq`）→ 触发 appraisal；
   - 生成回复（petbrain 的 `render-hints` 台词，或经模型）；
   - 调 `/send_msg` 发出；
4. 好处：有发送者/会话区分、可群聊、可多轮上下文、不依赖窗口坐标。

### B. UI 轮询（无安装，但脆弱）

实测：`Ctrl+A`/`Ctrl+C` 在消息区只能复制**单条**消息，且**没有发送者信息**；无法稳定区分"我方/对方"。
可用于「检测有变化 → 通知我」的粗略场景，不适合真正多轮对话。

## 3. 单向播报（现在就能用，安全）

把 QQ 当作通知通道：

| 触发 | 消息 |
|---|---|
| 任务完成/失败 | 「🐋 任务完成：<标题>（耗时 X 分钟）」 |
| 情绪强波动 | 用 petbrain 台词发一句 |
| 持久记忆写入 | 「记住啦：<摘要>」 |
| 定时问候 | cron 触发（dsh schedule） |

配合 `scripts/qq-send.ps1`，用 DSH 的定时任务或 hook 调用即可。

## 4. 安全与卫生

- 只发到当前会话；不切换联系人；
- 发送前校验粘贴回读，避免发空/发错；
- 不读取消息内容时，不把 QQ 数据写进记忆；
- 正式双向接入时，QQ 消息应按「用户数据」对待：写入前脱敏，允许关闭。
