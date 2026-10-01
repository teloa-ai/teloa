# Teloa 官方 Browser Use 可选组合

固定 DSH `0.1.7-rc.1`，复用 `dsh-browser-use` 与实验性 Playwright MCP provider。此包不包含浏览器实现、MCP 转发器或岗位授权逻辑。

此包尚未独立发布到 npm。候选工作区可以在原生插件管理页用本目录的绝对路径安装。安装并启用 bundle 后，两个插件行仍默认关闭；可在原生详情依次启用 `teloa-browser-use` 和 `teloa-browser-playwright`，或在该 profile 的 `cordis.patch.yml` 中添加：

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

省略 `executablePath` 时由官方运行时发现浏览器；此包不下载浏览器。启用发生在创建或恢复会话之前，已活动会话不会自动取得浏览器。工具命名空间为 `mcp__playwright-mcp__*`；提供方初始化失败由原生插件/会话诊断报告，不能用“已安装”代替“可用”。一次只配置一种官方 Browser Use 提供方。

这不是侧边栏 iframe Browser。截图需要已配置的附件存储与支持图像输入的模型。默认是每活动会话独立的 launch 浏览器；如需 attach，必须由操作者显式配置官方 `mode: attach` 与 `endpoint`，并遵守单活动会话所有权限制。

此组合不改变沙箱、审批、受管任务身份或岗位工具授权。浏览器可操作外部网页，不由文件沙箱隔离其网络效果；读取与外部提交仍按 Teloa 任务规则授权。停用顺序为先 provider、再 registry；整个 bundle 停用交由官方生命周期清理。

完整验收条件见 [原生能力说明](https://docs.teloa.ai/guides/native-capabilities)。

## English

An optional composition of the official DSH `0.1.7-rc.1` Browser Use registry and experimental Playwright MCP provider. Both rows remain disabled after installation; explicitly enable the registry and provider before creating or restoring a session. Configure an installed Chromium executable as needed. Installation does not grant Teloa roles permission to use browser tools. Real browser, cancellation, session isolation, and external-action authorization acceptance remain required.
