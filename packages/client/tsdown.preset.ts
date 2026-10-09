// Teloa 社区版客户端构建预设；输出遵循 DSH 模块加载协议。
import { readFile } from 'node:fs/promises'
import { basename, dirname, resolve as resolvePath } from 'node:path'
import { transform } from 'lightningcss'
import type { TsdownPlugin, UserConfig } from 'tsdown'

/** DSH 模块加载器在运行时提供这些共享模块，构建时保持外部引用，避免重复 React 和状态实例。 */
const PLATFORM_MODULES = [
  'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
]

const isRequested = (specifier: string): boolean => PLATFORM_MODULES.includes(specifier)

/**
 * `__ModuleLoader__.load` 只会 `readFileSync` 单个 `client.js`，没有 `<link>`/
 * CSS chunk 的投递路径——tsdown 内建的 CSS 处理（无论是 `@tsdown/css` 接管还是
 * 退化到 css-guard 报错）都会把 `.module.css` 当独立资源 emit 成 `style.css`，
 * 这条路径在这个交付模型下走不通（已实测：产物齐全但样式运行时不生效）。
 * 照抄 vendor/deepseek-harness/packages/client/tsdown.client.ts 的
 * `dsh-css-modules-inline` 插件（只搬与内联注入相关的部分，purity gate 等与
 * 本仓库无关的逻辑不搬）：用虚拟 id（后缀不是 `.css`）绕开 tsdown 内建 CSS 链，
 * 用 lightningcss 生成哈希类名 + 压缩后的 CSS 文本，模块执行时用
 * `document.createElement('style')` 注入，与 vendor 产物的运行时形态
 * （哈希类名 + 内联字符串 + `<style>` 标签）保持一致。
 */
const CSS_VIRTUAL_PREFIX = '\0dsh-css:'
const CSS_VIRTUAL_SUFFIX = '.mjs'

function styleInjectionModule(
  id: string,
  fileId: string,
  css: string,
  classMap: Readonly<Record<string, string>>,
  registrationModule?: string,
): string {
  // 独立工作台在 mount 时由宿主传入 CSP nonce；模块求值只登记样式，不写文档。
  if (registrationModule) return [
    `import {registerGuestStyle} from ${JSON.stringify(registrationModule)};`,
    `registerGuestStyle(${JSON.stringify(`${id}/${basename(fileId)}`)}, ${JSON.stringify(css)});`,
    `export default ${JSON.stringify(classMap)};`,
  ].join('\n')
  const source = [
    `const css = ${JSON.stringify(css)};`,
    `const tagId = ${JSON.stringify(`${id}/${basename(fileId)}`)};`,
    'if (typeof document !== \'undefined\' && document.querySelector(\'style[data-plugin-css=\' + JSON.stringify(tagId) + \']\') === null) {',
    '  const tag = document.createElement(\'style\');',
    `  tag.dataset.plugin = ${JSON.stringify(id)};`,
    '  tag.dataset.pluginCss = tagId;',
    '  tag.textContent = css;',
    '  document.head.appendChild(tag);',
    '}',
  ]
  source.push(`export default ${JSON.stringify(classMap)};`)
  return source.join('\n')
}

function cssModulesInlinePlugin(id: string, registrationModule?: string): TsdownPlugin {
  return {
    name: 'teloa-css-modules-inline',
    // 只解析 emitted 路径，不像 vendor 版 sourceAssetPath() 那样在缺失时反查
    // lib/types 前缀映射回 src：client entry 固定指向各包 src/client 下的源码，
    // importer 永远不会落在 lib/types 下。这条前提只在 entry 固定时成立——
    // 未来若引入 host/client 两阶段构建（entry 改指向编译产物），这里要补回反查分支。
    resolveId(source: string, importer: string | undefined) {
      if (/\.(svg|jpe?g|webp)$/i.test(source)) return '\0teloa-image:' + resolvePath(dirname(importer || ''), source)
      if (!source.endsWith('.module.css')) return null
      const abs = importer !== undefined ? resolvePath(dirname(importer), source) : source
      return CSS_VIRTUAL_PREFIX + abs + CSS_VIRTUAL_SUFFIX
    },
    async load(virtualId: string) {
      if (virtualId.startsWith('\0teloa-image:')) {
        const fileId = virtualId.slice('\0teloa-image:'.length)
        const asset = await readFile(fileId)
        const mimeType = fileId.endsWith('.svg') ? 'image/svg+xml' : fileId.endsWith('.webp') ? 'image/webp' : 'image/jpeg'
        return 'export default ' + JSON.stringify(`data:${mimeType};base64,${asset.toString('base64')}`)
      }
      if (!virtualId.startsWith(CSS_VIRTUAL_PREFIX)) return null
      const fileId = virtualId.slice(CSS_VIRTUAL_PREFIX.length, -CSS_VIRTUAL_SUFFIX.length)
      this.addWatchFile(fileId)
      const source = await readFile(fileId)
      const { code, exports: cssExports } = transform({
        filename: fileId,
        code: source,
        cssModules: { pattern: '[hash]_[local]' },
        minify: true,
      })
      const classMap: Record<string, string> = {}
      for (const [local, exp] of Object.entries(cssExports ?? {})) classMap[local] = exp.name
      return styleInjectionModule(id, fileId, code.toString(), classMap, registrationModule)
    },
  }
}

