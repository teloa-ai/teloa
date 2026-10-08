# @teloa/harness-dsh

Teloa 社区版的 DSH 适配包：任务执行、授权检查以及宿主装配用到的公共能力。本文说明供宿主组合使用的接口。

## 原生输入组合

子路径：`@teloa/harness-dsh/native-input-composition`（npm 发行包内为 `packages/harness-dsh/lib/native-input-composition.js`）。

需要对原生输入（发送、排队、子代理、冷恢复）做工作准入的宿主，要把官方会话控制器与子代理的宿主行换成本包的受管提供方。DSH 的客户端模块发现只读取启用行入口所在包根的 `dsh.client`，受管行的入口是本包子路径，不是浏览器模块。只换宿主行时，被替换官方包的浏览器面会一起丢失：工作台缺少 `sessions` 服务，整页加载失败。

本接口把三件事放在一处：兼容能力核对、行替换补丁、浏览器面载体。替换声明了浏览器面的官方行时一定同时插入载体行，组合完成后再按同一发现规则核对，缺失就拒绝启动。

社区版的源码、npm 与容器启动入口统一在官方 profile 基础树上调用本接口，启用受管会话控制器、子工作与 Goal 续轮；消费核心的宿主复用相同接口。组合在私有运行副本中应用，不修改官方安装包或基础 profile。

本版 Goal 自动续轮绑定同事或分身的 TaskRun，并核对岗位授权、当前执行轮和持久受理票据。普通本人会话保留目标只读查询；`create_goal`、`update_goal` 在工具体之前拒绝，需从任务入口开始持续工作。本版不另建普通会话 Goal 的执行、预算或恢复体系。

### 调用顺序

```js
import {
  nativeInputCompositionVersion,
  loadNativeInputProviders,
  composeNativeInput,
  assertNativeInputClientFaces,
  assertNativeInputProviders,
} from '@teloa/harness-dsh/native-input-composition'

if (nativeInputCompositionVersion !== 1) throw new Error('核心的原生输入组合接口版本不符。')

// 1. 启动早期：核对兼容能力，再导入受管提供方
const providers = await loadNativeInputProviders({compatibilityAPIs, requireGoal: true})

// 2. 按官方补丁算法得到完整生效树，生成组合补丁并追加到宿主覆盖补丁末尾
const rows = applyEntryPatches([], readProfilePatches('dsh', {...profileContext, overlays}), fail)
overlays.push(...await composeNativeInput(rows, {providers, runtimeRoot}))

// 3. 宿主自己的其他覆盖补丁（包括之后再替换受管行）照常追加

// 4. 启动 DSH 之前：用包含全部覆盖补丁的最终生效树核对浏览器面
const finalRows = applyEntryPatches([], readProfilePatches('dsh', {...profileContext, overlays}), fail)
assertNativeInputClientFaces(finalRows)

// 5. 启动后：核对实际装配的服务是受管提供方
const {ctx} = await runProfile({...launch, patchFiles: [overlayFile]})
assertNativeInputProviders(ctx, providers)
```

