import {WorkError,readTaskRunMemorySelection} from '@teloa/contract'
import {isDeepStrictEqual} from 'node:util'
import {readRunRoleMemories,type RunRoleMemory} from './role-memory.ts'

/** 调用方先完成岗位与任务授权；选择只收窄既有读口，失效项不能悄悄丢弃。 */
export async function selectTaskRunMemory(selected:unknown,load:(ids?:readonly string[])=>Promise<unknown>):Promise<RunRoleMemory[]>{
 const ids=readTaskRunMemorySelection(selected)
 if(ids?.length===0)return []
 const memories=readRunRoleMemories(await load(ids))
 if(ids!==undefined&&JSON.stringify(memories.map(row=>row.id.toLowerCase()).sort())!==JSON.stringify(ids))throw new WorkError('teloa/forbidden','所选经验已失效或不在本次岗位和业务范围内，请重新核对。')
 return memories
}

/** 仅复核已经冻结的身份；新确认记忆不能被追加，撤回和改版不能发送旧正文。 */
export async function assertTaskRunMemoryCurrent(frozen:readonly RunRoleMemory[],load:(ids:readonly string[])=>Promise<unknown>):Promise<void>{
 if(!frozen.length)return
 const current=readRunRoleMemories(await load(frozen.map(item=>item.id))),byId=new Map(current.map(item=>[item.id,item]))
 if(current.length!==frozen.length||frozen.some(item=>!isDeepStrictEqual(item,byId.get(item.id))))throw new WorkError('teloa/version-conflict','原固定经验已撤回、改版或失去来源，不能发送旧输入。')
}