/** 无 DSH 宿主的公共呈现入口：React、CSS 和品牌图全部放进单个浏览器 ESM。 */
export function standaloneClientBundle(packageId: string, entry: string, styleRuntime: string): UserConfig {
  return {
    entry: {guest: entry}, outDir: 'lib', format: 'esm', platform: 'browser', target: 'es2024',
    dts: false, clean: false, minify: true,
    define: {'process.env.NODE_ENV': JSON.stringify('production')},
    deps: {neverBundle: () => false, alwaysBundle: () => true},
    plugins: [cssModulesInlinePlugin(`${packageId}/guest`, resolvePath(styleRuntime))],
    inputOptions: {resolve: {mainFields: ['module', 'browser', 'main']}},
    outputOptions: {entryFileNames: 'guest.js', codeSplitting: false},
  }
}

/**
 * @param packageId - 必须与 package.json 的 `name` 一致——`__ModuleLoader__`
 *                    按这个 id 索引已加载的插件。
 * @param clientEntry - client 入口源码路径，各包不同（.ts 或 .tsx）。
 */
export function clientBundle(packageId: string, clientEntry: string): UserConfig[] {
  const lib: UserConfig = {
    entry: ['lib/types/index.js'],
    outDir: 'lib',
    format: 'esm',
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    dts: false,
    clean: false,
  }

  const client: UserConfig = {
    entry: { client: clientEntry },
    outDir: 'lib',
    format: 'cjs',
    platform: 'browser',
    target: 'es2024',
    dts: false,
    clean: false,
    sourcemap: true,
    // 两个字段都要写，不能只写一个：只写 neverBundle 或只写 alwaysBundle 会让
    // tsdown 掉回它自己的 getProductionDeps 推导，某个依赖换个 npm 分类就被
    // 静默重新打包。
    deps: {
      neverBundle: isRequested,
      alwaysBundle: (specifier: string) => !isRequested(specifier),
    },
    plugins: [cssModulesInlinePlugin(packageId)],
    /*
     * 优先走依赖的 ESM 入口。
     *
     * 没有 `exports` 字段的老式包（lucide-react 就是）默认会被解析到 CJS 的
     * `main`，而 CJS 里没有 ESM 的静态导入图，rolldown 摇不掉没用到的部分——
     * lucide-react 全量 1808 个图标会整个进产物（实测 client.js 788 kB，
     * 指定 module 入口后 77 kB）。这类包不报错、只是产物悄悄胖十倍，
     * 所以把偏好写死在这里，而不是让每个包各自去 import 深路径绕开。
     */
    inputOptions: {
      resolve: { mainFields: ['module', 'browser', 'main'] },
    },
    outputOptions: {
      entryFileNames: 'client.js',
      banner: `window.__ModuleLoader__.load({\n\tid: ${JSON.stringify(packageId)},\n\tfactory: (require) => {`,
      footer: 'return module.exports; } });',
      intro: 'var module = { exports: {} }; var exports = module.exports;',
    },
  }

  return [lib, client]
}

/**
 * 同包按需分块（`lib/client.<name>.js`）：客户端源码写 `require.async('./client.<name>.js')`，
 * 宿主模块系统（`@deepseek-ai/dsh-client-modules`）按 `/plugins/<包名>/client.<name>.js?rev=` 取回，
 * 文件名须匹配 `^client\.[A-Za-z0-9][A-Za-z0-9._-]*\.js$`，且分块必须自包含（不得同步 `require` 另一个 `client*.js`）。
 *
 * 为什么是独立一趟构建而不是 rolldown 自己拆的 `import()` 分块：rolldown 拆分时会把运行时帮助函数与共享模块
 * 抽成第三个 chunk（实测 `client.rolldown-runtime.js`），分块再同步 `require` 它，违反自包含；独立构建时
 * 帮助函数各自内联，分块与入口零共享。包装形状核对自 vendor 产物
 * `dsh-client-ui-sidebar-documentpreview/lib/client.excel.js`：`window.__ModuleLoader__.load({ id, chunk, factory })`。
 * 分块里的平台模块（React 等）仍按 PLATFORM_MODULES 外置，由同一个 `require` 从模块表取。
 */
export function clientChunk(packageId: string, name: string, entry: string): UserConfig {
  const fileName = `client.${name}.js`
  if (!/^client\.[A-Za-z0-9][A-Za-z0-9._-]*\.js$/.test(fileName)) throw new Error(`客户端分块名不合法：${fileName}`)
  return {
    entry: { [`client.${name}`]: entry },
    outDir: 'lib',
    format: 'cjs',
    platform: 'browser',
    target: 'es2024',
    dts: false,
    clean: false,
    sourcemap: true,
    deps: {
      neverBundle: isRequested,
      alwaysBundle: (specifier: string) => !isRequested(specifier),
    },
    plugins: [cssModulesInlinePlugin(packageId)],
    inputOptions: {
      resolve: { mainFields: ['module', 'browser', 'main'] },
    },
    outputOptions: {
      entryFileNames: fileName,
      chunkFileNames: `client.${name}.[name].js`,
      banner: `window.__ModuleLoader__.load({\n\tid: ${JSON.stringify(packageId)},\n\tchunk: ${JSON.stringify(fileName)},\n\tfactory: (require) => {`,
      footer: 'return module.exports; } });',
      intro: 'var module = { exports: {} }; var exports = module.exports;',
    },
  }
}
