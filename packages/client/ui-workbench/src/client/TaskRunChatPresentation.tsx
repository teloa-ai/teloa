import {createContext,createElement,useContext,useEffect,useState,useSyncExternalStore,type ComponentType} from 'react'
import type {PropsRuntime,StoredEntry} from '@deepseek-ai/dsh-client-ui-slots'
import type {TaskRunChatPresentation} from './task-run-api.js'
import {projectTaskRunChatNode,TaskRunChatPresentationDirectory} from './task-run-chat-presentation.js'
import css from './TaskRunChatPresentation.module.css'
import {useI18n} from './i18n/provider.js'
import {assistantConversationTitle} from './assistant-conversation.js'

declare module '@deepseek-ai/dsh-client-ui-slots'{interface SlotMap{'conversation.session.header.title':{kind:'single';scope:'session';owner:{lineageSessionId:string;displayTitle:string}}}}
type Source=ReturnType<TaskRunChatPresentationDirectory['forSession']>
type UserProps=PropsRuntime<'conversation.chat.node','user'>
function usePresentation(source:Source){const snapshot=useSyncExternalStore(source.subscribe,source.getSnapshot,source.getSnapshot);useEffect(()=>{if(snapshot.status==='idle')void source.load()},[source,snapshot.status]);return snapshot.value}

/** 仅借用外壳已核实的主聊身份及本人昵称，不改原生标题或以同名认领会话。 */
export const AssistantConversationTitleContext=createContext<{sessionId:string;name:string}|undefined>(undefined)

/** 标题只改变原面包屑内的文字；导航、原生 actions、视图与右栏仍由官方承载。 */
export function TaskRunConversationTitle({lineageSessionId,displayTitle,directory}:PropsRuntime<'conversation.session.header.title'>&{directory:TaskRunChatPresentationDirectory}){
 const assistant=useContext(AssistantConversationTitleContext),presentation=usePresentation(directory.forSession(lineageSessionId))
 return <>{presentation?.title??(assistant?.sessionId===lineageSessionId&&displayTitle===assistantConversationTitle?assistant.name:displayTitle)}</>
}

export type NativeUserRenderer={component:ComponentType<UserProps>;live:()=>boolean}
/** 借用原 keyed renderer 及其原 locale，不复制气泡、附件或复制动作实现。 */
export function nativeUserRenderer(entries:readonly StoredEntry[],isLive:(entry:StoredEntry)=>boolean):NativeUserRenderer|null{
 const entry=entries.find(row=>row.options.key==='user'&&(row.options.priority??0)===0)
 if(!entry||entry.inject||entry.children||entry.store||!entry.component)return null
 return {component:entry.component as ComponentType<UserProps>,live:()=>isLive(entry)}
}

export function TaskRunUserMessageView({source,renderer,...props}:UserProps&{source:Source;renderer:{subscribe:(listener:()=>void)=>()=>void;getSnapshot:()=>readonly StoredEntry[];isLive:(entry:StoredEntry)=>boolean}}){
 const presentation=usePresentation(source),{locale}=useI18n(),entries=useSyncExternalStore(renderer.subscribe,renderer.getSnapshot,renderer.getSnapshot)
 const native=nativeUserRenderer(entries,renderer.isLive)
 return native?<TaskRunUserMessage {...props} presentation={presentation} native={native} locale={locale}/>:null
}

/** 详细配置沿原生消息 renderer 按需展开；默认复制动作复制可读目标。 */
export function TaskRunUserMessage(props:UserProps&{presentation:TaskRunChatPresentation|null;native:NativeUserRenderer;locale:string}){
 const {native,presentation,locale,...owner}=props
 const [expanded,setExpanded]=useState(false)
 useEffect(()=>setExpanded(false),[owner.sessionId,owner.node.key])
 if(!native.live())return null
 const node=projectTaskRunChatNode(owner.node,owner.sessionId,presentation)
 const content=createElement(native.component,{...owner,node})
 if(node===owner.node)return content
 const summary=locale==='zh-CN'?'查看本次运行配置':locale.startsWith('zh')?'查看本次執行設定':'View run configuration'
 return <>{content}<details className={css.configuration} open={expanded} onToggle={event=>setExpanded(event.currentTarget.open)}><summary>{summary}</summary>{expanded&&createElement(native.component,owner)}</details></>
}
