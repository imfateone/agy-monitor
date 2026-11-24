# AGY监控

Antigravity 会话统计、分模型缓存命中分析、上下文占用拆解、每轮用量胶囊、历史 Token 用量统计与额度监控插件。

---

## 核心功能

- **底部三枚监控胶囊**
  - 在聊天输入框下方常驻展示：**会话轮步与输出速度（TPS）**、**Token 总量与缓存命中率**、**上下文占用环形进度条**；
  - 支持 **悬停预览**、**点击固定浮层**、鼠标移开自动收起及按 `Esc` / 点击空白处关闭。
- **每轮用量胶囊**
  - 自动挂载到每条已完成回复的操作栏右侧（`用量 XXX tok`）；
  - 展示该轮调用模型列表、缓存命中率、Token 构成、步数、子会话摘要、模型用时、工具调用用时、首 token 平均耗时（TTFT）、纯流式输出速度（TPS，剔除首 token 等待）及上下文压缩次数。
- **分模型二级栏核算**
  - 在底部浮层、每轮浮层和侧边栏均提供「汇总 / 分模型」二级栏切换；
  - 针对多模型混用或主/子会话切换不同模型的场景，按模型独立核算调用次数、缓存命中率、未缓存输入/缓存读取/输出 Token、耗时、TTFT 与 TPS。
- **子会话递归监控与上下文压缩统计**
  - 自动追踪并递归聚合嵌套子会话的 Token 与步数，汇总至主会话总量及对应触发轮次，并在侧边栏独立列出子会话明细；
  - 记录并展示会话及单轮触发上下文压缩的次数，精确拆分当前上下文窗口与历史压缩分段。
- **上下文窗口构成拆解**
  - 通过彩色分段进度条直观展示当前上下文窗口中 **对话消息、工具定义、系统提示词、Skills、Mcp Tools** 等类别的占用体积（总占用取服务端实测，分类拆解附带客户端估算提示）。
- **历史 Token 用量统计（用量统计 Tab）**
  - 支持 **本日 / 本周 / 本月 / 全部** 四档时间切换，提供 **5 级纯色月历**、年度热力图、柱状图与日期/小时下钻交互；
  - 自动避免主/子会话重复计入，统计缓存命中率、思考/正文输出占比（自动识别未上报思考拆分的模型并提示）、等效费用与缓存节省估算，并按模型独立汇总调用次数、TTFT 与纯流式 TPS；
  - 历史数据库扫描与缓存持久化运行在独立 **Worker 线程** 中，使用单读事务 SQLite WAL 快照与本地时区感知缓存，常规刷新自动保留已删除会话的历史归档（点击重建时清空），不阻塞实时遥测接口与页面心跳。
- **右侧「AGY监控」侧边栏与个性化设置**
  - 内置 **「统计总览 / 每轮明细 / 用量统计 / 设置」四大视图**；「模型配额」卡片置顶显示于总览顶部，按分组清晰展示 **`5h` 与 `周` 双窗口剩余比例**、低余量高亮预警及悬停重置时间与组内模型说明；
  - 支持独立开关底部监控栏、每轮用量胶囊、侧边栏配额与费用估算展示，支持 **简体中文 / English** 一键切换，并自适应宿主的深/浅色主题。
- **低开销常驻与稳定性**
  - 实时会话快照采用单遍线性扫表与二分定位，注入器将观察范围收敛至聊天容器并在排序前缓存布局坐标，同时对连续超时的 CDP 连接做退避回收；
  - 侧边栏采用 `AbortController` 超时控制、请求单飞锁、页面隐藏自动暂停轮询及零重排悬浮 Tooltip。

---

## 图片展示

> 以下图片均基于插件真实界面与示例数据渲染展示。

### 底部监控胶囊 & 分模型 Token 浮层

![底部监控胶囊与分模型浮层](docs/images/footer-bar-models.png)

### 每轮用量胶囊 & 单轮详情浮层

![每轮用量胶囊与单轮详情浮层](docs/images/turn-pill-popover.png)

### 右侧「AGY监控」侧边栏

| 统计总览 · 汇总 | 统计总览 · 分模型 | 每轮明细 | 用量统计 |
| :---: | :---: | :---: | :---: |
| ![侧边栏统计总览](docs/images/sidebar-overview.png) | ![侧边栏分模型明细](docs/images/sidebar-models.png) | ![侧边栏每轮明细](docs/images/sidebar-turns.png) | ![侧边栏用量统计](docs/images/sidebar-usage.png) |

---

## 一键安装与更新

### 1. 环境准备
- 已安装 **Google Antigravity**
- 已安装 **Node.js**（22.13+）及 **Git**

### 2. 克隆与安装
```powershell
git clone https://github.com/imfateone/agy-monitor.git
cd agy-monitor
powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1
```

默认安装只处理插件文件（`install.ps1` 适用于 Windows）。脚本将插件安装或更新到 `%USERPROFILE%\.gemini\config\plugins\agy-monitor`，备份旧版至 `./backups/`，并运行 `node --test` 验证插件。安装后请完全退出 Antigravity，再从原有入口启动，即可使用右侧 AGY监控 面板。

> **macOS / Linux**：将 `./plugin` 复制到 `~/.gemini/config/plugins/agy-monitor`，运行 `node --test ~/.gemini/config/plugins/agy-monitor/test/telemetry.test.mjs` 验证后，完全退出并重启 Antigravity 即可。

### 3. 可选启用底部监控栏和每轮用量胶囊

只使用右侧面板时，可以跳过这一步。

#### 沿用现有快捷方式

1. 右键平时用来启动 Antigravity 的快捷方式，打开「属性」。
2. 在「目标」栏原有命令末尾加一个空格，再加 `--remote-debugging-port=0`。如果程序路径带引号，把参数放在引号外。如果已有这项参数，把它改为 `--remote-debugging-port=0`，保留其他参数。
3. 完全退出 Antigravity，再用该快捷方式重新启动。

如果平时通过自定义脚本启动，请让原有脚本把 `--remote-debugging-port=0` 传给 Antigravity。

#### 由安装器创建独立快捷方式

直启 Antigravity 的用户如果想另建一个监控入口，可在安装时显式加上 `-CreateMonitorShortcut`。

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1 -CreateMonitorShortcut
```

安装器会保留已有快捷方式，并在桌面创建 `Antigravity (AGY Monitor)`。完全退出 Antigravity 后，通过该入口启动即可显示页面监控。

---

## 本地单元测试与目录说明

- **运行单元测试**：
  ```powershell
  node --test .\plugin\test\telemetry.test.mjs
  ```
- **实时插件目录（仅本地）**：`%USERPROFILE%\.gemini\config\plugins\agy-monitor`
- **插件设置文件（仅本地）**：`%USERPROFILE%\.gemini\config\agy-monitor\settings.json`
- **历史用量缓存文件（仅本地）**：`%USERPROFILE%\.gemini\config\agy-monitor\usage-stats-cache.json`
