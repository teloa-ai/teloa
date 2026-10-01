import {createHash} from 'node:crypto'
import {WorkError} from './work-error.ts'
import {isRecord} from './resources.ts'

/**
 * `sourceNoun` 是这门业务自己的来源说法（SOC 的「告警源」、AppSec 的「代码仓库」）：
 * 界面把「接入数据源」换成「接入告警源」，缺省时回落通用名词，旧模板不带这一位仍然合法。
 */
export type IndustryDataSourceDefinition={format:'teloa.data-source/v1';sourceId:string;scopes:string[];sourceNoun?:string}
export type IndustryMcpConnectionDefinition={format:'teloa.mcp-connection/v1';serverName:string;tools:string[]}
export type IndustryPluginDefinition={format:'teloa.plugin/v1';registry:'npm';packageName:string;version:string}

const bad=(message:string)=>new WorkError('teloa/invalid-input',message)
const exact=(value:unknown,keys:readonly string[],message:string):Record<string,unknown>=>{if(!isRecord(value)||Object.keys(value).length!==keys.length||keys.some(key=>!(key in value)))throw bad(message);return value}
const sourceId=/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,119}$/
/** 服务名不得含 `__`：公开名以 `mcp__<server>__` 分段，含 `__` 的服务名能对上别的服务器命名空间里原始名含 `__` 的工具。 */
const serverName=/^(?!.*__)[A-Za-z0-9_-]{1,32}$/
/** MCP 原始工具名：允许点号分段（飞书官方 MCP 形如 `im.v1.message.list`），但不能以点开头、结尾或连续两点。 */
const toolName=/^(?!.*\.\.)[A-Za-z0-9_-][A-Za-z0-9_.-]{0,62}[A-Za-z0-9_-]$|^[A-Za-z0-9_-]$/
const npmName=/^(?:@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/
const exactSemver=/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/
const list=(value:unknown,pattern:RegExp,max:number,message:string):string[]=>{
 if(!Array.isArray(value)||!value.length||value.length>max||value.some(item=>typeof item!=='string'||!pattern.test(item))||new Set(value).size!==value.length)throw bad(message)
 return [...value] as string[]
}

/**
 * 来源名词判据：1–12 字的单行纯文本。上限是文案位宽（「+ 接入{名词}」要放得进一个按钮）；
 * 禁全部 C0 控制符与 DEL（含 `\t`/`\r`/`\n`），理由与 `business-definitions.ts` 的声明文本同一条——
 * 这一位会同时进界面文本与模型上下文，允许换行等于允许在那里另起一段。
 */
const sourceNoun=(value:unknown):value is string=>typeof value==='string'&&!!value.trim()&&value===value.trim()&&value.length<=12&&!/[\x00-\x1f\x7f]/.test(value)

/** 数据源定义只声明宿主端口身份与业务范围，不含地址或凭据；`sourceNoun` 可缺省，缺省即由界面回落通用名词。 */
export function readIndustryDataSourceDefinition(value:unknown):IndustryDataSourceDefinition{
 const hasNoun=isRecord(value)&&value.sourceNoun!==undefined
 const row=exact(value,['format','sourceId','scopes',...(hasNoun?['sourceNoun']:[])],'行业数据源定义格式不正确。')
 if(row.format!=='teloa.data-source/v1'||typeof row.sourceId!=='string'||!sourceId.test(row.sourceId))throw bad('行业数据源定义格式不正确。')
 const scopes=list(row.scopes,/^(?!general$)[^\x00-\x1f\x7f]{1,120}$/,16,'行业数据源范围必须是非空去重且不含 general 的范围标识。')
 if(hasNoun&&!sourceNoun(row.sourceNoun))throw bad('行业数据源来源名词必须是不超过 12 字、不含控制字符的单行文本。')
 return {format:'teloa.data-source/v1',sourceId:row.sourceId,scopes,...(hasNoun?{sourceNoun:row.sourceNoun as string}:{})}
}

export function readIndustryMcpConnectionDefinition(value:unknown):IndustryMcpConnectionDefinition{
 const row=exact(value,['format','serverName','tools'],'行业 MCP 连接定义格式不正确。')
 if(row.format!=='teloa.mcp-connection/v1'||typeof row.serverName!=='string'||!serverName.test(row.serverName))throw bad('行业 MCP 连接定义格式不正确。')
 return {format:'teloa.mcp-connection/v1',serverName:row.serverName,tools:list(row.tools,toolName,64,'行业 MCP 连接工具名必须非空、去重且只含字母数字下划线连字符与点号。')}
}

export function readIndustryPluginDefinition(value:unknown):IndustryPluginDefinition{
 const row=exact(value,['format','registry','packageName','version'],'行业扩展定义格式不正确。')
 if(row.format!=='teloa.plugin/v1'||row.registry!=='npm'||typeof row.packageName!=='string'||row.packageName.length>214||!npmName.test(row.packageName)||typeof row.version!=='string'||row.version.length>80||!exactSemver.test(row.version))throw bad('行业扩展定义必须是 npm 包名与精确版本。')
 return {format:'teloa.plugin/v1',registry:'npm',packageName:row.packageName,version:row.version}
}

/**
 * 与 DSH `@deepseek-ai/dsh-mcp-client` 的公开工具名规则逐字一致（实现在 lib/index.js `publicToolName`，类型在 lib/types/tools.d.ts）：
 * `mcp__<server>__<raw>` 只含 `[A-Za-z0-9_-]` 且 ≤64 字时原样使用；否则把越界字符换成 `_`、
 * 截到 51 字并追加 `sha256(server + "\0" + raw)` 前 12 位，保证不同身份不会折叠成同一公开名。
 * 就绪核验、冻结绑定与执行面授权都拿这个名字去对宿主注册表，因此这里不能只做简单拼接。
 */
export const mcpToolFullName=(server:string,tool:string)=>{
 const joined='mcp__'+server+'__'+tool,normalized=joined.replace(/[^A-Za-z0-9_-]/g,'_')
 if(normalized===joined&&normalized.length<=64)return normalized
 return normalized.slice(0,64-12-1)+'_'+createHash('sha256').update(server+'\0'+tool).digest('hex').slice(0,12)
}
