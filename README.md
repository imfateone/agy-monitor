# AGY监控

Antigravity 会话统计、Token 缓存命中率、上下文占用拆解、每轮用量胶囊与额度监控插件。

---

## 一键安装与更新

### 1. 环境准备
- 已安装 **Google Antigravity**
- 已安装 **Node.js**（用于运行 sidecar 监控后台）及 **Git**

### 2. 克隆与安装
```powershell
git clone https://github.com/<你的用户名>/agy-monitor.git
cd agy-monitor
powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1
```

脚本会自动完成以下全部步骤：
1. 将插件安装/更新到 `%USERPROFILE%\.gemini\config\plugins\agy-monitor`（若已有旧版会自动备份至 `./backups/`）；
2. 自动扫描桌面和开始菜单中的 `Antigravity.lnk` 快捷方式，并确保其启动参数包含 `--remote-debugging-port=0`（底部三枚监控胶囊与每轮 `用量 XXX tok` 胶囊依赖此参数）；
3. 自动运行 `node --test` 单元测试验证插件可用。

> 安装完成后，请通过桌面/开始菜单的 `Antigravity` 快捷方式**完全退出并重启一次 Antigravity** 即可生效。

---

## 本地单元测试与目录说明

- **运行单元测试**：
  ```powershell
  node --test .\plugin\test\telemetry.test.mjs
  ```
- **实时插件目录（仅本地）**：`%USERPROFILE%\.gemini\config\plugins\agy-monitor`
- **插件设置文件（仅本地）**：`%USERPROFILE%\.gemini\config\agy-monitor\settings.json`
