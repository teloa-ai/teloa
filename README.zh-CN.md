<p align="center">
  <a href="https://www.teloa.ai/"><img src="assets/brand/readme-hero-zh-CN.png" alt="Teloa · AI-Native Team Studio。让每个人，都拥有自己的 AI 团队。" width="100%"></a>
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-blue?style=flat-square" alt="Apache-2.0 开源许可"></a>
  <a href="https://www.npmjs.com/package/@teloa/cli"><img src="https://img.shields.io/npm/v/@teloa/cli?style=flat-square&amp;logo=npm&amp;label=npm" alt="npm 发布版本"></a>
  <a href="https://hub.docker.com/r/teloa/teloa"><img src="https://img.shields.io/badge/Docker-Hub-2496ED?style=flat-square&amp;logo=docker&amp;logoColor=white" alt="Docker Hub 镜像"></a>
  <a href="https://github.com/teloa-ai/teloa/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/teloa-ai/teloa/ci.yml?branch=main&amp;style=flat-square&amp;label=CI" alt="主分支构建状态"></a>
</p>

<p align="center">
  <a href="README.md">English</a> · <a href="README.zh-CN.md">简体中文</a>
</p>

<p align="center">
  <a href="https://www.teloa.ai/">官网</a> · <a href="https://docs.teloa.ai/">文档</a> · <a href="https://market.teloa.ai/">资源市场</a> · <a href="https://www.teloa.ai/blog/">博客</a> · <a href="https://security.teloa.ai/?lang=zh-CN">AI 安全研究</a> · <a href="https://github.com/teloa-ai/teloa">GitHub</a> · <a href="#快速开始">快速开始</a> · <a href="#版本选择">版本选择</a> · <a href="CONTRIBUTING.md">参与贡献</a>
</p>

# Teloa — 让每个人，都拥有自己的 AI 团队

Teloa 是用于组建、管理和运行 AI 员工团队的 **AI-Native Team Studio**。为员工配置职责、知识、技能、工具、记忆与权限，让不同岗位在同一个工作平台中协作交付成果。你可以先从一个具体任务开始，再逐步建立自己的团队和工作方式。

本仓库维护 **Teloa 社区版**：面向个人与开发者，使用 [Apache-2.0](LICENSE) 许可，自行部署在自己的电脑上，在个人 Web 工作台中管理多位 AI 员工。当前运行引擎为 **DeepSeek Harness（DSH）**。

