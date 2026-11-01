import {useEffect,useState,useSyncExternalStore} from 'react'
import type {PropsRuntime} from '@deepseek-ai/dsh-client-ui-slots'
import type {SessionEventSource,SessionEventLikeEntry} from '@deepseek-ai/dsh-api-session-controller/client'
import {ReferenceChip} from '@deepseek-ai/dsh-client-ui-primitives'
import type {DigitalRole} from '@teloa/contract'
import {employeeMentionDisplayName} from './employee-mention-text.js'
import {employeeMentionCopy} from './employee-mention-copy.js'
import {useI18n} from './i18n/provider.js'

export type EmployeeMentionReferenceSource={events:Pick<SessionEventSource,'subscribe'|'getSnapshot'>|undefined;roles:()=>Promise<readonly DigitalRole[]>}
const empty={entries:[]},emptyRead=()=>empty,emptySubscribe=()=>()=>{}
/** 复用官方 inline chip；未知时显示可读员工占位，不把wire值放title或可见正文。 */
export function EmployeeMentionReference({node,source,sessionId}:PropsRuntime<'conversation.user.text.node','teloa-employee'>&{source:EmployeeMentionReferenceSource}){
 const {locale}=useI18n(),snapshot=useSyncExternalStore<{entries:readonly SessionEventLikeEntry[]}>(source.events?.subscribe??emptySubscribe,source.events?.getSnapshot??emptyRead,source.events?.getSnapshot??emptyRead)
 const [directory,setDirectory]=useState<{source:EmployeeMentionReferenceSource;sessionId:string;roles:readonly DigitalRole[]}>()
 useEffect(()=>{let active=true;void source.roles().then(roles=>{if(active)setDirectory({source,sessionId,roles})},()=>{});return()=>{active=false}},[source,sessionId,node.data.roleId,node.data.roleVersion])
 const roles=directory?.source===source&&directory.sessionId===sessionId?directory.roles:[]
 const name=employeeMentionDisplayName(node.data,snapshot.entries.flatMap(row=>row.type==='event'?[row.event]:[]),roles)??employeeMentionCopy(locale,'section')
 return <ReferenceChip appearance="session" label={'@'+name} title={'@'+name}/>
}