| 接口 | 说明 |
| --- | --- |
| `loadNativeInputProviders({compatibilityAPIs, requireCheckpoint?, requireGoal?})` | `compatibilityAPIs` 是宿主已核对并应用的官方兼容补丁清单，形如 `{[包名]: 清单 api}`。缺少 `nativeInputRequiredAPIs` 中任一能力时拒绝；`requireCheckpoint: true` 还要求 `nativeInputCheckpointAPIs`，`requireGoal: true` 还要求 `nativeInputGoalAPIs`。消息列出包名与缺少的能力名，此时不导入任何执行模块。返回冻结的 `{input, controller, subagent, recoveryCandidate?, goal?}`，只有这个返回值能用于后续两步。 |
| `composeNativeInput(rows, {providers, runtimeRoot, inputProvider?, resolve?})` | `rows` 是官方 `applyEntryPatches` 得到的完整生效树（含父组），不会被修改。返回补丁列表，下表列出它生成的行。`runtimeRoot` 是宿主私有运行目录，必须已存在且为规范绝对路径。`inputProvider` 可换成宿主自己的原生输入提供方模块（例如配置了持久确认的包装）。`resolve` 用于解析实际安装的官方包，默认按本包依赖解析，与受管类继承的官方类同源。 |
| `assertNativeInputClientFaces(finalRows, {resolve?})` | 只读核对。被替换的官方包若声明了浏览器面，启用行中必须恰好有一个按官方发现规则提供它的来源。相对路径入口依赖所属子树的解析基址，不计入。 |
| `assertNativeInputProviders(ctx, providers, {resolve?})` | 实际装配的 `teloaNativeInput`、`sessionController`、`subagents` 必须是受管提供方或其子类。启用 `requireGoal` 时，还核对实际 `teloaManagedGoalRoundDriver` 与当前 `teloaTaskRunGoal` 是同一提供方。组合里有浏览器端（存在官方 `clientModules` 服务）时，还核对它的模块表含被替换官方包的浏览器面：宿主漏做组合后核对时，这里是第二道失败关闭。没有浏览器组合时不做这一项。 |

### 生成的行

| 行编号 | 内容 |
| --- | --- |
| `teloa-native-input` | 原生输入准入服务，默认 `@teloa/harness-dsh/native-input-provider`。 |
| `agent-loop` | 依赖追加 `teloaNativeInput`（数组、对象、缺省三种形态都支持）；保留原配置并设 `requireRestoreAdmission: true`。 |
| `typert-loader` | `packages` 追加两个官方包名：官方加载器不从子路径入口发现远程调用描述，这里沿用原包的描述。 |
| `session-controller`、`subagent` | 官方行停用；在原父组插入 `teloa-managed-session-controller`、`teloa-managed-subagent`，保留原配置与依赖。 |
| `goal-round-driver` | 启用 `requireGoal` 时，官方行停用；在原父组插入 `teloa-managed-goal-round-driver`，保留原配置与依赖。使用核心持久 Goal 准入，不复制官方目标领域与模型循环。 |
| `teloa-client-face-session-controller` | 浏览器面载体，与受管行在同一组，但独立成行。官方包没有声明浏览器面时不生成，目前子代理就是这种情况。 |

组合树里已有上述保留行编号，或官方行缺失、重复、被停用、带启用条件、已被替换时，一律拒绝。同一棵树不能组合两次。

### 浏览器面载体

- 从实际安装、已应用兼容补丁的官方包读取，版本必须等于本包 `engines.dsh`，不符时消息写明“安装为 X，核心固定 Y”。
- 入口取 `exports["./client"]`，判定与官方发现规则（dsh-client-modules 的 `clientExportOf`）逐条一致：字符串直接取；对象只取字符串 `default`，`types`、`browser`、`import` 等其他条件官方不读，这里也不读；其余形态官方报错，这里同样拒绝。没有该导出、形态不合要求时，消息分别写明。另外，入口必须落在包内（官方不检查这一点，这是本接口另加的核对）。
- 载体包的名称与版本同官方，只含官方 `client.js`、原样的 `dsh.client` 声明，以及什么也不做的宿主一半（`apply(){}`）。`teloaClientFace` 字段记录 schema `teloa.native-client-face/v1` 和 `client.js` 的 sha256。
- 写在 `runtimeRoot/native-client-faces/<行>-<内容摘要>/`，目录 0700、文件 0600。先在同级临时目录（`.staging-*`）写好再整体改名，中途退出最多留下临时目录，不会留下不完整的载体。
- 已有载体逐项核对文件集合、类型、链接数、权限和字节。被改动、类型或权限无效（例如运行目录经复制迁移后权限变宽）时保留现场并拒绝启动，不会自动覆盖；消息写明出问题的目录绝对路径。
- **恢复方法**：载体内容只由官方安装决定。确认无须留证后，删除消息里给出的目录（载体目录或 `native-client-faces/` 本身）并重新启动，即可按当前安装重新生成。
- 组合成功后自动删除超过 1 小时的 `.staging-*` 临时目录（中途退出的残留）。未满 1 小时的可能属于正在启动的另一进程，保留；链接和普通文件不处理。
- 升级 DSH 或兼容补丁后，旧内容摘要的载体目录不再被引用，本接口不自动删除。当前载体目录就是返回补丁中 `teloa-client-face-*` 行入口所在的目录；宿主可按自己的保留规则，在没有运行中实例引用时删除 `native-client-faces/` 下其他摘要目录。
- 官方浏览器面带懒加载分块文件时拒绝，载体只承载单文件。

