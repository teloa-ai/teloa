import {WorkError} from '@teloa/contract'
import type {OllamaShow} from './ollama-client.ts'

const levels=['minimal','low','medium','high','xhigh','max'] as const
export type OllamaReasoningEfforts=Partial<Record<typeof levels[number]|'off',string>>

/** Ollama /api/show 的 thinking 元数据 → DSH 0.1.7-rc.1 公开 reasoningEfforts。
 * 不自己解析正文中的 <think>；由官方兼容接口分离 reasoning，再交给原生消息渲染。
 * 布尔开启仅映射为原生 high 别名，不虚构多个思考档位；不支持关闭的模型不提供 off。
 */
export function ollamaReasoning(shown:OllamaShow):{reasoningEfforts?:OllamaReasoningEfforts|false}{
 if(!shown.capabilities?.includes('thinking'))return {}
 const thinking=shown.thinking
 if(!thinking)throw new WorkError('teloa/source-unavailable','当前 Ollama 未提供可核验的思考模式。请更新 Ollama 后重试接入；已验收版本为 0.34.4。')
 const values=thinking.values,efforts:OllamaReasoningEfforts={}
 for(const level of levels)if(values.includes(level))efforts[level]=level
 if(!Object.keys(efforts).length&&values.includes(true)&&!values.some(value=>typeof value==='string'))efforts.high='high'
 if(!Object.keys(efforts).length){
  if(values.length===1&&values[0]===false)return {reasoningEfforts:false}
  throw new WorkError('teloa/source-invalid','该模型的思考模式暂不能映射到原生模型选择器，请选择其他模型。')
 }
 if(values.includes(false))efforts.off='none'
 return {reasoningEfforts:efforts}
}
