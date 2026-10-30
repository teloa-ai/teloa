# Teloa Web 工作台设计审查与验收

日期：2026-10-30。分支：`codex/apple-design-audit`。基线：`30b9a32`。

## 总体结论

本轮审查围绕 React Web 工作台的共享主题、导航、任务目录，以及任务、项目和员工表单展开。产品的核心工作是让用户描述目标、审阅工作与交付、掌握员工和待确认事项；现有员工形象、暖灰背景、墨黑主操作与暖红点缀与这一定位相符，予以保留。

总体评价：**Good（本轮覆盖范围）**。主要可访问性缺陷与高频表单摩擦已修复，品牌和原有工作流程保持一致。

以 apple-design 技能为审查方法，把 HIG 的层级、排版、布局、反馈和可访问性原则翻译为 HTML、CSS、ARIA 和浏览器偏好。原生平台专用要求单独界定，验收以实际代码与无头浏览器测量为依据。

## Critical：已修复

### 任务表格的可访问性语义冲突

原 `TaskList` 把原生表格放在 `role="listbox"` 中，又把 `tr` 改为 `role="option"`，选项内仍有任务按钮。axe 实测报告 `aria-required-children`、`aria-required-parent` 与 `nested-interactive`，辅助技术无法可靠取得表格与操作的关系。

修复：保留原生 `table / th / td / button`，给表格命名、表头添加 `scope="col"`，把焦点与 `aria-current="page"` 放到实际任务按钮上，每个按钮均可 Tab 进入，并保留方向键、Home、End、Enter 和空格操作。筛选或收起分组隐藏当前任务时，可见任务仍能从 Tab 进入。数据仍通过原选择回调打开。