### 失败时拒绝启动

所有核对失败都抛出 `NativeInputCompositionError`（`name` 同名）。消息以“原生输入组合未通过核对，拒绝启动：”开头并写明原因，例如缺少会话控制器的浏览器面。宿主应停止启动并展示该原因，不要放出缺少浏览器面的工作台。

### 已有自建副本的宿主如何迁移

1. 确认所消费的核心提供本子路径，且 `nativeInputCompositionVersion === 1`。
2. 删除自建的兼容 schema 白名单与能力核对，把已应用的兼容补丁清单（`{包名: api}`）交给 `loadNativeInputProviders`。需要持久确认时传 `requireCheckpoint: true`，并从返回值取 `recoveryCandidate`。
3. 删除自建的行替换补丁生成（包括 `typert-loader.packages` 补包），改用 `composeNativeInput`。自有的原生输入提供方模块经 `inputProvider` 传入。
4. 删除自建的浏览器面载体生成，不再单独插入载体行，`composeNativeInput` 的返回值已经包含载体行。不要从返回值中筛掉任何补丁。
5. 宿主之后若还要替换受管行（例如换成自己的子类），保留这一步，按 `teloa-managed-session-controller` 等行编号定位。随后对最终生效树调用 `assertNativeInputClientFaces`。
6. 启动后改用 `assertNativeInputProviders` 核对服务实例，删除自建的同类核对。
7. 运行目录里旧的自建载体目录不再被引用，宿主按自己的保留规则清理即可。新载体在 `native-client-faces/` 下，非当前摘要的目录同样按保留规则清理（见“浏览器面载体”）。
8. 用宿主自己的发行形态验证：工作台首屏能加载、会话服务可用；保留“插件图包含 `@deepseek-ai/dsh-api-session-controller` 浏览器面”的断言。

若上游 DSH 以后支持替换提供方沿用原包的浏览器面与远程调用描述，本接口会删除载体逻辑，宿主调用方式不变。

## English

`@teloa/harness-dsh/native-input-composition` is a host-side composition API for hosts that enable native input admission by replacing the official session controller and subagent host rows with the managed providers from this package. DSH client-module discovery reads `dsh.client` only from the package root of each enabled row, so a bare row replacement drops the official browser face (the workbench `sessions` service). The API centralizes the compatibility check (`loadNativeInputProviders`), the row replacement patches including the `typert-loader` package list (`composeNativeInput`), and a carrier package for the browser face, generated from the actually installed, patched official package (its `exports["./client"]` entry is read exactly as the official discovery reads it: a string, or an object's string `default`) and always inserted as its own row whenever a row that declares a browser face is replaced. After all overlays, `assertNativeInputClientFaces` verifies that exactly one enabled source provides each replaced browser face; `assertNativeInputProviders` verifies the booted services and, when the composition has a browser side, checks the official `clientModules` graph as a second fail-closed guard. Every failure throws `NativeInputCompositionError` with a stated reason so the host can refuse to start; carrier failures name the directory, which can be deleted (once no evidence needs to be kept) to regenerate it on the next start. Stale `.staging-*` directories older than one hour are removed after a successful composition; carrier directories for older digests are left to the host's retention policy. Community source, npm, and container entry points also use this API on the official profile tree. Hosts enabling goal continuation pass `requireGoal: true`, declare `nativeInputGoalAPIs` in the applied compatibility list, and provide the current `teloaTaskRunGoal` before the managed round driver starts; startup verifies their shared identity. Official package copies and client-face carriers remain in the private runtime directory. See the migration steps above for hosts that maintain their own copies.
