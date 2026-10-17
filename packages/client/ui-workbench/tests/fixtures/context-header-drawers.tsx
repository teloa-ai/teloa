import {useEffect,useState} from 'react'
import {createRoot} from 'react-dom/client'
import type {SessionId} from '@deepseek-ai/dsh-session'
import type {PropsRuntime} from '@deepseek-ai/dsh-client-ui-slots'
import {RoleConversationIdentity,roleConversationIdentities} from '../../src/client/RoleConversationIdentity.js'
import {ResourceHistory} from '../../src/client/ResourceHistory.js'
import {I18nProvider} from '../../src/client/i18n/provider.js'
import {translateMessage} from '../../src/client/i18n/messages.js'
import {prototypeThemes} from '../../src/brand/prototype-theme.js'
import {rightbarCanShow,rightbarTrackWidth} from '../../src/client/rightbar-width.js'
import css from '../../src/client/WorkbenchFrame.module.css'
import tokens from '../../src/client/theme-tokens.module.css'

// 隔离接口仅提供引用记录；实际头部组件、抽屉、布局 CSS 与宽度规则来自产品源码。
const calls:string[]=[],snapshot={locale:'zh-CN',dshLocale:'zh',revision:1}
const runtime={subscribe:()=>()=>{},getSnapshot:()=>snapshot,t:(key:any,params:any)=>translateMessage('zh-CN',key,params)}
const sessionId='12345678-1234-4234-8234-123456789012' as SessionId
// 头部组件只读取已注入的本人身份与引用；调用其它原生能力必须显式扩展夹具。
const unavailable=():never=>{throw Error('此头部夹具未提供原生会话运行能力')}
const slotProps={sessionId,useSession:unavailable,useProjection:unavailable,useConversation:unavailable,useChat:unavailable,useInput:unavailable,
 inputActions:{captureInsertion:unavailable,insertText:unavailable,setDraft:unavailable,persistDraft:unavailable,addAttachments:unavailable,removeAttachment:unavailable,pruneAttachments:unavailable,submit:unavailable},
 useSessions:unavailable,useSessionStatus:unavailable,useSessionRetainInfo:unavailable,useWorkspaces:unavailable,usePanelInfo:unavailable,useAccess:unavailable,useRemoteAccess:unavailable,useSessionAccess:unavailable,useWorkspaceAccess:unavailable,
} satisfies PropsRuntime<'conversation.session.header.utilities'>
const binding={status:'ready',sessionId},work={subscribe:()=>()=>{},getSnapshot:()=>binding}
const api={history:async(sessionId:string,beforeSeq?:number)=>{
 calls.push('history:'+String(beforeSeq))
 const start=beforeSeq??40
 return {sessionId,items:Array.from({length:20},(_,index)=>({seq:start-index,messageId:'message-'+(start-index),turn:1,at:'2026-10-12T00:00:00Z',references:[{id:'resource-'+(start-index),version:1,metadata:{title:'验收引用 '+(start-index),sourceId:'test',sourceVersion:'a'.repeat(64),scopeIds:['general']}}]})),nextBeforeSeq:beforeSeq===undefined?20:null}
}}
roleConversationIdentities.write(sessionId,'资料核对员')
function App(){
 const [viewport,setViewport]=useState(window.innerWidth),[directory,setDirectory]=useState(true),[expanded,setExpanded]=useState(true)
 useEffect(()=>{const resize=()=>setViewport(window.innerWidth);window.addEventListener('resize',resize);return()=>window.removeEventListener('resize',resize)},[])
 const width=rightbarTrackWidth(540,viewport,directory),shown=expanded&&rightbarCanShow(viewport,directory,width)
 return <div className={[tokens.tokens,css.frame,directory&&css.directoryOpen,shown&&css.detailsOpen].filter(Boolean).join(' ')} style={prototypeThemes.light as any}>
  <aside className={css.navigation}>工作区导航</aside><div className={css.workspace}><header className={css.topbar}>
   <RoleConversationIdentity {...slotProps} readIdentity={async()=> '独立侧栏员工'}/><ResourceHistory {...slotProps} api={api as any} work={work as any}/>
   <button type="button" onClick={()=>setDirectory(!directory)}>切换目录</button><button type="button" onClick={()=>setExpanded(!shown)}>工作概览</button>
  </header><div className={css.columns}><aside className={css.directory}>会话目录</aside><main id="teloa-main" className={css.main} tabIndex={-1} data-testid="main"><textarea aria-label="未提交草稿" defaultValue="保留本人原任务草稿" style={{width:'100%',height:100,boxSizing:'border-box'}}/></main><div className={css.details} style={{['--teloa-details-width' as string]:width+'px'}} data-testid="overview">{shown&&<section>工作概览内容</section>}</div></div></div>
 </div>
}
;(window as any).contextHeaderTest={calls,primaryEntry:()=>roleConversationIdentities.write(sessionId,'资料核对员',true),clearPrimary:()=>roleConversationIdentities.write(sessionId,undefined)}
createRoot(document.getElementById('root')!).render(<I18nProvider runtime={runtime as any}><App/></I18nProvider>)
