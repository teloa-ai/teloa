# Teloa 官方 Computer Use 可选组合

固定 DSH `0.1.7-rc.1`，复用 `dsh-computer-use` 与实验性 Cua native provider；原生驱动由其固定依赖 `@trycua/cua-driver@0.28.0` 提供。安装时保留 optional dependencies。本包不实现桌面驱动，也不安装 Teloa 桌面应用。

此包尚未独立发布到 npm。候选工作区可以在原生插件管理页用本目录的绝对路径安装。bundle 与两个插件行均需要显式启用；安装本身不初始化 SDK、请求 OS 权限或占用 Computer Use 注册器。在原生详情依次启用 `teloa-computer-use` 和 `teloa-computer-cua`，或者添加 profile patch：

```yaml
- id: teloa-computer-use
  disabled: false
- id: teloa-computer-cua
  disabled: false
```

官方 native provider 没有自定义 Config。工具命名空间为 `cua_driver_native__*`。启动 DSH 的宿主进程必须具有目标平台桌面权限；首先只读调用上游目录中的 `check_permissions`，参数 `prompt: false`。不要把工具目录存在或 provider 激活成功当成截图/输入权限已具备。

截图还需要官方附件服务和图像模型路由。所有会话共享同一真实桌面，官方 registry 只限制提供方，不串行协调各会话的完整操作流程。验收期间独占明确的测试窗口与临时目录；实际动作需要独立任务授权。文件沙箱不限制桌面输入效果。取消不会撤销已经送达应用的点击或输入，重试前要读取新状态。

加载失败与权限不足使用官方诊断；此组合不改变 Teloa 的工具授权或审批规则。停用时先 provider、再 registry，或整体停用 bundle 让官方释放资源。完整验收见 [原生能力说明](https://docs.teloa.ai/guides/native-capabilities)。

## English

An optional composition of the official DSH `0.1.7-rc.1` Computer Use registry and experimental Cua native provider. Both rows are disabled by default. Preserve native optional dependencies and explicitly enable the rows. Check permissions with `prompt: false` before any screenshot or input. The launching host owns OS permissions, and concurrent sessions share the desktop. No role grant, file sandbox, or business approval is changed by this package.
