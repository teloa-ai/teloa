// 真实组件与会话管理器，所有 I/O 只进入下方受控端口；浏览器 runner 阻断全部网络。
import React,{useState} from 'react'
import {createRoot} from 'react-dom/client'
import {I18nProvider} from '../../src/client/i18n/provider.js'
import {translateMessage} from '../../src/client/i18n/messages.js'
import {prototypeThemes} from '../../src/brand/prototype-theme.js'
import tokens from '../../src/client/theme-tokens.module.css'
import type {Conversation,ModelOptionsDirectory,RoleRuntimeConfig} from '@teloa/contract'
import type {TeloaI18n,TeloaTranslate} from '../../src/client/i18n/index.js'
import type {ArtifactMessage,NativeArtifactApi} from '../../src/client/artifact-native.js'
import type {PreviewRole} from '../../src/client/role-preview.js'
import type {PreviewTask} from '../../src/client/task-preview.js'
import type {RoleModelLoadState} from '../../src/client/role-models.js'
import type {ConversationAction} from '../../src/client/ConversationActions.js'
import type {ConversationManagementPort} from '../../src/client/conversation-management.js'
import {ConversationActions,ConversationActionMenu} from '../../src/client/ConversationActions.js'
import {ConversationManagement} from '../../src/client/conversation-management.js'
import {AdoptConversationDialog} from '../../src/client/AdoptConversationDialog.js'
import {CreateConversationDialog} from '../../src/client/CreateConversationDialog.js'
import {ConversationScopeDialog} from '../../src/client/ConversationScopeDialog.js'
import {RoleModelFields} from '../../src/client/RoleModelFields.js'
import {patchRoleModel} from '../../src/client/role-models.js'
import {RoleLifecycle} from '../../src/client/RoleLifecycle.js'
import {TaskList,type TaskListRow} from '../../src/client/TaskList.js'
import {NativeArtifactPicker,ArtifactMessages} from '../../src/client/NativeArtifactPicker.js'
import {PersonalProfileSettings} from '../../src/client/PersonalProfileSettings.js'
import {TaskForm} from '../../src/client/TaskPage.js'

