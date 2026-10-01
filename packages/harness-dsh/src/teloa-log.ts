import type {Context,Exporter,Message} from '@deepseek-ai/cordis'
import {Logger} from '@deepseek-ai/cordis'
import {appendFile,rename,stat} from 'node:fs/promises'

/** 单文件轮转阈值：超过就把当前文件转存为 `.1` 再新开，只留一份旧的。 */
const maxLogBytes=5*1024*1024

/**
 * 本插件裸调用 `ctx.logger.warn/info(...)`（未经 `ctx.logger('name')` 另起子 logger）时，
 * cordis 用 `hyphenate(fiber.name)` 取 `message.name`；fiber 名字来自 `index.ts` 导出的
 * `export const name='teloa-harness-dsh'`（`registry.ts:324` `let name=plugin.name`），
 * 已是 kebab-case，`hyphenate` 后不变——核对过仓库里现有的 warn/info 调用点，全部是这条裸调用，
 * 没有任何地方另起过子 logger 名字，故此值恒定。
 */
const pluginLoggerName='teloa-harness-dsh'

/**
 * 把宿主插件自身的可运维日志落盘为一行一条 JSON，解决 `ctx.logger.info/warn` 在 3100 宿主
 * stdout 上一条都没有落点的问题（DSH 默认不导出插件 logger）。
 *
 * `levels` 必须显式给，否则 cordis 默认导出器按 `LoggerLevel.INFO`(1) 比：`@deepseek-ai/cordis`
 * 的 `LoggerLevel` 枚举是 `ERROR=0,INFO=1,WARN=2,DEBUG=3`，比较用的是"目标口径数值 >= 消息数值即放行"，
 * 所以未配置时的隐式口径（1）比 `warn` 的 2 还小，warn 反而被整条跳过
 * （`logger.ts:153`，T15 修复轮已踩过；`群内直接回应真实链路.test.ts` 的探针也是因此才显式配置）。
 *
 * 这里把 `default` 定在 2：数值上会连带放行同口径下的 `info`（0/1/2 都 <=2，只有 `debug`=3 被挡在外面）。
 * 但这个文件是**本插件自己的**可运维日志，不是宿主的总日志：其他插件的行落进来既会把文件灌满，
 * 也会让「这一行是谁写的」不再一眼可判。于是在 `export` 里再按 `message.name` 补一道过滤——
 * **任何级别**（error/warn/info）只要不是本插件的都直接丢弃。
 *
 * 不写 token、不写模型正文、不写群消息正文：只对现有 `ctx.logger.warn/info` 调用点已经在传的
 * `args` 做原样透传格式化（复用 `Logger.format`，与 warn/info 自身的既有克制口径一致）。
 */
export function registerTeloaLogFile(ctx:Context,file:string):void{
 let writing=Promise.resolve()
 const exporter:Exporter={
  levels:{default:2},
  export:message=>{
   // `levels` 管的是「哪些级别到得了这里」，这一行管的是「哪个插件的行留下来」：只落本插件，级别不分。
   if(message.name!==pluginLoggerName)return
   const line=JSON.stringify({at:new Date(message.ts).toISOString(),level:message.type,name:message.name,text:Logger.format(exporter,message)})+'\n'
   // 单个导出器内串行化，避免并发 appendFile 交错写坏行；写失败静默——日志不能反过来拖垮宿主。
   writing=writing.then(()=>rotateIfNeeded(file)).then(()=>appendFile(file,line)).catch(()=>{})
  },
 }
 ctx.logger.exporter(exporter)
}

async function rotateIfNeeded(file:string):Promise<void>{
 try{
  const info=await stat(file)
  if(info.size>=maxLogBytes)await rename(file,file+'.1')
 }catch{
  // 文件尚不存在等同"从头写"，不是需要处理的错误。
 }
}
