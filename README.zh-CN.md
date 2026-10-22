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
  <a href="https://www.teloa.ai/">官网</a> · <a href="https://docs.teloa.ai/">文档</a> · <a href="https://market.teloa.ai/">资源市场</a> · <a href="https://www.teloa.ai/blog/">博客</a> · <a href="https://security.teloa.ai/?lang=zh-CN">AI 安全研究</a> · <a href="https://github.com/teloa-ai/teloa">GitHub</a> · <a href="#功能截图">功能截图</a> · <a href="#快速开始">快速开始</a> · <a href="#版本选择">版本选择</a> · <a href="CONTRIBUTING.md">参与贡献</a>
</p>

# Teloa — 让每个人，都拥有自己的 AI 团队

Teloa 是用于组建、管理和运行 AI 员工团队的 **AI-Native Team Studio**。为员工配置职责、知识、技能、工具、记忆与权限，让不同岗位在同一个工作平台中协作交付成果。你可以先从一个具体任务开始，再逐步建立自己的团队和工作方式。

本仓库维护 **Teloa 社区版**：面向个人与开发者，使用 [Apache-2.0](LICENSE) 许可，自行部署在自己的电脑上，在个人 Web 工作台中管理多位 AI 员工。当前运行引擎为 **DeepSeek Harness（DSH）**。

