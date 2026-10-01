import type {AgentPresetRegistry} from '@deepseek-ai/dsh-agent-preset-registry'

/** 目录读取持有原生预设租约，避免配置更新时作用域提前释放，也不泄漏旧预设实例。 */
export async function withPresetReadScope<T>(registry:Pick<AgentPresetRegistry,'acquireScope'>,read:(scope:Awaited<ReturnType<AgentPresetRegistry['acquireScope']>>['key'])=>Promise<T>):Promise<T>{
 const lease=await registry.acquireScope()
 try{return await read(lease.key)}finally{await lease[Symbol.asyncDispose]()}
}
