import type {Context} from '@deepseek-ai/cordis'
import type {SessionReferenceResolver} from '@deepseek-ai/dsh-session-reference'
import {isReservedExecutionSessionId,WorkError,type Conversation} from '@teloa/contract'

type Binding=Pick<Conversation,'ownerId'|'sessionId'|'requestedSessionId'|'status'|'purpose'|'title'>
type Ports={owner:string;bindings:()=>Promise<readonly Binding[]>}
type List=SessionReferenceResolver['listCandidates']

/** 仅装饰官方公开发现方法；不替换引用编码、快照读取、输入处理或文件来源。 */
export function installNativeSessionReferenceDirectory(ctx:Context,ports:Ports){
 return ctx.plugin({
  name:'teloa-native-session-reference-directory',inject:['sessionReferenceResolver','sessionQuery'],
  apply(child:Context){
   const resolver=child.sessionReferenceResolver,queryService=child.sessionQuery
   child.effect(()=>{
    let active=true
    const closed=()=>new WorkError('teloa/dependency-unavailable','原生引用目录已关闭，请重新尝试。')
    // 只读取公开方法的描述符，避免把 Cordis 的临时 scoped receiver 留到卸载后。
    const own=Object.getOwnPropertyDescriptor(resolver,'listCandidates')
    let target:object|null=resolver,descriptor=own
    while(!descriptor&&target){target=Object.getPrototypeOf(target) as object|null;if(target)descriptor=Object.getOwnPropertyDescriptor(target,'listCandidates')}
    if(typeof descriptor?.value!=='function')throw new WorkError('teloa/dependency-unavailable','原生会话引用目录接口不可用。')
    const original=descriptor.value as List
    const list:List=async function(this:SessionReferenceResolver,agent,query='',limit,signal){
     // 由原生校验保留错误类型与取消顺序，不把非法上限变成合法请求。
     if(signal?.aborted||limit!==undefined&&(!Number.isSafeInteger(limit)||limit<=0))return original.call(this,agent,query,limit,signal)
     if(!active)throw closed()
     try{
      // Remote 始终传入配置上限；直接调用缺省上限时，仅由公开方法推导当前限制。
      const cap=limit??(await original.call(this,agent,'',undefined,signal)).length
      const [candidates,bindings,records]=await Promise.all([
       original.call(this,agent,'',Number.MAX_SAFE_INTEGER,signal),ports.bindings(),queryService.listSessions(signal),
      ])
      if(signal?.aborted)return original.call(this,agent,query,limit,signal)
      if(!active)throw closed()
      const blocked=new Set(bindings.filter(row=>row.ownerId!==ports.owner||row.status!=='ready'||row.purpose==='task-run').flatMap(row=>[row.sessionId,row.requestedSessionId]))
      const visible=new Set(records.filter(row=>row.header.origin!=='subagent'&&!isReservedExecutionSessionId(row.header.id)&&!blocked.has(row.header.id)).map(row=>row.header.id))
      const names=new Map(bindings.filter(row=>row.ownerId===ports.owner&&row.status==='ready'&&row.purpose!=='task-run').map(row=>[row.sessionId,row.title.trim()]))
      const needle=query.toLocaleLowerCase()
      return candidates.filter(row=>visible.has(row.sessionId)).map(row=>{
       const name=names.get(row.sessionId)
       return name&&row.label===row.sessionId&&(!row.displayTitle||row.displayTitle===row.sessionId)?{...row,label:name,displayTitle:name}:row
      }).filter(row=>!needle||[row.sessionId,row.cwd,row.label,row.displayTitle].some(value=>value?.toLocaleLowerCase().includes(needle))).slice(0,cap)
     }catch(error){if(signal?.aborted)return original.call(this,agent,query,limit,signal);throw error}
    }
    resolver.listCandidates=list
    // Cordis 每次公开方法读取会生成 scoped receiver；用公开属性描述符核对实际持有者。
    return ()=>{active=false;if(Object.getOwnPropertyDescriptor(resolver,'listCandidates')?.value!==list)return;if(own)Object.defineProperty(resolver,'listCandidates',own);else Reflect.deleteProperty(resolver,'listCandidates')}
   },'Teloa 原生引用候选可见性')
  },
 })
}