![Teloa 工作台：描述目标，继续交给 AI 员工的工作](https://docs.teloa.ai/assets/screenshots/workbench-024.18aefe7ecd43.png)

*社区版 0.2.4 真实界面，使用示例任务与未发送草稿；首次安装无需导入演示数据。*

[0.2.4 新功能使用指南](https://docs.teloa.ai/start/whats-new)

## 为什么选择 Teloa

- **长期工作的 AI 员工。** 职责、配置与有来源的岗位经验可以延续，任务结束后仍能继续合作。
- **围绕成果组织协作。** 用群、项目、任务与业务记录承接工作，跟进进度、处理审批并取得成果。
- **按自己的方式搭建。** 组合知识、技能、工具与自动化，用自然语言配置业务记录和看板。
- **由你掌握工作边界。** 自行部署，选择模型服务，管理数据、访问范围与授权；远程服务的数据使用见[安全与数据](#安全与数据)。

[阅读《从 Agent 到 AI Organization：我们为什么做 Teloa》→](https://www.teloa.ai/blog/why-teloa/)

[查看社区版真实界面 →](https://www.teloa.ai/#screenshots)

## 30 秒，看看真实工作台

[![播放社区版 0.2.4 真实工作台巡览](https://www.teloa.ai/assets/videos/teloa-poster-0.2.4-30-zh-CN.66ef7a7bb0e7.webp)](https://www.teloa.ai/#film)

社区版 0.2.4 全新录制，使用示例数据。[播放 30 秒巡览](https://www.teloa.ai/#film) · [下载 MP4](https://www.teloa.ai/assets/videos/teloa-film-0.2.4-30-zh-CN.767d3aed81b4.mp4)

## 功能截图

展开下方分类即可浏览所有界面，也可[打开完整截图总览](https://docs.teloa.ai/start/screenshots)，按功能筛选并进入使用指南。

社区版 0.2.4 · 32 个场景 · 真实界面与示例数据。点击图片查看完整原图；未配置、未发送等状态按实际界面保留。

<details open>
<summary><strong>交办与跟进 · 5 个场景</strong></summary>

<table>
<tr>
<td width="50%" valign="top">
<a href="https://docs.teloa.ai/assets/screenshots/workbench-024.18aefe7ecd43.png"><img src="https://docs.teloa.ai/assets/screenshots/workbench-024.18aefe7ecd43.png" alt="工作台" width="420" loading="lazy"></a>
<p><strong>工作台</strong><br>描述目标，继续手头工作；示例输入尚未发送。<br><a href="https://docs.teloa.ai/guides/workbench">使用指南</a></p>
</td>
<td width="50%" valign="top">
<a href="https://docs.teloa.ai/assets/screenshots/attention-024.58a5b2acd718.png"><img src="https://docs.teloa.ai/assets/screenshots/attention-024.58a5b2acd718.png" alt="需要你" width="420" loading="lazy"></a>
<p><strong>需要你</strong><br>集中核对待确认事项、缺失资料和异常。<br><a href="https://docs.teloa.ai/guides/workbench">使用指南</a></p>
</td>
</tr>
<tr>
<td width="50%" valign="top">
<a href="https://docs.teloa.ai/assets/screenshots/tasks-024.353ca01411f6.png"><img src="https://docs.teloa.ai/assets/screenshots/tasks-024.353ca01411f6.png" alt="任务" width="420" loading="lazy"></a>
<p><strong>任务</strong><br>按负责人和状态查看已经保存的工作。<br><a href="https://docs.teloa.ai/guides/tasks">使用指南</a></p>
</td>
<td width="50%" valign="top">
<a href="https://docs.teloa.ai/assets/screenshots/create-task-024.765ca8dfed89.png"><img src="https://docs.teloa.ai/assets/screenshots/create-task-024.765ca8dfed89.png" alt="创建任务" width="420" loading="lazy"></a>
<p><strong>创建任务</strong><br>先写明目标、依据与交付要求，再明确提交。<br><a href="https://docs.teloa.ai/guides/tasks">使用指南</a></p>
</td>
</tr>
<tr>
<td width="50%" valign="top">
<a href="https://docs.teloa.ai/assets/screenshots/conversations-024.369f45d7f5f7.png"><img src="https://docs.teloa.ai/assets/screenshots/conversations-024.369f45d7f5f7.png" alt="对话" width="420" loading="lazy"></a>
<p><strong>对话</strong><br>找回已有工作会话，继续原来的讨论。<br><a href="https://docs.teloa.ai/guides/conversations">使用指南</a></p>
</td>
<td width="50%"></td>
</tr>
</table>

</details>

<details>
<summary><strong>员工与协作 · 6 个场景</strong></summary>

<table>
<tr>
<td width="50%" valign="top">
<a href="https://docs.teloa.ai/assets/screenshots/team-024.460a59cf33c9.png"><img src="https://docs.teloa.ai/assets/screenshots/team-024.460a59cf33c9.png" alt="员工目录" width="420" loading="lazy"></a>
<p><strong>员工目录</strong><br>查看员工与运行状态，进入个人工作会话。<br><a href="https://docs.teloa.ai/guides/colleagues">使用指南</a></p>
</td>
<td width="50%" valign="top">
<a href="https://docs.teloa.ai/assets/screenshots/employee-create-024.d5c8f0263fea.png"><img src="https://docs.teloa.ai/assets/screenshots/employee-create-024.d5c8f0263fea.png" alt="创建 AI 员工" width="420" loading="lazy"></a>
<p><strong>创建 AI 员工</strong><br>用一段说明描述职责与范围，先审阅草稿。<br><a href="https://docs.teloa.ai/guides/colleagues">使用指南</a></p>
</td>
</tr>
<tr>
<td width="50%" valign="top">
<a href="https://docs.teloa.ai/assets/screenshots/employee-detail-024.3b22e615fb49.png"><img src="https://docs.teloa.ai/assets/screenshots/employee-detail-024.3b22e615fb49.png" alt="员工资料" width="420" loading="lazy"></a>
<p><strong>员工资料</strong><br>核对职责、能力、记忆与执行边界。<br><a href="https://docs.teloa.ai/guides/colleagues">使用指南</a></p>
</td>
<td width="50%" valign="top">
<a href="https://docs.teloa.ai/assets/screenshots/twin-024.5bbaa69b928b.png"><img src="https://docs.teloa.ai/assets/screenshots/twin-024.5bbaa69b928b.png" alt="我的分身" width="420" loading="lazy"></a>
<p><strong>我的分身</strong><br>查看个人习惯观察及来源，决定保留或撤回。<br><a href="https://docs.teloa.ai/concepts/people">使用指南</a></p>
</td>
</tr>
<tr>
<td width="50%" valign="top">
<a href="https://docs.teloa.ai/assets/screenshots/groups-024.73e4a003d510.png"><img src="https://docs.teloa.ai/assets/screenshots/groups-024.73e4a003d510.png" alt="协作群" width="420" loading="lazy"></a>
<p><strong>协作群</strong><br>在同一群中组织员工、成员与协作规则。<br><a href="https://docs.teloa.ai/guides/groups">使用指南</a></p>
</td>
<td width="50%" valign="top">
<a href="https://docs.teloa.ai/assets/screenshots/create-group-024.9fba4f71c701.png"><img src="https://docs.teloa.ai/assets/screenshots/create-group-024.9fba4f71c701.png" alt="创建协作群" width="420" loading="lazy"></a>
<p><strong>创建协作群</strong><br>准备群目标和成员；截图为未提交的草稿。<br><a href="https://docs.teloa.ai/guides/groups">使用指南</a></p>
</td>
</tr>
</table>

</details>

<details>
<summary><strong>业务与项目 · 5 个场景</strong></summary>

<table>
<tr>
<td width="50%" valign="top">
<a href="https://docs.teloa.ai/assets/screenshots/business-024.2cfa530d2971.png"><img src="https://docs.teloa.ai/assets/screenshots/business-024.2cfa530d2971.png" alt="业务目录" width="420" loading="lazy"></a>
<p><strong>业务目录</strong><br>在业务入口查看相关员工、任务与待办。<br><a href="https://docs.teloa.ai/guides/business">使用指南</a></p>
</td>
<td width="50%" valign="top">
<a href="https://docs.teloa.ai/assets/screenshots/business-page-024.7e05c5b73773.png"><img src="https://docs.teloa.ai/assets/screenshots/business-page-024.7e05c5b73773.png" alt="业务记录" width="420" loading="lazy"></a>
<p><strong>业务记录</strong><br>跟进字段、负责人和阶段；图中为 8 条虚构示例记录。<br><a href="https://docs.teloa.ai/guides/business">使用指南</a></p>
</td>
</tr>
<tr>
<td width="50%" valign="top">
<a href="https://docs.teloa.ai/assets/screenshots/business-dashboard-024.22f992c8cf57.png"><img src="https://docs.teloa.ai/assets/screenshots/business-dashboard-024.22f992c8cf57.png" alt="业务看板" width="420" loading="lazy"></a>
<p><strong>业务看板</strong><br>从已保存的记录计算指标与清单，缺失值单独提示。<br><a href="https://docs.teloa.ai/guides/business">使用指南</a></p>
</td>
<td width="50%" valign="top">
<a href="https://docs.teloa.ai/assets/screenshots/business-dashboard-detail-024.e787ba1992b7.png"><img src="https://docs.teloa.ai/assets/screenshots/business-dashboard-detail-024.e787ba1992b7.png" alt="看板详情" width="420" loading="lazy"></a>
<p><strong>看板详情</strong><br>查看看板完整内容；数值来自手工示例，非真实业务。<br><a href="https://docs.teloa.ai/guides/business">使用指南</a></p>
</td>
</tr>
<tr>
<td width="50%" valign="top">
<a href="https://docs.teloa.ai/assets/screenshots/projects-024.807864ff213c.png"><img src="https://docs.teloa.ai/assets/screenshots/projects-024.807864ff213c.png" alt="项目" width="420" loading="lazy"></a>
<p><strong>项目</strong><br>围绕一个交付目标组织关联工作与资料。<br><a href="https://docs.teloa.ai/guides/projects">使用指南</a></p>
</td>
<td width="50%"></td>
</tr>
</table>

</details>

<details>
<summary><strong>市场与资源 · 4 个场景</strong></summary>

<table>
<tr>
<td width="50%" valign="top">
<a href="https://docs.teloa.ai/assets/screenshots/market-024.324853296f4d.png"><img src="https://docs.teloa.ai/assets/screenshots/market-024.324853296f4d.png" alt="四类市场资源" width="420" loading="lazy"></a>
<p><strong>四类市场资源</strong><br>浏览 AI 员工、AI 团队、应用与技能。<br><a href="https://docs.teloa.ai/guides/market">使用指南</a></p>
</td>
<td width="50%" valign="top">
<a href="https://docs.teloa.ai/assets/screenshots/market-team-024.1dfe89cdc7b0.png"><img src="https://docs.teloa.ai/assets/screenshots/market-team-024.1dfe89cdc7b0.png" alt="AI 团队详情" width="420" loading="lazy"></a>
<p><strong>AI 团队详情</strong><br>添加前查看员工、技能、资料与安排，不自动开始工作。<br><a href="https://docs.teloa.ai/guides/market">使用指南</a></p>
</td>
</tr>
<tr>
<td width="50%" valign="top">
<a href="https://docs.teloa.ai/assets/screenshots/capabilities-024.f287a91cd6cf.png"><img src="https://docs.teloa.ai/assets/screenshots/capabilities-024.f287a91cd6cf.png" alt="应用与技能" width="420" loading="lazy"></a>
<p><strong>应用与技能</strong><br>管理可复用的方法与账号连接。<br><a href="https://docs.teloa.ai/guides/capabilities">使用指南</a></p>
</td>
<td width="50%" valign="top">
<a href="https://docs.teloa.ai/assets/screenshots/library-024.3c6c5d6be02f.png"><img src="https://docs.teloa.ai/assets/screenshots/library-024.3c6c5d6be02f.png" alt="资料" width="420" loading="lazy"></a>
<p><strong>资料</strong><br>整理依据资料，检查检索与员工资源状态。<br><a href="https://docs.teloa.ai/guides/knowledge">使用指南</a></p>
</td>
</tr>
</table>

</details>

<details>
<summary><strong>模型与语音 · 4 个场景</strong></summary>

<table>
<tr>
<td width="50%" valign="top">
<a href="https://docs.teloa.ai/assets/screenshots/model-settings-024.0562e27d2b4e.png"><img src="https://docs.teloa.ai/assets/screenshots/model-settings-024.0562e27d2b4e.png" alt="聊天模型" width="420" loading="lazy"></a>
<p><strong>聊天模型</strong><br>按提供商保存 BYOK，并核对默认模型。<br><a href="https://docs.teloa.ai/start/models">使用指南</a></p>
</td>
<td width="50%" valign="top">
<a href="https://docs.teloa.ai/assets/screenshots/model-key-024.5d7394d174ce.png"><img src="https://docs.teloa.ai/assets/screenshots/model-key-024.5d7394d174ce.png" alt="选择会话模型" width="420" loading="lazy"></a>
<p><strong>选择会话模型</strong><br>未配置时提示没有可用模型，先到设置保存聊天模型凭据。<br><a href="https://docs.teloa.ai/start/models">使用指南</a></p>
</td>
</tr>
<tr>
<td width="50%" valign="top">
<a href="https://docs.teloa.ai/assets/screenshots/local-models-024.8ae5acc6dfb0.png"><img src="https://docs.teloa.ai/assets/screenshots/local-models-024.8ae5acc6dfb0.png" alt="本地模型与检索" width="420" loading="lazy"></a>
<p><strong>本地模型与检索</strong><br>先核对运行要求，再准备聊天或检索模型。<br><a href="https://docs.teloa.ai/start/models">使用指南</a></p>
</td>
<td width="50%" valign="top">
<a href="https://docs.teloa.ai/assets/screenshots/voice-settings-024.8cf54b0fa87b.png"><img src="https://docs.teloa.ai/assets/screenshots/voice-settings-024.8cf54b0fa87b.png" alt="语音服务" width="420" loading="lazy"></a>
<p><strong>语音服务</strong><br>分别准备本地识别与播报；不与聊天凭据混用。<br><a href="https://docs.teloa.ai/start/models">使用指南</a></p>
</td>
</tr>
</table>

</details>

<details>
<summary><strong>持续工作与记忆 · 3 个场景</strong></summary>

<table>
<tr>
<td width="50%" valign="top">
<a href="https://docs.teloa.ai/assets/screenshots/automation-024.46b11542c853.png"><img src="https://docs.teloa.ai/assets/screenshots/automation-024.46b11542c853.png" alt="自动化" width="420" loading="lazy"></a>
<p><strong>自动化</strong><br>创建重复工作计划，先核对执行时间与授权。<br><a href="https://docs.teloa.ai/guides/automations">使用指南</a></p>
</td>
<td width="50%" valign="top">
<a href="https://docs.teloa.ai/assets/screenshots/auto-dream-024.b7a661aa1ced.png"><img src="https://docs.teloa.ai/assets/screenshots/auto-dream-024.b7a661aa1ced.png" alt="工作小结与经验" width="420" loading="lazy"></a>
<p><strong>工作小结与经验</strong><br>查看工作小结、经验候选及其来源。<br><a href="https://docs.teloa.ai/guides/auto-dream">使用指南</a></p>
</td>
</tr>
<tr>
<td width="50%" valign="top">
<a href="https://docs.teloa.ai/assets/screenshots/auto-dream-settings-024.f928444f43a8.png"><img src="https://docs.teloa.ai/assets/screenshots/auto-dream-settings-024.f928444f43a8.png" alt="Auto Dream 设置" width="420" loading="lazy"></a>
<p><strong>Auto Dream 设置</strong><br>按需配置小结安排与范围，保存不代替执行授权。<br><a href="https://docs.teloa.ai/guides/auto-dream">使用指南</a></p>
</td>
<td width="50%"></td>
</tr>
</table>

</details>

<details>
<summary><strong>集成与设置 · 5 个场景</strong></summary>

<table>
<tr>
<td width="50%" valign="top">
<a href="https://docs.teloa.ai/assets/screenshots/employee-api-024.971227cf2aa8.png"><img src="https://docs.teloa.ai/assets/screenshots/employee-api-024.971227cf2aa8.png" alt="SDK、API 与 MCP" width="420" loading="lazy"></a>
<p><strong>SDK、API 与 MCP</strong><br>选择员工与业务范围后创建集成；图中尚未创建密钥。<br><a href="https://docs.teloa.ai/develop/employee-api">使用指南</a></p>
</td>
<td width="50%" valign="top">
<a href="https://docs.teloa.ai/assets/screenshots/extensions-024.58d3171491f5.png"><img src="https://docs.teloa.ai/assets/screenshots/extensions-024.58d3171491f5.png" alt="浏览器与电脑操作" width="420" loading="lazy"></a>
<p><strong>浏览器与电脑操作</strong><br>分别启用提供方并核对系统权限，不自动授权所有员工。<br><a href="https://docs.teloa.ai/guides/native-capabilities">使用指南</a></p>
</td>
</tr>
<tr>
<td width="50%" valign="top">
<a href="https://docs.teloa.ai/assets/screenshots/im-channels-024.f2fcc971f787.png"><img src="https://docs.teloa.ai/assets/screenshots/im-channels-024.f2fcc971f787.png" alt="消息渠道" width="420" loading="lazy"></a>
<p><strong>消息渠道</strong><br>查看接入方式与连接状态，按渠道完成配置。<br><a href="https://docs.teloa.ai/guides/im-channels">使用指南</a></p>
</td>
<td width="50%" valign="top">
<a href="https://docs.teloa.ai/assets/screenshots/settings-024.e96ffca67fe0.png"><img src="https://docs.teloa.ai/assets/screenshots/settings-024.e96ffca67fe0.png" alt="平台设置" width="420" loading="lazy"></a>
<p><strong>平台设置</strong><br>统一管理偏好、模型和运行环境。<br><a href="https://docs.teloa.ai/guides/settings">使用指南</a></p>
</td>
</tr>
<tr>
<td width="50%" valign="top">
<a href="https://docs.teloa.ai/assets/screenshots/about-024.56ae7484eedc.png"><img src="https://docs.teloa.ai/assets/screenshots/about-024.56ae7484eedc.png" alt="关于 Teloa" width="420" loading="lazy"></a>
<p><strong>关于 Teloa</strong><br>查看版本、产品定位与进一步了解的入口。<br><a href="https://docs.teloa.ai/start/overview">使用指南</a></p>
</td>
<td width="50%"></td>
</tr>
</table>

</details>

## 快速开始

需要自备模型服务与 API 密钥，模型调用费用由对应服务商收取；社区版软件许可不包含推理额度。

当前社区版正式版本为 **0.2.4**。原生安装包随 [GitHub Release](https://github.com/teloa-ai/teloa/releases/tag/v0.2.4) 提供，已在 macOS arm64 上验证；[Docker Hub](https://hub.docker.com/r/teloa/teloa) 提供同版 **Linux ARM64** 镜像。[npm](https://www.npmjs.com/package/@teloa/cli) 提供同一版本。下方仍保留源码构建方式。

### 本次更新重点

**工作台与首次使用更清楚：** 头像进入“我的分身”，设置保留独立入口；主聊和员工会话在切换、刷新后保留文字草稿。首次仅配置一个 BYOK 提供方时，可初始化缺密钥的默认模型，群路由跟随当前默认。任务草稿与真实保存明确区分，必要时可带着原目标按表单创建，开始执行前走原生确认卡。会话归档支持撤销，高影响操作明确确认。

**0.2.4 让 AI 团队更稳定地承接持续业务：** 已接入业务来源的新事件可逐条启动员工工作，业务首页如实显示哪些来源已真正接入。群内交接、引用原任务续办和被暂停的工作会说明当前状态，并可在原处重试或恢复。交付复核能从更多模型失误中按具体提示纠正，不再因上下文压缩或一次无害的被拒调用而失败。工作额度按滚动 24 小时统计模型耗时并说明停止原因；本人执行 `teloa upgrade` 后，会自动恢复仅因本次重启而暂停的工作。 会话中由 AI 创建的员工与团队可在市场直接导入；会话生成的应用会引用应用目录中真实可用的连接，并可在应用目录完成账号设置；资料库按员工显示其自带资料与工作成果；普通会话按需加载平台工具，避免携带未使用的工具定义。

**0.2.3 优化日常协作体验：** 会话、群聊、任务和项目统一使用成果右栏，列表与正文依次呈现，保留版本和草稿，可从会话目录直接读取已有成果。员工协作邀请、市场和详情布局更紧凑；已完成群回复不再导致任务目录读取失败。

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
npm install --ignore-scripts https://github.com/teloa-ai/teloa/releases/download/v0.2.4/teloa-cli-0.2.4.tgz
./node_modules/.bin/teloa up
./node_modules/.bin/teloa doctor
./node_modules/.bin/teloa status
```

Teloa 与 DSH 在电脑上原生运行。启动后打开 Web 界面，在设置中配置模型；默认 Web 端口为 3100。新安装端口被占用时，使用 `./node_modules/.bin/teloa up --port 3101`。发行页同时列出安装包的 SHA-256 校验值。升级已有安装（例如 0.2.0-alpha.7）并保留其数据与身份：把 0.2.4 安装包装入新的命令目录，在该目录运行 `teloa stop`，再运行 `teloa upgrade --to 0.2.4`（自定义安装继续传入原 `--home`）。升级会在切换前自动备份。启停操作见[安装指南](https://docs.teloa.ai/start/quickstart)，备份见[备份与升级](https://docs.teloa.ai/deploy/backup)。也可从 npm 安装同版：`npm install --ignore-scripts @teloa/cli@0.2.4`。

<details>
<summary><strong>Docker Hub + Compose（0.2.4）</strong></summary>

### Docker Hub + Compose

先安装带 Compose 的 Docker，并启动 Docker 引擎。正式镜像及以下配置已验 **Linux ARM64**；**amd64 尚未验证**。Teloa、DSH 与 PostgreSQL 均在容器内运行，本机不需要安装 Node.js 或 pnpm。

将本版本配置下载到新目录。初始化与应用均使用 `teloa/teloa:0.2.4`，沿用持久数据卷与自动生成的数据库口令。

```sh
mkdir teloa-community
cd teloa-community
curl --fail --location https://docs.teloa.ai/downloads/0.2.4/compose.yaml --output compose.yaml
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

![Teloa 社区版中的内容运营业务：业务内容页列出示例记录，统计看板、AI 员工、协作群与项目在同一业务内](https://docs.teloa.ai/assets/screenshots/business-page-024.7e05c5b73773.png)

*0.2.4 真实界面，8 条虚构示例记录。一个业务把记录、看板、AI 员工、协作群与项目放在一起；“开始工作”从这里发起工作。*

以 **安全运营（SOC）**为例：

1. 描述要跟进的告警业务，核对记录字段和页面。
2. 添加本地记录、导入支持的表格，或配置有权限使用的数据连接。
3. 为研判员工提供流程、证据和工具，把具体告警交办为调查任务。
4. 查看任务进度、核对证据，验收关联到该告警的成果。
5. 用看板汇总告警状态、严重度和趋势。

添加团队模板不会自动连接账号、授权员工或启动定时工作。这些配置由你决定。

[![内容运营总览看板（示例数据）](https://docs.teloa.ai/assets/screenshots/business-dashboard-detail-024.e787ba1992b7.png)](https://docs.teloa.ai/assets/screenshots/business-dashboard-024.22f992c8cf57.png)

*各业务的看板用法相同。此例为 0.2.4 界面中市场采用的内容运营看板与 8 条虚构示例记录，不是实时数据。局部预览，点击可查看完整原图。*

SOC 是首个完整业务流程场景。客户交付、内容运营、电商零售、软件研发、教育培训、门店服务和其他安全方向是**后续场景示例**，不代表这些集成已经完成。见[行业场景与业务组合](https://docs.teloa.ai/tutorials/industry-examples)和 [SOC 使用教程](https://docs.teloa.ai/tutorials/soc-triage)。

<a id="数据权限与版本定位"></a>

## 版本选择

Teloa 的三个版本共享同一产品核心，面向不同的使用场景。本仓库维护社区版的开源代码。

| 版本 | 定位与使用场景 |
| --- | --- |
| 社区版 | 面向个人与开发者的开源版本，自行部署与配置，用 AI 员工、协作、任务、自动化和技能搭建自己的工作平台。 |
| 专业版 | 面向个人与专业用户的 Mac 原生应用，开箱即用，在本机执行任务、操作文件与应用；通过手机随时新建、跟进和接续工作。 |
| 企业版 | 面向企业与组织，部署在企业云或内网，统一管理成员、共享 AI 员工、权限与审计，连接企业内部数据、系统和业务流程。 |

## 从业务系统调用员工

在**设置 > 员工对外调用**创建限定员工版本、业务范围和操作权限的密钥，即可通过 **HTTP API、TypeScript/JavaScript SDK 或 MCP Server** 调用员工。请求使用持久工作 ID 与幂等键，成果保留固定版本和校验摘要；签名 CloudEvents 回调提供重试与投递记录。

调用沿用原员工权限、BYOK 和 Task/Run 执行链路。执行完成、工具审批与业务验收分别处理。详见 [SDK 与调用契约](packages/sdk/README.md)或[业务集成指南](https://docs.teloa.ai/develop/employee-api)。

## 文档导航

| 你想做什么 | 从这里开始 |
| --- | --- |
| 安装与完成第一项工作 | [安装指南](https://docs.teloa.ai/start/quickstart) · [第一项任务](https://docs.teloa.ai/start/first-task) |
| 组建 AI 团队 | [AI 员工](https://docs.teloa.ai/guides/colleagues) · [群协作](https://docs.teloa.ai/guides/groups) |
| 搭建业务与扩展能力 | [业务与看板](https://docs.teloa.ai/guides/business) · [市场资源](https://docs.teloa.ai/guides/market) |
| 了解行业工作方式 | [行业场景](https://docs.teloa.ai/tutorials/industry-examples) · [SOC 教程](https://docs.teloa.ai/tutorials/soc-triage) |
| 维护与升级 | [备份与升级](https://docs.teloa.ai/deploy/backup) · [安全政策](SECURITY.md) |
| 了解智能体安全与评估平台 | [Teloa AI Security](https://security.teloa.ai/?lang=zh-CN) · [安全基线自评](https://security.teloa.ai/agent-baseline-assessor/?lang=zh-CN) |
| 开发可复用资源 | [AI 员工](https://docs.teloa.ai/develop/employees) · [AI 团队](https://docs.teloa.ai/develop/teams) · [应用](https://docs.teloa.ai/develop/apps) · [SKILL](https://docs.teloa.ai/develop/skills) |
| 分享与接收资源 | [离线文件、在线链接、接收与撤销](https://docs.teloa.ai/guides/sharing) |
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
