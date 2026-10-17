export type HarnessEngine='dsh'|'codex'|'claude-code'
export type HarnessDirective=Readonly<{mode:'auto'|'specified'|'ambiguous';engines:readonly HarnessEngine[];excluded:readonly HarnessEngine[]}>
const labels:Readonly<Record<HarnessEngine,string>>={dsh:'DSH',codex:'Codex','claude-code':'Claude Agent'}
const alias=String.raw`(?:codex|claude(?:[\s-]*(?:agent|code))?|dsh)(?![a-z0-9_-])`
const prefix=String.raw`(?:(?:请|麻烦|帮我|这次|本次|这个任务|这项任务|接下来|please|for this task)\s*)*`
const command=new RegExp('^'+prefix+String.raw`(不要|别|不用|禁止|避免|do not|don't|never)?\s*(使用|改用|切换到|交给|指定(?:使用)?|让|用|use|assign)?\s*(`+alias+')','i')
const automatic=new RegExp('^'+prefix+String.raw`(?:自动(?:选择|挑选|分配)(?:合适(?:的)?)?(?:执行)?引擎|让系统自动选择(?:引擎)?|你(?:来)?(?:自动)?选择(?:合适(?:的)?)?引擎|automatically (?:choose|select)(?: an?)? engine|auto(?:matic)?(?: engine)? selection)(?:\s|$|[：:])`,'i')
const engine=(value:string):HarnessEngine=>/^codex$/i.test(value)?'codex':/^dsh$/i.test(value)?'dsh':'claude-code'
function withoutFences(text:string):string{
 let fence:string|undefined
 return text.split('\n').map(line=>{
  const marker=/^\s*(`{3,}|~{3,})/.exec(line)?.[1]
  if(fence){if(marker&&marker[0]===fence[0]&&marker.length>=fence.length)fence=undefined;return ''}
  if(marker){fence=marker;return ''}
  return line
 }).join('\n')
}
function withoutBlockquotes(text:string):string{
 let quoted=false
 const blockStart=/^ {0,3}(?:#{1,6}(?:\s|$)|(?:[-*+]|\d+[.)])\s|(?:[-*_]\s*){3,}$|<)/
 return text.split('\n').map(line=>{
  if(/^ {0,3}>/.test(line)){quoted=true;return ''}
  if(!line.trim()||blockStart.test(line))quoted=false
  return quoted?'':line
 }).join('\n')
}

/** 只提取清晰的直接指令；复杂语义仍由主控处理，不从提及、引用或代码授予选择。 */
export function parseHarnessDirective(text:string):HarnessDirective{
 const plain=withoutBlockquotes(withoutFences(text.normalize('NFKC'))
  .replace(/<\s*(pre|code|blockquote|q)\b[^>]*>[\s\S]*?(?:<\/\s*\1\s*>|$)/gi,''))
  .replace(/^(?: {4}|\t)[^\n]*$/gm,'')
  .replace(/(?<!`)(`+)(?!`)[\s\S]*?(?<!`)\1(?!`)/g,'')
  .replace(new RegExp('[“「『"\']\\s*('+alias+')[\\s]*[”」』"\']','gi'),'$1')
  .replace(/[“「『][\s\S]*?[”」』]|"[^"\n]*"|(?<![a-z0-9])'[^'\n]*'(?![a-z0-9])/gi,'')
 let selected=new Set<HarnessEngine>()
 let ambiguous=false
 const excluded=new Set<HarnessEngine>()
 for(const part of plain.split(/[，,。！？!?；;\n]+/)){
  const clause=part.trim();if(!clause||/[吗么呢]$/.test(clause))continue
  if(automatic.test(clause)){selected.clear();ambiguous=false;continue}
  const match=command.exec(clause)
  if(!match||!match[1]&&!match[2])continue
  const names=[engine(match[3]!)];let rest=clause.slice(match[0].length)
  if(/^\s*(?:还是|或者?|or\b)/i.test(rest)){ambiguous=true;continue}
  const joined=new RegExp('^'+String.raw`\s*(?:和|与|及|、|and\b|&|\+)\s*(`+alias+')','i')
  let next:RegExpExecArray|null
  while((next=joined.exec(rest))){names.push(engine(next[1]!));rest=rest.slice(next[0].length)}
  if(match[1])for(const name of names)excluded.add(name)
  else{if(match[2]==='改用'||match[2]==='切换到'){selected=new Set();ambiguous=false}for(const name of names)selected.add(name)}
 }
 return Object.freeze({mode:ambiguous||[...selected].some(name=>excluded.has(name))?'ambiguous':selected.size?'specified':'auto',engines:Object.freeze([...selected]),excluded:Object.freeze([...excluded])})
}

/** 选择只缩小候选，不产生执行或工具权限；不可用与审批仍由原准入核验。 */
export function harnessDirectiveDenial(directive:HarnessDirective,provider:HarnessEngine):string|undefined{
 if(directive.mode==='ambiguous')return '本次引擎选择存在冲突，请先向用户澄清；未启动外部引擎。'
 if(directive.excluded.includes(provider))return '用户明确要求本次不使用 '+labels[provider]+'；未启动该引擎，请遵循原指令。'
 if(directive.mode==='specified'&&!directive.engines.includes(provider))return '用户已指定本次使用 '+directive.engines.map(name=>labels[name]).join('、')+'；不能静默改派 '+labels[provider]+'。指定引擎不可用时说明原因，未启动其他引擎。'
}
