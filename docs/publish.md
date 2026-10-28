# 发布 dsh-cerebrum 到 DSH 插件市场

> **发布状态（2026-10-28）**
> - GitHub 公开仓库：https://github.com/liu-wen-wu/dsh-cerebrum（main + tag v0.1.1，SSH 推送）
> - npm：`dsh-cerebrum@0.1.1` 已上线（latest；0.1.0 为上一版）
> - 市场收录申请：https://github.com/polang233/dsh-plugin-index/issues/121
> - 本地安装：`dsh-cerebrum@link:D:/workspace/dsh-cerebrum`（desktop profile，已热加载验证）

> 目标市场：dshopen.org（DSH 应用内「插件市场/Discover」读取的社区索引，`https://dshopen.org/index.json`）。
> 收录流程由 [dsh-plugin-index](https://github.com/polang233/dsh-plugin-index) 人工审核：**公开仓库 + 可安装的 npm 版本 + 明确许可证**，三样齐全后提 issue 收录。

## 0. 当前状态（已就绪的部分）

- ✅ `package.json` 已去除 `private`，`name: dsh-cerebrum`（npm 上查无此名，未被占用）
- ✅ `engines.dsh: ">=0.2.0-rc.1 <0.3.0-0"`（索引条目 `versions[].engines.dsh` 来自这里）
- ✅ `dsh.bundle.patch` 指向 `cordis.patch.yml`；`keywords` 含 `dsh`/`dsh-plugin`/`deepseek-harness`
- ✅ MIT `LICENSE` 已补；`files` 白名单 = lib + cordis.patch.yml + docs + README
- ✅ `pnpm pack` 实测：31 个文件，含 lib 全部代码、cordis.patch.yml、LICENSE、docs 与三张图
- ✅ 零运行时依赖、无网络请求、不读 API Key——这三条对「risk-low / install-verified」审核非常有利
- ✅ `npm test` 46 项 + `npm run check`（真实 Cordis 加载）已验证

## 1. 发布到 npm（一次性）

```powershell
# ① 注册 https://www.npmjs.com 账号，然后在本机登录（只需一次）
npm login          # 或 npm adduser；开启 2FA 后登录会要求 OTP

# ② 发布（unscoped 包默认 public）
npm publish --access public

# ③ 验证
npm view dsh-cerebrum
```

**以后每次发新版本**：`npm version patch && npm publish`（改代码后记得先跑 `npm test && npm run check`）。

## 2. 建公开 GitHub 仓库（一次性）

```powershell
git init
git add .
git commit -m "dsh-cerebrum: brain-inspired cognitive architecture"
# 在 github.com 新建仓库 dsh-cerebrum（public），然后：
git remote add origin https://github.com/<你的用户名>/dsh-cerebrum.git
git push -u origin main
```

推完后把仓库地址补进 `package.json`（可选，但有助于索引抓 stars）：

```json
"repository": { "type": "git", "url": "https://github.com/<你的用户名>/dsh-cerebrum.git" },
"homepage": "https://github.com/<你的用户名>/dsh-cerebrum#readme"
```

## 3. 提交收录申请（人工审核）

打开收录表单：<https://github.com/polang233/dsh-plugin-index/issues/new?template=plugin-add.yml>

| 字段 | 填什么 |
|---|---|
| Plugin link | `dsh-cerebrum` 或 `https://github.com/<用户名>/dsh-cerebrum` |
| Summary | 一句话用途 + 特色（脑机制：海马情景记忆/情绪/性格/判断） |
| Additional details | Logo/截图（可用 `docs/assets/cerebrum-dashboard.png`）、测试说明（46 项测试、真实 Cordis 加载验证、零依赖） |

审核要点（维护者原话）：**公开源码、可安装的 npm 版本、明确的许可证**；有 Logo 和完善描述的优先。审核通过后：
- `dshopen.org/index.json` 出现你的条目（DSH 应用内的市场直接可搜到）；
- 可在 README 挂市场徽章：`https://dshopen.org/badge/dsh-cerebrum.json`（like 数）+ `<img src="https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fdshopen.org%2Findex.json&query=...">`。

## 4. 用户侧如何安装（写进 README 的话）

```powershell
# 命令行
dsh plugin --profile desktop add dsh-cerebrum

# 或应用内：插件 → 添加插件 → 输入 dsh-cerebrum → 安装 → 启用 → 重启
```

用户数据目录：`$DSH_HOME/cerebrum/<工作区>/`（一个自我 + 按项目分库），删除目录即可清空记忆。

## 5. 发布前检查清单（每次发布）

- [ ] `npm test` 全绿（51 项）
- [ ] `npm run check` 通过（真实 Cordis 4.0.5 加载）
- [ ] `npm run privacy` 通过（无密钥/本机绝对路径）
- [ ] `pnpm pack` 检查 tarball 不含 research/examples（`files` 白名单已保证）
- [ ] 版本号递增、CHANGELOG/README 更新
- [ ] 仓库公开、LICENSE 存在、无密钥/本机绝对路径
