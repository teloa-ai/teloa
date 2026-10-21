import {useEffect,useMemo,useRef,useState} from 'react'
import type {DigitalRole,Group,GroupMessage} from '@teloa/contract'
import type {TwinDraftApi} from './twin-drafts-api.js'
import type {RoleApi} from './role-api.js'
import type {GroupApi} from './group-api.js'
import {ContextDrawer} from './ContextDrawer.js'
import {GroupTwinDraftComposer} from './GroupTwinDraftComposer.js'
import {useI18n} from './i18n/provider.js'
import {localizeWorkError} from './i18n/errors.js'
import {twinDraftCopy} from './i18n/locales/twin-drafts.js'
import css from './GroupTwinDraftComposer.module.css'

export type GroupTwinDraftEntryProps={api:TwinDraftApi;roles:RoleApi;groups:GroupApi;group:Group;message:GroupMessage;close:()=>void;openWorkspace:(roleId:string,draftId:string)=>void}
type Load={origin:object;kind:'loading'}|{origin:object;kind:'ready';role:DigitalRole;text:string}|{origin:object;kind:'error';reason:'source'|'twin'|'service';error?:unknown}

/** 只读核对入口。正文仍由本人准备；来源与分身变化时不沿用旧请求的迟答。 */
export function GroupTwinDraftEntry({api,roles,groups,group,message,close,openWorkspace}:GroupTwinDraftEntryProps){
 const {locale}=useI18n(),copy=(key:Parameters<typeof twinDraftCopy>[1])=>twinDraftCopy(locale,key)
 const summary='fullText'in message?message.fullText:undefined
 const origin=useMemo(()=>({api,roles,groups,group,message}),[api,roles,groups,group.id,group.ownerId,group.version,group.name,message.id,message.groupId,message.text,summary?.chars,summary?.sha256])
 const current=useRef<object|undefined>(origin);current.current=origin
 const [load,setLoad]=useState<Load>({origin,kind:'loading'}),[attempt,setAttempt]=useState(0)
 useEffect(()=>{
  let active=true;setLoad({origin,kind:'loading'})
  const accept=(value:Load)=>{if(active&&current.current===origin)setLoad(value)}
  void(async()=>{
   if(group.ownerId!==api.ownerId||message.groupId!==group.id){accept({origin,kind:'error',reason:'source'});return}
   try{
    const [directory,body]=await Promise.all([roles.list(),summary?groups.messageBody(group.id,message.id,summary):Promise.resolve(undefined)])
    if(directory.some(role=>role.ownerId!==api.ownerId)){accept({origin,kind:'error',reason:'source'});return}
    const twins=directory.filter(role=>role.kind==='twin'&&role.state!=='retired')
    if(twins.length!==1){accept({origin,kind:'error',reason:'twin'});return}
    if(body&&(body.groupId!==group.id||body.messageId!==message.id)){accept({origin,kind:'error',reason:'source'});return}
    accept({origin,kind:'ready',role:twins[0]!,text:body?.text??message.text})
   }catch(error){accept({origin,kind:'error',reason:'service',error})}
  })()
  return()=>{active=false}
 },[origin,attempt])
 const dismiss=()=>{current.current=undefined;close()}
 if(load.origin===origin&&load.kind==='ready')return <GroupTwinDraftComposer api={api} role={load.role} group={group} message={{id:message.id,text:load.text}} close={dismiss} openWorkspace={openWorkspace}/>
 return <ContextDrawer title={copy('prepareReply')} close={dismiss} padded><div className={css.composer}>
  {load.origin!==origin||load.kind==='loading'?<p role="status">{copy('entryLoading')}</p>:load.kind==='error'&&<><p role="alert">{load.reason==='service'?localizeWorkError(locale,load.error):copy(load.reason==='twin'?'entryTwinUnavailable':'entrySourceUnavailable')}</p><button type="button" onClick={()=>setAttempt(value=>value+1)}>{copy('entryRetry')}</button></>}
 </div></ContextDrawer>
}
