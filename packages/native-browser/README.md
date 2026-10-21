# Teloa 官方 Browser Use 可选组合

固定 DSH `0.2.1-rc.2`，复用 `dsh-browser-use` 与实验性 Playwright MCP provider。此包不包含浏览器实现、MCP 转发器或岗位授权逻辑。

此包随 Teloa CLI 工件提供，不单独发布到 npm。启用 bundle 后，两个插件行仍默认关闭；可在原生详情依次启用 `teloa-browser-use` 和 `teloa-browser-playwright`，或在该 profile 的 `cordis.patch.yml` 中添加：

```yaml
- id: teloa-browser-use
  disabled: false
- id: teloa-browser-playwright
  disabled: false
  config:
    mode: launch
    headless: true
    executablePath: /absolute/path/to/chromium
```

启用组合包也会恢复官方右侧「开始 → 浏览器」入口，提供地址栏、沙箱 iframe 与「在系统浏览器中打开」。这是手动网页浏览面板，不会自动授予助手工具权限，也不与下面的 Playwright 会话共享页面。网站的 CSP 或 X-Frame-Options 可能禁止嵌入；保留这些限制，通过官方外部打开入口继续浏览。

省略 `executablePath` 时由官方运行时发现浏览器；此包不下载浏览器。启用发生在创建或恢复会话之前，已活动会话不会自动取得浏览器。工具命名空间为 `mcp__playwright-mcp__*`；提供方初始化失败由原生插件/会话诊断报告，不能用“已安装”代替“可用”。一次只配置一种官方 Browser Use 提供方。

默认是每活动会话独立的无头 launch 浏览器，不弹出本机浏览器窗口。`mcp__playwright-mcp__browser_navigate` 和 `mcp__playwright-mcp__browser_tabs` 按需创建页签，无需用户提供 PID；它们与 CUA 的本机浏览器接管工具属于不同提供方。截图需要已配置的附件存储与支持图像输入的模型。如需 attach，必须由操作者显式配置官方 `mode: attach` 与 `endpoint`，并遵守单活动会话所有权限制。

此组合不改变沙箱、审批、受管任务身份或岗位工具授权。浏览器可操作外部网页，不由文件沙箱隔离其网络效果；读取与外部提交仍按 Teloa 任务规则授权。停用顺序为先 provider、再 registry；整个 bundle 停用交由官方生命周期清理。

受控兼容补丁 `teloa.browser-chromium-sandbox/v1` 为官方 launch 配置增加可选 `chromiumSandbox: true`。仅明确为 `true` 时，固定 Playwright MCP `0.0.80` 收到 `--sandbox`；省略或 `false` 保持上游默认参数，attach 模式不改变外部浏览器。此选项不授予工具或网络权限，也不证明当前平台已具备内核隔离。需要浏览器沙箱的部署应核对 provider 的公开 `chromiumSandboxVersion === 1`、实际配置结果与运行平台的隔离能力，缺少补丁时拒绝启动该部署。

两个补丁及原文件、结果文件、补丁自身的 SHA-256 位于 [`harness-dsh/compat`](../harness-dsh/compat/) 中的 `dsh-experimental-browser-use-runtime-0.2.1-rc.2-chromium-sandbox` 与 `dsh-experimental-browser-use-playwright-mcp-0.2.1-rc.2-chromium-sandbox` 清单。普通依赖安装保持官方原文件；发行准备须按清单核验并只对新的发行副本应用补丁。可在仓库根执行 `pnpm check:browser-compat`，对隔离副本复验官方配置、类型和实际 provider→MCP stdio 调用；已安装 Chromium 时也会读取隔离的无头本机页面。可用 `TELOA_BROWSER_COMPAT_EXECUTABLE` 指定可信的已安装 Chromium，不会下载浏览器。

完整验收条件见 [原生能力说明](https://docs.teloa.ai/guides/native-capabilities)。

## English

An optional composition of the official DSH `0.2.1-rc.2` Browser Use registry and experimental Playwright MCP provider, included in the Teloa CLI artifact rather than published separately. Both rows remain disabled after installation; explicitly enable the registry and provider before creating or restoring a session. Configure an installed Chromium executable as needed. Installation does not grant Teloa roles permission to use browser tools. Real browser, cancellation, session isolation, and external-action authorization acceptance remain required.

The default launch mode uses an isolated headless browser per active session. The Playwright `browser_navigate` and `browser_tabs` tools create tabs as needed without a PID; they are separate from CUA's native browser attachment tools. A headless session does not open a visible desktop browser window.

Enabling the bundle also restores the official **Start → Browser** sidebar entry with an address bar, sandboxed iframe and an external-browser action. This manual browsing pane does not share pages with the assistant's Playwright session or grant tool permissions. Website CSP and X-Frame-Options restrictions remain in force; use the official external action when embedding is blocked.

The controlled `teloa.browser-chromium-sandbox/v1` compatibility patch adds optional `chromiumSandbox: true` to launch configuration. Only `true` adds the pinned MCP server's `--sandbox` argument; omission, `false`, and attachment retain upstream behavior. Deployments requiring a browser sandbox must verify `chromiumSandboxVersion === 1` and actual platform isolation. Run `pnpm check:browser-compat` to verify isolated official package copies without changing installed dependencies.