const locale=document.documentElement.lang==='en'?'en':'zh-CN',snapshot={locale,dshLocale:locale==='en'?'en':'zh',revision:1} as const
const t:TeloaTranslate=(key,params)=>translateMessage(locale,key,params)
const runtime:TeloaI18n={getSnapshot:()=>snapshot,subscribe:()=>()=>{},t}
for(const [key,value] of Object.entries(prototypeThemes.light))document.body.style.setProperty(key,value)
const stamp='2026-09-29T00:00:00Z'
const row:Conversation={id:'binding-fixture',sessionId:'session-fixture',requestedSessionId:'session-fixture',status:'ready',title:'验收会话',ownerId:'self',scopeIds:['general'],version:1,createdAt:stamp}
let managementState:ReturnType<ConversationManagementPort['state']>={ready:true,baseline:true,archived:[],workspaces:[{workspaceId:'default',title:'默认目录',path:'/acceptance/default',sessionIds:[row.sessionId]},{workspaceId:'other',title:'第二目录',path:'/acceptance/other',sessionIds:[]}]}
const listeners=new Set<()=>void>(),rows=[row]
const state={calls:[] as {name:string;args?:unknown[]}[],fail:'',hold:'',running:false,wrongSession:false,invalidImage:false}
let release:()=>void=()=>{}
async function call(name:string,args:unknown[]=[]){state.calls.push({name,args});if(state.hold===name)await new Promise<void>(resolve=>{release=resolve});if(state.fail===name)throw Error('受控接口暂不可用')}
const management=new ConversationManagement(()=>rows)
management.attach({state:()=>managementState,subscribe:listener=>{listeners.add(listener);return()=>listeners.delete(listener)},summary:id=>({title:id===row.sessionId?row.title:'候选会话',running:state.running,blank:false}),rename:async(id,title)=>{await call('rename',[id,title]);row.title=title},archive:async id=>{await call('archive',[id]);managementState={...managementState,archived:[id]};for(const listener of listeners)listener()},copyHistory:async()=>{await call('copyHistory');return[]},fork:async()=>{await call('fork');return 'child-fixture'},ensure:async id=>({...row,sessionId:id}),adopt:async(id,requestId,title)=>{await call('adopt',[id,requestId,title]);return {...row,sessionId:id}},releaseCopy:async()=>{throw Error('未覆盖')},resolveCopy:async()=>{throw Error('未覆盖')},move:async()=>{throw Error('未覆盖')}})
const directory:ModelOptionsDirectory={default:{provider:'remote',model:'remote-model'},groups:[{id:'local',name:'本地',remote:false,models:[{id:'local-model',name:'本地模型'}]},{id:'remote',name:'远程',remote:true,models:[{id:'remote-model',name:'远程模型',reasoning:{efforts:[{id:'high',name:'高'}]}}]}],failures:[]}
const role:PreviewRole={id:'role-fixture',name:'验收同事',kind:'employee',scopes:['general'],state:'active',version:1,duty:'整理资料',dataScope:'general',executionScope:'只读',skills:[],knowledge:[],memories:[],history:[],storage:'persistent'}
const message=(id:string,seq:number,text:string):ArtifactMessage=>({sessionId:row.sessionId,messageId:id,seq,role:'assistant',at:stamp,text,images:[],interrupted:false,omittedBlocks:0})
const imageMessage:ArtifactMessage={...message('message-image',2,'图片引用正文'),images:[{blockIndex:1,attachment:{attachmentId:'image-fixture',name:'验收图片.png',mediaType:'image/png',width:1,height:1,bytes:68}}]}
const native:NativeArtifactApi={read:async(sessionId,before)=>{await call('readMessages',[sessionId,before]);return {sessionId:state.wrongSession?'wrong-session':sessionId,items:before===undefined?[message('message-new',3,'验收正文'),imageMessage]:[imageMessage,message('message-old',1,'较早原消息'),message('message-long',0,'长'.repeat(16001))],nextBeforeSeq:before===undefined?2:null}},imageUrl:async()=>{await call('imageUrl');if(state.invalidImage)return 'https://invalid.example/image.png';const canvas=document.createElement('canvas');canvas.width=canvas.height=1;const blob=await new Promise<Blob>(resolve=>canvas.toBlob(value=>resolve(value!),'image/png'));return URL.createObjectURL(blob)}}
const task=(id:string,source?:PreviewTask['source']):PreviewTask=>({id,title:id,goal:'验收目标',scope:'general',object:'本机任务',state:'ready',version:1,storage:'persistent',createdAt:stamp,updatedAt:stamp,...(source?{source}:{}),need:null,request:'',authorId:'self',assigneeId:role.id,assigneeHistory:[],result:'',evidence:[],history:[],supplements:[],approvalRequired:false,risk:'low',execution:'not_started'})
const taskRows:TaskListRow[]=[task('任务一'),task('任务二'),task('群内回应',{trigger:'routed',groupId:'group-fixture',messageId:'message-fixture',rootId:'message-fixture',text:'群回应'})].map(task=>({task,attention:{kinds:[],reason:null},ownerName:'验收同事',scopeLabel:'通用',unverified:false}))
Object.assign(window,{clientFunctionalFixture:{state,release:()=>{state.hold='';release()}}})
function App(){
 const [surface,setSurface]=useState(''),[action,setAction]=useState<ConversationAction>(),[title,setTitle]=useState(row.title),[busy,setBusy]=useState(false),[locked,setLocked]=useState(false),[modelState,setModelState]=useState<RoleModelLoadState>({status:'error'}),[roleRuntime,setRoleRuntime]=useState<RoleRuntimeConfig>(),[currentRole,setRole]=useState(role),[selected,setSelected]=useState<string|null>(null),[messages,setMessages]=useState<ArtifactMessage[]>([]),[enabled,setEnabled]=useState(true)
 const close=()=>{setSurface('');setAction(undefined)}
 return <I18nProvider runtime={runtime}><main id="teloa-main" tabIndex={-1} className={tokens.tokens}>
 <nav aria-label="验收入口">{['create','adopt','scope','models','lifecycle','tasks','artifacts','profile','task-form'].map(name=><button key={name} onClick={()=>setSurface(name)}>{name}</button>)}<button onClick={()=>{setLocked(true);setSurface('create')}}>locked-create</button><ConversationActionMenu title={row.title} disabled={false} choose={value=>{setTitle(row.title);setAction(value)}}/></nav>
 {action&&<ConversationActions target={{row,title:row.title,blank:false,action}} candidates={[]} management={management} title={title} changeTitle={setTitle} close={close} open={async row=>{await call('open',[row.sessionId]);close()}} running={state.running}/>}
 {surface==='create'&&<CreateConversationDialog management={management} current={row.sessionId} initialWorkspaceId={locked?'default':undefined} pendingRequestId={locked?'request-fixture':undefined} restart={id=>{state.calls.push({name:'restart',args:[id]});setLocked(false)}} locked={locked} busy={busy} goal="验收目标" create={async workspaceId=>{setBusy(true);try{await call('create',[workspaceId]);close()}finally{setBusy(false)}}} close={close} settings={()=>state.calls.push({name:'settings'})}/>}
 {surface==='adopt'&&<AdoptConversationDialog management={management} available candidates={[{id:'candidate-1',title:'候选会话一',workspace:'默认目录'},{id:'candidate-2',title:'候选会话二',workspace:'第二目录'}]} close={close}/>}
 {surface==='scope'&&<ConversationScopeDialog name={role.name} options={[{id:'general',label:'通用'},{id:'soc',label:'SOC'}]} close={close} select={scope=>{state.calls.push({name:'scope',args:[scope]});close()}}/>}
 {surface==='models'&&<><RoleModelFields runtime={roleRuntime} state={modelState} retry={()=>{state.calls.push({name:'retryModels'});setModelState({status:'ready',directory})}} change={(field,model)=>{state.calls.push({name:'model',args:[field,model]});setRoleRuntime(value=>patchRoleModel(value,field,model))}}/><button onClick={()=>setRoleRuntime({model:{provider:'missing',model:'removed'}})}>missing-model</button><output aria-label="model-selection">{JSON.stringify(roleRuntime)}</output></>}
 {surface==='lifecycle'&&<><output aria-label="role-state">{currentRole.state}</output><RoleLifecycle role={currentRole} api={{pending:undefined,error:undefined,recover:async()=>{},change:async(role,action,reason)=>{await call('roleChange',[role.id,action,reason]);setRole({...role,state:action==='pause'?'paused':action==='resume'?'active':'retired'})}}}/></>}
 {surface==='tasks'&&<TaskList rows={taskRows} filter="all" selected={selected} select={setSelected} stateLabel={()=>'待处理'} attentionLabel={String} stamp={()=>'今天'}/>}
 {surface==='profile'&&<PersonalProfileSettings/>}
 {surface==='task-form'&&<TaskForm persistent close={close} save={async fields=>{await call('createTask',[fields]);close()}}/>}
 {surface==='artifacts'&&<><NativeArtifactPicker sessionId={row.sessionId} api={native} selected={messages} select={message=>setMessages(value=>[...value,message])}/><ArtifactMessages messages={messages} api={native} enabled={enabled} remove={message=>setMessages(value=>value.filter(item=>item.messageId!==message.messageId))}/><button onClick={()=>setEnabled(value=>!value)}>toggle-image-source</button></>}
 </main></I18nProvider>
}
createRoot(document.getElementById('root')!).render(<App/>)
