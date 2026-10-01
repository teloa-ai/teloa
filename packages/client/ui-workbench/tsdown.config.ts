import { readFileSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { clientBundle, clientChunk } from '../tsdown.preset.ts'

const manifest=JSON.parse(readFileSync(new URL('./package.json',import.meta.url),'utf8'))
const baseline=JSON.parse(readFileSync(new URL('../../../config/dsh-baseline.json',import.meta.url),'utf8'))
const configs=clientBundle('@teloa/client-ui-workbench', 'src/client/index.ts')
// 客户端作为内联工厂加载，没有模块文件 URL；ZIP 仅用原生流，禁止为 import.meta.url 注入 Node url 模块。
configs[1]!.define={'import.meta.url':'undefined',__TELOA_VERSION__:JSON.stringify(manifest.version),__DSH_VERSION__:JSON.stringify(baseline.tag.replace(/^dsh-v/,''))}
/**
 * 看板图表库分块：tsdown 对 cjs 产物固定按 node 平台解析，vega-canvas / vega-loader 的 `exports` 会落到 node 版
 * （前者带顶层 await，cjs 构建直接报错）；这两个包只在这里改指到各自的 browser 版，其余解析不动。
 */
const vegaRequire=createRequire(realpathSync(fileURLToPath(new URL('./node_modules/vega/package.json',import.meta.url))))
const browserBuild=(name:string)=>vegaRequire.resolve(name).replace(/\.node\.js$/,'.browser.js')
const chart=clientChunk('@teloa/client-ui-workbench','chart','src/client/business-chart-vega.ts')
chart.alias={'vega-canvas':browserBuild('vega-canvas'),'vega-loader':browserBuild('vega-loader')}
// 构建工具的默认出口不属于 Cordis 插件运行时。
export default [...configs,chart]
