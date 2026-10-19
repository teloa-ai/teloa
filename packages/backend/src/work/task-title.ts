/** 群任务标题上限：与 taskDefinition 的 title 上限（120 个 UTF-16 单元）一致。 */
export const groupTaskTitleLimit=120
const prefix='群任务：',fallback='群任务'
/** 标题、引用、列表等行首 Markdown 标记；只取首行时去掉它们，正文保持原样。 */
const lineMarkers=/^(?:(#{1,6})\s+|>\s*|[-*+]\s+|\d+[.)]\s+)+/
const ruleOrFence=/^(?:```|~~~|-{3,}|\*{3,}|_{3,})\s*$/
/** 返回消息里第一行有效文本：跳过空行、分隔线、围栏；去掉行首标记、ATX 尾部 # 与对称包裹的强调符号。 */
function firstEffectiveLine(text:string):string{
 for(const raw of text.split(/\r?\n/)){
  const trimmed=raw.trim()
  if(!trimmed||ruleOrFence.test(trimmed))continue
  const heading=lineMarkers.exec(trimmed)?.[1]
  let line=trimmed.replace(lineMarkers,'')
  if(heading)line=line.replace(/\s+#+\s*$/,'')
  line=line.replace(/^(\*\*|__|\*|_|`)(.+)\1/,'$2').replace(/\s+/g,' ').trim()
  if(line)return line
 }
 return ''
}
/**
 * 从群消息 Markdown 构造简短群任务标题：取第一段有效标题或首行，加统一前缀。
 * 只影响任务 title；完整消息与 goal 由调用方原样保存，不在这里截断。
 * 结果不超过 120 个 UTF-16 单元，截断时补省略号且不切断代理对。
 */
export function groupTaskTitle(text:string):string{
 const line=firstEffectiveLine(text)
 if(!line)return fallback
 const full=prefix+line
 if(full.length<=groupTaskTitleLimit)return full
 let end=groupTaskTitleLimit-1
 if(/[\uD800-\uDBFF]/.test(full[end-1]!))end--
 return full.slice(0,end)+'…'
}
