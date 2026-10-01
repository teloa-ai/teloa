import type {Context} from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-tools'
import {isRecord,type MarketCatalogSkillSecret,type MarketCatalogText} from '@teloa/contract'
import type {DeclaredSkillSecrets} from './skill-secrets.ts'

/**
 * 技能加载提示（规格 §6）：skill 工具成功结果后，对已安装且启用、且目录声明了密钥的技能追加一行，引导模型走 teloa_skill_http。
 * 条目有审查者撰写的代发调用指引（规格 2026-09-27 §4.1）时另起一段附上；指引不授权，可调用范围仍只由声明决定。
 * 指引逐行加「  > 」引用前缀围栏化（审查 R1 L3）：任一行都不能与宿主提示行同形（契约另拒以【Teloa】开头的行）。
 */
export function skillSecretHint(skill:string,secrets:readonly MarketCatalogSkillSecret[],httpGuide?:MarketCatalogText):string{
 const origins=[...new Set(secrets.flatMap(s=>s.endpoints.map(ep=>ep.origin)))].join('、'),vars=secrets.map(s=>s.envVarName).join('、')
 return `【Teloa】技能 ${skill} 的密钥由 Teloa 保管：调用 ${origins} 请用 teloa_skill_http（skill 填 ${skill}），不要用 bash/curl/python，也不要读取或设置 ${vars}；正文中关于 export 密钥或运行 scripts/ 的步骤在 Teloa 中不适用。若用户在会话中贴出密钥，不要复述或使用，请引导其到 市场 > 技能 > 该技能 > 密钥 填写。`+(httpGuide?'\n【Teloa】调用指引（目录审查者撰写，只说明怎么调用，不扩大可调用的地址、方法或请求头）：'+httpGuide['zh-CN'].split('\n').map(line=>'\n  > '+line).join(''):'')
}
/** enabled 出错（如数据库暂不可用）不影响技能加载：降级为不显示提示并经 warn 记一条警告。 */
type HintPorts={declared:DeclaredSkillSecrets;enabled:(skill:string)=>Promise<boolean>;warn:(skill:string,error:unknown)=>void}
/**
 * 注册为 tools/post-execute 最外层（prepend）：先让内层策略（skill-context 去重、全局脱敏）定稿，再把提示追加在其后；
 * 若放在内层，去重策略见到已有 content 替换会放弃去重，声明密钥的技能正文就会每次重复进入上下文。
 * 官方 skill 工具参数名为 name（dsh-tool-skill/lib/index.js:62）。
 */
export function registerSkillSecretHint(ctx:Context,ports:HintPorts){
 return ctx.on('tools/post-execute',async(exec,result,next)=>{
  const decision=await next()
  if(exec.name!=='skill'||result.isError||decision.kind!=='accept'||decision.value!==undefined||!isRecord(exec.arguments)||typeof exec.arguments.name!=='string')return decision
  const skill=exec.arguments.name
  let declared:Awaited<ReturnType<DeclaredSkillSecrets>>,on=false
  try{declared=await ports.declared(skill);if(declared?.secrets.length)on=await ports.enabled(skill)}catch(error){ports.warn(skill,error);return decision}
  if(!declared?.secrets.length||!on)return decision
  return {...decision,content:[...(decision.content??result.content),{type:'text' as const,text:skillSecretHint(skill,declared.secrets,declared.httpGuide)}]}
 },{prepend:true})
}