依据：`accessibility.md › Mobility`，以及 [WAI 表格模式](https://www.w3.org/WAI/ARIA/apg/patterns/table/)。该目录按任务导航，未引入需要逐单元格焦点管理的电子表格式 grid。

### 字号设置没有覆盖完整信息层级

原正文随用户设置变化，但 12/13px 的辅助文字与控件字号，以及 16/18/20px 的标题仍固定，正文放大时层级比例失衡。

修复：以用户正文设置为同一比例轴，默认视觉尺寸保持不变，辅助文字和标题同步缩放；正文值使用 rem 换算，使浏览器默认字体设置同样有效。代码与终端仍沿用各自字号和字体设置。

依据：`layout.md › Adaptability`：“Be prepared for text-size changes.”；`typography.md › Supporting Dynamic Type`。网页对应浏览器字体设置与缩放，不套用原生 Dynamic Type API。

### 重要输入框边界对比度不足

原任务与项目表单复用装饰分隔线，浅色 `#ece8e1` 对白色为 **1.22:1**，深色 `#2a2825` 对 `#1f1e1c` 为 **1.13:1**。

修复：增加独立的 `control-border` 语义令牌。浅色 `#8f897f` 对白色为 **3.47:1**，深色 `#7b756b` 对 `#1f1e1c` 为 **3.65:1**。仅输入边界和共享目录搜索使用更清晰的描边，普通分隔线保留原色。

依据：`accessibility.md › Vision`、`color.md › Best practices`，以及 [WCAG 1.4.11 非文本对比度](https://www.w3.org/WAI/WCAG22/Understanding/non-text-contrast.html)。比值由实际 sRGB 令牌计算。

## Improvements：已完成

| 级别 | 问题与改动 | 依据 |
| --- | --- | --- |
| High | 任务与项目缺项时原提交按钮不可用，缺少纠错路径。改为允许触发校验、失焦提示、关联字段错误、定位首个缺项，并展开包含缺项的补充选项。空白不会写入；保存中仍禁用提交。 | `text-fields.md › Best practices`：“Validate fields when it makes sense.” |
| High | 员工表单已有产品校验，但错误与字段缺少关联。姓名、职责、资料与执行范围补充 `aria-describedby` 和相应无效状态。 | `accessibility.md`；`entering-data.md › Best practices` |
| Medium | 保存失败后保留全部输入；重试时清除旧服务错误。保存状态通过独立于忙碌表单的 `role="status"` 通知，错误使用文字与 `role="alert"`，避免只靠颜色。 | `feedback.md › Best practices`：“Consider integrating status feedback into your interface.” |
| Medium | 任务创建及员工配置主操作与取消缺少区分。创建/保存、员工下一步与确认按钮使用现有墨黑主操作令牌，取消保持次要外观。 | `layout.md › Visual hierarchy`：“Order content by relative importance.” |
| Medium | 目录标题与状态并排、面包屑页名不换行，放大后容易挤压。标题、状态与页名可按空间换行，操作保持独立空间。 | `layout.md › Adaptability` |
| Medium | 共享工具按钮为 32px，触摸操作偏紧。粗指针下扩大至 44×44 CSS px；任务/项目表单窄屏操作、目录触摸筛选和清除按钮同样扩大。 | `accessibility.md`；[WCAG 2.5.8](https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html) |
| Medium | 表单默认段落外边距与容器间距叠加。任务表单按 8/16/24px 节奏分组，说明与字段更紧密，按钮区独立。 | `layout.md › Visual hierarchy`：“Group related items to clearly express related information or functions.” |
| Medium | 为未单独声明焦点样式的控件增加可见焦点后备，覆盖 portal；减少动态效果、高对比和强制颜色偏好有显式响应。 | `motion.md › Best practices`：“Make motion optional.”；`accessibility.md` |

## 令牌与布局决策

只扩展现有语义，不引入新品牌色、字体或玻璃材质。以下文字色与边界对比度均以同列 surface 为背景计算。

| 角色 | 浅色 | 深色 | 浅色 / 深色对比度 |
| --- | --- | --- | --- |
| surface | `#ffffff` | `#1f1e1c` | 背景 |
| text | `#1c1b19` | `#ece9e3` | 17.21 / 13.75 |
| muted | `#6b665e` | `#9a958c` | 5.70 / 5.59 |
| accent | `#a34529` | `#f2a386` | 6.10 / 8.22 |
| danger | `#9a3d22` | `#e8a08a` | 6.85 / 7.79 |
| control-border | `#8f897f` | `#7b756b` | 3.47 / 3.65 |

保留系统字体栈。默认层级为辅助 12、控件 13、正文 14、阅读 15、分节 16、对话框 18、详情 20、页面 24、首屏 28 CSS px；权重维持 400/500/600。本人正文设为 28 时，控件为 26、对话框标题为 36；浏览器根字号由 16 调到 32 时得到同样结果。

布局围绕“先描述工作，再补充选项”组织：

```text
常规宽度                         紧凑宽度
┌导航┬面包屑／页内操作────────┐    ┌面包屑（可换行）／操作┐
│    ├工作台页内导航─────────┤    ├工作台页内导航───────┤
│    │目录／任务与交付内容   │    │当前目录或详情       │
│    │                      │    │                     │
└────┴──────────────────────┘    └─────────────────────┘
        ┌交办一项工作────┐          ┌交办一项工作────┐
        │说明／必填提示  │          │说明／必填提示  │
        │目标与就地反馈  │          │目标与就地反馈  │
        │更多选项        │          │更多选项        │
        │取消／创建任务  │          │取消／创建任务  │
        └────────────────┘          └────────────────┘
```

设计判断：这是一轮工作工具的可用性完善，保留员工形象、任务内容优先和自然语言交办入口，未套入新的通用视觉模板。去掉的是重复叠加的段落留白；没有增加装饰或额外动效。

依据：`branding.md › Best practices`：“Ensure branding always defers to content.”；`cross-platform.md › Vocabulary`。

## 网页与原生平台的适用边界

- 网页采用信息层级、语义颜色、可见焦点、可访问命名、错误关联、响应式、字体放大和用户偏好响应。
- 网页以 CSS 像素验收。[WCAG 重排](https://www.w3.org/WAI/WCAG22/Understanding/reflow.html)的 320 CSS px 与触摸目标的 24px 最低规则是 Web 判断依据，本轮主要触摸操作采用更舒适的 44px。HIG 的 pt 尺寸与原生字体基线不直接当作 CSS 数值要求。
- `designing-for-macos.md` 中的系统菜单栏、窗口控制、原生设置窗口，以及 iOS tab bar、SF Symbols、Dynamic Type API、原生 Liquid Glass 和设备折叠适配不强制移植到网页。
- 保留 Web 中已有的主题与字体偏好，不因原生平台“跟随系统外观”的建议删除用户设置。对比模式使用浏览器媒体查询和系统颜色。

## 验收与证据

验收使用仓库真实 React 组件、CSS Modules、主题呈现器与翻译；外壳导航采用共享导航组件和同形测试外框。所有网络请求都由夹具拦截，不访问真实实例、模型或用户数据。

新增 `apple-design-audit.browser.test.ts`，覆盖：

- 四个宽度 320/390/768/1440 × 明暗主题 × 默认/两倍字号，三类表单共 48 种布局组合，检查文档和对话框横向溢出。
- 另在 320px 下检查员工创建四步 × 明暗主题 × 默认/两倍字号，共 16 种步骤组合；姓名、职责、权限核对与工牌各步均可继续、返回和退出，不创建员工。
- 必填反馈与描述关联、隐藏缺项展开与聚焦、自动拟名和手改名称保持、原生日期约束、服务失败输入保留、在途去重、关闭保护与焦点返回。
- 用户字号和浏览器默认字体的实际计算值；44px 触摸工具按钮；键盘焦点；减少动态效果与强制颜色模式。
- 真实任务按钮的方向键/Home/End/Enter 导航，以及 axe 对明暗主题下的目录与三类表单共 8 个场景的自动检查。

可复现命令：

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm check:client
node --test --test-concurrency=2 \
  packages/client/ui-workbench/tests/apple-design-audit.browser.test.ts \
  packages/client/ui-workbench/tests/theme-contrast.test.ts \
  packages/client/ui-workbench/tests/task-list-render.test.ts \
  packages/client/ui-workbench/tests/creation-dialog-dismiss.browser.test.ts \
  packages/client/ui-workbench/tests/project-drafts.browser.test.ts \
  packages/client/ui-workbench/tests/theme-typography.browser.test.ts \
  packages/client/ui-workbench/tests/platform-font-family.browser.test.ts \
  packages/client/ui-workbench/tests/work-directory-density.browser.test.ts
```

浏览器依赖使用仓库现有 Playwright 加载器。若需额外 axe 检查，可在 `.runtime/` 中安装工具，将 `TELOA_UI_AUDIT_AXE` 指向 `axe-core/axe.min.js`；未设置时仅跳过这一项，不影响其他回归。`TELOA_UI_AUDIT_CAPTURE` 指向截图输出目录。

测量日志、截图、布局尺寸和 axe 报告保存至 `.runtime/apple-design-audit/`；构建及回归日志保存在 `.runtime/ui-audit-*.log`。这些是本地验收产物，不提交仓库。

自动测试不能替代真人 VoiceOver/TalkBack 阅读顺序和真实手机软键盘测试；本轮未对这些环境或未逐一挂载的全部业务页宣称完整 WCAG 符合性。

### 全仓环境检查

`pnpm typecheck`（含工作区构建）、`pnpm check:client` 与 `pnpm check:dsh` 已通过，DSH 依赖基线核对覆盖 320 个包。

`pnpm test:repo` 为 103 项通过、9 项失败。失败均来自未改动的 `tests/DSH组合安全钉.test.js`，停在“当前 profile 尚未接入 Teloa 插件，请先运行 pnpm setup:dsh”的前置检查，未进入界面行为验证。本轮没有为此修改宿主运行配置或启动服务。

客户端回归中，访客宿主测试原先比较字号令牌字面值 `14px`，已调整为比较真实计算字号 `14px`，让 rem 实现保留相同默认尺寸并支持浏览器字体设置。

任务键盘集成用例改为从语义表格中的真实按钮进入，不再查询已移除的 `option`；方向键选择、菜单 Escape 和原详情返回的行为断言保持。

### 最终结果

| 检查 | 结果 |
| --- | --- |
| 完整客户端回归（`test:bindings` 同一文件集合，限制并发为 3） | 初跑 5301 项：5298 通过、2 条旧断言失败、1 项可选 axe 跳过。上述两条断言调整后，所在两个浏览器文件的 7 项复测全部通过。 |
| 最终专项验收（设计、颜色对比、任务表格、访客宿主） | 22 项通过，包含本地 axe，无跳过。 |
| 折叠区内原生日期约束补验 | 1 项通过，无效日期会展开并聚焦，不写入项目。 |
| 创建/编辑关闭与草稿、项目草稿等针对性回归 | 46 项通过，覆盖提交中保护、版本冲突与失败保留。 |
| 响应式 | 48 种表单入口布局组合 + 16 种员工创建步骤组合无横向溢出。 |
| axe | 明暗主题下目录和三类表单 8 个场景，0 项违规。 |
| 最终客户端打包、构建边界检查、客户端 TypeScript 检查 | 全部通过。 |
| 全仓环境检查 | `test:repo` 的 9 项 DSH profile 前置失败保留，详上文；其余 103 项通过。 |