![Teloa 工作台：描述目标，继续交给 AI 员工的工作](https://docs.teloa.ai/assets/screenshots/workbench.72946a04d5fa.png)

*真实产品界面，使用示例员工与工作数据；首次安装无需导入演示数据。*

## 为什么选择 Teloa

- **长期工作的 AI 员工。** 职责、配置与有来源的岗位经验可以延续，任务结束后仍能继续合作。
- **围绕成果组织协作。** 用群、项目、任务与业务记录承接工作，跟进进度、处理审批并取得成果。
- **按自己的方式搭建。** 组合知识、技能、工具与自动化，用自然语言配置业务记录和看板。
- **由你掌握工作边界。** 自行部署，选择模型服务，管理数据、访问范围与授权；远程服务的数据使用见[安全与数据](#安全与数据)。

[阅读《从 Agent 到 AI Organization：我们为什么做 Teloa》→](https://www.teloa.ai/blog/why-teloa/)

[查看社区版真实界面 →](https://www.teloa.ai/#screenshots)

## 30 秒，看看真实工作台

https://github.com/user-attachments/assets/e116d654-e9e5-4fa8-a2b1-4b4aa603ef24

社区版 0.2.2 实际界面，使用示例数据。 [观看字幕版](https://www.teloa.ai/#film)

## 快速开始

需要自备模型服务与 API 密钥，模型调用费用由对应服务商收取；社区版软件许可不包含推理额度。

当前社区版正式版本为 **0.2.2**。原生安装包随 [GitHub Release](https://github.com/teloa-ai/teloa/releases/tag/v0.2.2) 提供，已在 macOS arm64 上验证；[Docker Hub](https://hub.docker.com/r/teloa/teloa) 提供同版 **Linux ARM64** 镜像。[npm](https://www.npmjs.com/package/@teloa/cli) 提供同一版本。下方仍保留源码构建方式。

### 本次更新重点

- **项目与项目记忆**：专属项目会话，简报、规则、选用资料和有来源的记忆进入模型上下文，可核对本次使用、处理候选与撤回。
- **资料索引与本地模型**：登记选定的本机 Markdown 文件、建立索引和查看引用；嵌入模型与 Ollama 聊天模型分别准备和管理。检索摘录可能发往所选远程聊天模型。
- **员工、团队与协作**：完整团队资源、独立员工会话分类、群主消息回复与话题、明确提及，以及 Auto Dream 整理的有来源员工经验。
- **任务与成果**：Markdown 工作说明、带上下文的草案、审批、成果版本和反馈续改；可将已确认方法保存为技能或暂停的计划草案。
- **语音与小松鼠**：本地转写、语音留言与通话、三家播报服务、连续播报，MiniMax 中英文音色列表与试听。
- **执行与文件**：临时执行小组、Workflow / PTC / 本人明确要求的 Ralph、外部编程 Agent 与文件预览；可选浏览器、电脑能力仍需独立配置和授权。
- **业务与应用**：自然语言业务草案、确认后的记录变更与验收成果关联，更清楚的看板页面，以及市场和应用文案整理。

以上覆盖本版能力与改进，并非全部首次新增。升级前请查看[完整更新说明与使用条件](https://docs.teloa.ai/changelog/)。

### 从 GitHub Release 原生安装

需要 **Node.js 24.x** 或 **22.19 及以上的 22.x**、**npm 11.12.1 及以上的 11.x**，以及运行中的本机 Docker 引擎，用于独立 PostgreSQL 数据库。将精确版本安装到新建命令目录，无需全局安装或编译源码。

```sh
mkdir teloa-command
cd teloa-command
npm install --ignore-scripts https://github.com/teloa-ai/teloa/releases/download/v0.2.2/teloa-cli-0.2.2.tgz
./node_modules/.bin/teloa up
./node_modules/.bin/teloa doctor
./node_modules/.bin/teloa status
```

Teloa 与 DSH 在电脑上原生运行。启动后打开 Web 界面，在设置中配置模型；默认 Web 端口为 3100。新安装端口被占用时，使用 `./node_modules/.bin/teloa up --port 3101`。发行页同时列出安装包的 SHA-256 校验值。升级已有安装（例如 0.2.0-alpha.7）并保留其数据与身份：把 0.2.2 安装包装入新的命令目录，在该目录运行 `teloa stop`，再运行 `teloa upgrade --to 0.2.2`（自定义安装继续传入原 `--home`）。升级会在切换前自动备份。启停操作见[安装指南](https://docs.teloa.ai/start/quickstart)，备份见[备份与升级](https://docs.teloa.ai/deploy/backup)。也可从 npm 安装同版：`npm install --ignore-scripts @teloa/cli@0.2.2`。

<details>
<summary><strong>Docker Hub + Compose（0.2.2）</strong></summary>

### Docker Hub + Compose

先安装带 Compose 的 Docker，并启动 Docker 引擎。正式镜像及以下配置已验 **Linux ARM64**；**amd64 尚未验证**。Teloa、DSH 与 PostgreSQL 均在容器内运行，本机不需要安装 Node.js 或 pnpm。

将本版本配置下载到新目录。初始化与应用均使用 `teloa/teloa:0.2.2`，沿用持久数据卷与自动生成的数据库口令。

```sh
mkdir teloa-community
cd teloa-community
curl --fail --location https://docs.teloa.ai/downloads/0.2.2/compose.yaml --output compose.yaml
docker compose pull
docker compose up -d --no-build
docker compose ps
docker compose logs --tail=50 app
```

等待 `db` 与 `app` 显示健康；一次性 `init` 服务成功退出属于正常行为。使用应用日志中的完整认证链接进入，采用所配置的本机端口（默认 3100）。端口被占用时，先在该目录 `.env` 中填写 `TELOA_PORT=3101`。不要公开认证链接。启停操作见[安装指南](https://docs.teloa.ai/start/quickstart)，更新前先看[备份与升级](https://docs.teloa.ai/deploy/backup)。

容器中的工具执行容器内的程序，挂载文件夹不会获得本机应用的操作权限。

</details>

<details>
<summary><strong>Docker Compose 源码构建</strong></summary>

### Docker Compose 源码构建

先安装带 Compose 的 Docker，并启动 Docker 引擎。此方式将 Teloa 与 PostgreSQL 一起运行在容器中，本机不需要安装 Node.js 或 pnpm。

```sh
git clone https://github.com/teloa-ai/teloa.git
cd teloa
docker compose up -d --build
docker compose ps
docker compose logs --tail=50 app
```

等待 `db` 和 `app` 显示健康。`init` 是一次性初始化服务，成功退出属于正常行为。使用应用日志中的**完整认证链接**进入，默认地址使用 `127.0.0.1:3100`。端口已被占用时，先在本地 `.env` 中填写 `TELOA_PORT=3101`，启动后将认证链接的端口改为该端口。

初始化时自动生成数据库凭据，数据保存在持久卷中。暂停与继续同一安装：

```sh
docker compose stop
docker compose start
```

容器中的工具调用容器内的程序，挂载文件夹不会获得本机应用的操作权限。需要使用电脑上的程序时，选择本机源码运行。

</details>

<details>
<summary><strong>本机源码运行</strong></summary>

### 本机源码运行

需要 **Node.js 24.x** 或 **22.19 及以上的 22.x**、**pnpm 11.7.0**，以及用于 PostgreSQL 的本机 Docker 引擎。此方式在电脑上运行 Teloa 与 DSH，数据库运行在 Docker 中。

当前主分支固定 DSH **0.2.1-rc.2**，包含默认语音输入；已发布的 npm 和 Docker 版本独立更新，请勿将源码能力视为旧发行包已包含的功能。

```sh
git clone https://github.com/teloa-ai/teloa.git
cd teloa
pnpm install --frozen-lockfile
pnpm build
pnpm check:dsh
pnpm setup:database
pnpm setup:dsh
pnpm dev:dsh
```

使用终端输出的完整认证地址进入。macOS 或 Linux 下可用 `TELOA_DSH_PORT=3101 pnpm dev:dsh` 指定其他 Web 端口。源码安装的运行数据保存在 `.runtime/`，默认工作目录是 `.runtime/teloa/workspace`。

首次点击语音入口时，按提示准备本地 SenseVoice 模型并允许麦克风访问。仅显示入口不会下载模型或开始录音；取消准备保留草稿。转写在本机完成，发送后的文本按所选模型服务处理。停用语音后，后续启动保留你的选择。

部署和故障排查见[安装指南](https://docs.teloa.ai/start/quickstart)与[本地开发指南](https://docs.teloa.ai/develop/local-development)。升级前先备份数据。

</details>

## 完成第一项工作

1. 进入**设置 → 模型**，配置支持的模型服务，先确认普通对话能得到回应。模型密钥只填写在设置中。
2. 创建一位 **AI 员工**，写清职责，选择可用资料，设置工具与审批边界。
3. 打开员工会话，提出具体要求，例如：「整理这些文件，列明来源，并指出还不能确定的地方。」
4. 需要跟踪的工作创建或批准为任务，查看实际进度，在**需要你**中处理请求，并核对最终成果。
5. 按需要用业务或项目组织相关工作，再添加看板或定时计划。

## 可以做什么

| 能力 | 使用方式 |
| --- | --- |
| **对话** | 使用文字、文件、图片、`@` 引用和 `/` 命令，在同一上下文中继续工作。 |
| **语音输入与播报** | 会话输入区默认提供语音入口；首次使用按需准备本地识别模型，转写进入草稿，由你确认后发送。语音播报使用你在设置中选择并试听的服务商与音色朗读回复，凭据由你自行配置。语音输入可在设置中停用。 |
| **上下文观察** | 默认随附 dsh-context；在会话页签、右栏或 `/context` 中查看上下文组成、Token、费用估算与压缩记录。费用以模型服务商账单为准。 |
| **消息通道** | IM Gateway 内置并默认加载；在设置中配置并启用飞书、Lark、Telegram 或 Slack，无需另装插件。 |
| **AI 员工与群协作** | 为员工保留长期职责、知识、技能和授权；把多位员工加入工作群，讨论问题、协作完成工作。 |
| **任务与项目** | 交办明确目标，查看负责人和实际执行进度；用项目归集相关工作与成果。 |
| **成果与修订** | 成果保留版本；可在原会话中提出反馈或选段修改，旧版本仍可查看。 |
| **业务与看板** | 用自然语言描述记录、字段和页面，核对后保存配置；管理业务记录，并基于这些数据搭建看板。 |
| **资料与技能** | 提供判断所需的依据资料和可复用的工作方法，为每位员工选择可使用的内容。 |
| **应用与市场** | 在「应用」中添加应用与技能，并通过 MCP 接入支持的外部工具；在市场按「AI 员工」「AI 团队」添加员工或团队模板。 |
| **自动化** | 为重复工作设置计划并查看运行记录；需要单独启用计划，并保持运行环境在线。 |
| **模型配置** | 使用自己的凭据配置运行引擎支持的模型服务；员工的模型设置与业务权限分别管理。 |

## 这些能力怎样配合

**业务**组织记录、员工与资源；**AI 员工**承担职责；**技能**提供方法；**资料**提供依据；**连接器**接入系统。**任务**记录一次交办，**成果**保留交付内容，**看板**汇总业务记录与状态。

![Teloa 社区版中的内容运营业务：业务内容页列出示例记录，统计看板、AI 员工、协作群与项目在同一业务内](https://docs.teloa.ai/assets/screenshots/business-page.a738c73c3358.png)

*0.2.0-beta.7 界面，示例数据。一个业务把记录、看板、AI 员工、协作群与项目放在一起；“开始工作”从这里发起工作。*

以**安全运营（SOC）**为例：

1. 描述要跟进的告警业务，核对记录字段和页面。
2. 添加本地记录、导入支持的表格，或配置有权限使用的数据连接。
3. 为研判员工提供流程、证据和工具，把具体告警交办为调查任务。
4. 查看任务进度、核对证据，验收关联到该告警的成果。
5. 用看板汇总告警状态、严重度和趋势。

添加团队模板不会自动连接账号、授权员工或启动定时工作。这些配置由你决定。

![内容运营总览看板（示例数据）](https://docs.teloa.ai/assets/screenshots/business-dashboard.c369ceac1da1.png)

*各业务的看板用法相同。此例为 0.2.0-beta.7 界面中市场采用的内容运营看板与 10 条示例记录，不是实时数据。*

SOC 是首个完整业务流程场景。客户交付、内容运营、电商零售、软件研发、教育培训、门店服务和其他安全方向是**后续场景示例**，不代表这些集成已经完成。见[行业场景与业务组合](https://docs.teloa.ai/tutorials/industry-examples)和 [SOC 使用教程](https://docs.teloa.ai/tutorials/soc-triage)。

<a id="数据权限与版本定位"></a>

## 版本选择

Teloa 的三个版本共享同一产品核心，面向不同的使用场景。本仓库维护社区版的开源代码。

| 版本 | 定位与使用场景 |
| --- | --- |
| 社区版 | 面向个人与开发者的开源版本，自行部署与配置，用 AI 员工、协作、任务、自动化和技能搭建自己的工作平台。 |
| 专业版 | 面向个人与专业用户的 Mac 原生应用，开箱即用，在本机执行任务、操作文件与应用；通过手机随时新建、跟进和接续工作。 |
| 企业版 | 面向企业与组织，部署在企业云或内网，统一管理成员、共享 AI 员工、权限与审计，连接企业内部数据、系统和业务流程。 |

## 文档导航

| 你想做什么 | 从这里开始 |
| --- | --- |
| 安装与完成第一项工作 | [安装指南](https://docs.teloa.ai/start/quickstart) · [第一项任务](https://docs.teloa.ai/start/first-task) |
| 组建 AI 团队 | [AI 员工](https://docs.teloa.ai/guides/colleagues) · [群协作](https://docs.teloa.ai/guides/groups) |
| 搭建业务与扩展能力 | [业务与看板](https://docs.teloa.ai/guides/business) · [市场资源](https://docs.teloa.ai/guides/market) |
| 了解行业工作方式 | [行业场景](https://docs.teloa.ai/tutorials/industry-examples) · [SOC 教程](https://docs.teloa.ai/tutorials/soc-triage) |
| 维护与升级 | [备份与升级](https://docs.teloa.ai/deploy/backup) · [安全政策](SECURITY.md) |
| 了解智能体安全与评估平台 | [Teloa AI Security](https://security.teloa.ai/?lang=zh-CN) · [安全基线自评](https://security.teloa.ai/agent-baseline-assessor/?lang=zh-CN) |
| 开发与贡献 | [本地开发](https://docs.teloa.ai/develop/local-development) · [贡献指南](CONTRIBUTING.md) |

## 架构与开发

ESP32 固件在独立仓库 [teloa-ai/teloa-firmware](https://github.com/teloa-ai/teloa-firmware) 维护。

| 产品层次 | 职责 |
| --- | --- |
| **AI Team** | 员工、协作、业务、项目、任务与自动化。 |
| **Agent Studio** | 每位员工的职责、知识、技能、工具和权限。 |
| **Agent Harness** | 模型、运行环境、工具、沙箱、审批与运行事件；当前使用 DSH。 |

<details>
<summary>源码结构与验证命令</summary>

源码将业务服务、运行引擎适配和界面分别组织：

| 目录 | 内容 |
| --- | --- |
| `packages/contract` | 共享类型与协议。 |
| `packages/backend` | 基于 PostgreSQL 的业务服务。 |
| `packages/harness-dsh` | DSH 适配、任务执行和授权检查。 |
| `packages/client/`、`packages/bundle` | Web 工作台、共享界面组件与运行组合。 |
| `packages/cli`、`packages/native-*` | 安装维护与原生工具适配。 |
| `packages/mcp-reference`、`packages/im-gateway`、`packages/local-embedding` | 资料访问、消息集成与本地检索。 |
| `config/`、`scripts/` | 固定依赖基线、环境准备和启动。 |
| `tests/`、`examples/industry/` | 回归测试与合成业务格式示例。 |

提交改动前运行：

```sh
pnpm build
pnpm check:client
pnpm check:dsh
NODE_OPTIONS=--max-old-space-size=4096 pnpm typecheck
pnpm test:repo
pnpm test:contract
pnpm test:bindings
```

行为改动还需运行相应的后端或引擎测试，部分测试需要 Docker 和隔离数据库。运行数据和凭据不要入库。贡献流程与 DCO 要求见 [CONTRIBUTING.md](CONTRIBUTING.md)。

</details>

## 安全与数据

应用数据保存在运行 Teloa 的设备上。使用远程模型或授权外部工具时，工作所需的上下文会发送给对应服务。自行部署不代表所有推理都在本地完成。权限模型与已知限制见[安全政策](SECURITY.md)。

各版本均使用自备的模型服务与 API 密钥，模型费用另计。外部集成需要兼容服务及相应凭据。停止会话不能保证所有外部请求立即中断。

[Teloa AI Security](https://security.teloa.ai/?lang=zh-CN) 将 Teloa 开发中的安全设计问题整理为开放研究与工具。其[企业智能体身份与授权安全基线](https://github.com/teloa-ai/agent-baseline-assessor)包含 **240 条要求、三个等级（L1–L3）与七种语言版本**，并提供[在线自评工具](https://security.teloa.ai/agent-baseline-assessor/?lang=zh-CN)。基线描述评估目标，不构成安全认证，也不代表 Teloa 已实现全部要求；应按具体产品版本、部署范围与证据逐条评估。

安全报告请遵循 [SECURITY.md](SECURITY.md)：默认提交脱敏的公开 [Issue](https://github.com/teloa-ai/teloa/issues)；可能造成重大影响的问题，建议先私下联系 [security@teloa.ai](mailto:security@teloa.ai)。公开内容请去除凭据、隐私与尚未公开的漏洞利用细节。普通问题与建议同样通过 GitHub Issues 提交。

## 社区与许可

![小松鼠 Teloa 的六种社区表情：暗中观察、吃瓜、拿捏、CPU 烧了、已读乱回、下班秒跑。](assets/brand/community-reactions-zh-CN.png)

认识一下，小松鼠 Teloa。更多社区图片见[品牌素材](https://www.teloa.ai/brand-kit/)，使用前请阅读[图片使用说明](assets/brand/README.md)。

- 问题与功能建议：[GitHub Issues](https://github.com/teloa-ai/teloa/issues)。
- 参与贡献：[贡献指南](CONTRIBUTING.md)与 [DCO](DCO.md)。
- 产品支持：[support@teloa.ai](mailto:support@teloa.ai)。
- 商务与合作：[hi@teloa.ai](mailto:hi@teloa.ai)。
- 重大安全问题：按 [SECURITY.md](SECURITY.md) 联系 [security@teloa.ai](mailto:security@teloa.ai)。一般问题可以公开提交 Issue，敏感细节请私下补充。

Teloa 社区版使用 **[Apache-2.0](LICENSE)** 许可。第三方组件保留各自许可，见 [NOTICE](NOTICE) 与 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。Teloa 名称与品牌的使用见[商标政策](TRADEMARK.md)。
