/**
 * 看板图表库分块（`lib/client.chart.js`）：只在第一次画图表时由宿主模块系统按需取回，不进首屏的 `client.js`。
 * 这里只转出渲染器要的四个入口；分块自包含、不同步引用 `client.js`（`tsdown.preset.ts` 的 `clientChunk`）。
 * 表达式一律走 vega-interpreter 的 AST 解释，不经 `Function`/`eval`（Spike B 结论 §1）。
 */
export {compile} from 'vega-lite'
export {parse,View} from 'vega'
export {expressionInterpreter} from 'vega-interpreter'
