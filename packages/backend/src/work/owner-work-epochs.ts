import {WorkError} from '@teloa/contract'
const epochs=new Map<string,number>()
const key=(owner:string,requestId:string)=>JSON.stringify([owner,requestId])
/** 持久停止写入持有行锁时撤销本宿主在途许可；下次准入仍重新读取持久原请求。 */
export function revokeOwnerWorkLeases(owner:string,requestId:string):void{const id=key(owner,requestId);epochs.set(id,(epochs.get(id)??0)+1)}
export function ownerWorkLease(owner:string,requestId:string){const id=key(owner,requestId),captured=epochs.get(id)??0;return {assertCurrent:()=>{if((epochs.get(id)??0)!==captured)throw new WorkError('teloa/forbidden','本人已停止原通用工作，不能继续执行。')}}}
