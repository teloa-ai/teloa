import type {Context} from '@deepseek-ai/cordis'
import type {LlmCallConfig} from '@deepseek-ai/dsh-llm'

/** 显式档位优先；后台任务与群路由沿用同一推理默认值，不改提供商或模型。 */
export async function withDefaultModelEffort(llm:Context['llm'],config:LlmCallConfig,signal:AbortSignal):Promise<LlmCallConfig>{
 if(config.reasoningEffort!==undefined)return config
 const info=await llm.resolveModelInfo(config.provider,config.model,signal)
 signal.throwIfAborted()
 const high=info.reasoning?.efforts.find(effort=>effort.id==='high')
 return high?{...config,reasoningEffort:high.id}:config
}
