import {WorkError} from '@teloa/contract'
import type {OllamaClient} from './ollama-client.ts'

/** 原生空聊天加载后读取实际分配；仅有模型标称上限或旧版本缺字段时拒绝猜测。 */
export async function prepareOllamaContext(client:Pick<OllamaClient,'load'|'ps'>,name:string,digest:string,signal:AbortSignal):Promise<number>{
 signal.throwIfAborted()
 await client.load(name,signal)
 signal.throwIfAborted()
 return inspectOllamaContext(client,name,digest,signal)
}

/** 发送前只读复核，防止加载后被其他客户端卸载或替换。 */
export async function inspectOllamaContext(client:Pick<OllamaClient,'ps'>,name:string,digest:string,signal:AbortSignal):Promise<number>{
 const running=(await client.ps(signal)).find(row=>row.name===name)
 signal.throwIfAborted()
 if(!running)throw new WorkError('teloa/source-unavailable','模型尚未加载，请刷新后重新准备。')
 if(running.digest!==digest)throw new WorkError('teloa/version-conflict','模型版本已变化，请刷新后重新准备。')
 // 终审 Minor 1：容量未报告是运行时版本问题，不是模型服务故障；用 source-invalid 与「暂不可核实」区分，不进入远程兜底。
 if(running.contextLength===null)throw new WorkError('teloa/source-invalid','Ollama 未报告实际上下文容量，请升级 Ollama 后重试。')
 return running.contextLength
}

/** 标称上限只能收紧预算，不能放大运行分配；默认输出最多占一半，为输入保留容量。 */
export function ollamaContextBudget(allocated:number,maximum:number|null,maxTokens:number):{contextWindow:number;maxTokens:number}{
 const contextWindow=maximum===null?allocated:Math.min(allocated,maximum)
 return {contextWindow,maxTokens:Math.min(maxTokens,Math.max(1,Math.floor(contextWindow/2)))}
}
