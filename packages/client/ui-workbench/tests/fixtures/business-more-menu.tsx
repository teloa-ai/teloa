import React,{useState} from 'react'
import {createRoot} from 'react-dom/client'
import {BusinessMoreMenu} from '../../src/client/BusinessMoreMenu.js'
import {I18nProvider} from '../../src/client/i18n/provider.js'
import {translateMessage} from '../../src/client/i18n/messages.js'
import type {TeloaI18n,TeloaTranslate} from '../../src/client/i18n/index.js'
import tokens from '../../src/client/theme-tokens.module.css'
import css from '../../src/client/BusinessPage.module.css'
import {TaskPage} from '../../src/client/TaskPage.js'
import {emptyTaskPreview,type PreviewTask} from '../../src/client/task-preview.js'
import {localizedText} from '../../src/client/approval-preview.js'
import type {CollaborationScope} from '../../src/client/collaboration-preview.js'
import {writeDirectoryFilterCategory,type WorkbenchDirectoryNavigation,type WorkbenchDirectoryPatch} from '../../src/client/workbench-navigation-state.js'

const locale='zh-CN'
const t:TeloaTranslate=(key,params)=>translateMessage(locale,key,params)
const snapshot={locale,dshLocale:'zh',revision:1} as const
const runtime:TeloaI18n={getSnapshot:()=>snapshot,subscribe:()=>()=>{},t}
const scope='SOC'
const calls:{action:string;scope:string}[]=[]
Object.assign(window,{businessMoreFixture:{calls}})

const stamp='2026-10-01T00:00:00.000Z'
const task=(id:string,taskScope:CollaborationScope,persistent=false):PreviewTask=>({id,title:id,goal:'验收范围',scope:taskScope,object:'任务',version:1,state:'ready',need:null,request:'',authorId:'self',assigneeId:'self',assigneeHistory:[],createdAt:stamp,updatedAt:stamp,result:'',evidence:[],history:[],supplements:[],approvalRequired:false,risk:localizedText('task.approval.risk.none'),execution:'not_started',...(persistent?{storage:'persistent' as const}:{})})
const taskState={...emptyTaskPreview(),tasks:[task('通用验收任务','general'),task('SOC验收任务','SOC'),task('SOC正式任务','SOC',true)]}
const noOp=async()=>{}
const persistence={directoryKnown:true,attention:{rows:[],known:true},handoffs:{rows:[],known:true,loading:false,error:undefined,pending:undefined,changePending:undefined,changeError:undefined,load:noOp,resolve:noOp,recover:noOp,change:noOp,recoverChange:noOp},completion:{list:async()=>[],read:async()=>null,complete:noOp},stateRequest:undefined,stateError:undefined,recoverState:noOp,edit:noOp,create:async()=>'',pendingFields:()=>undefined,load:()=>{},loading:false,error:undefined}

function App(){
 const [showTasks,setShowTasks]=useState(false)
 const [selected,setSelected]=useState<string|null>(null)
 const [persistent,setPersistent]=useState(false)
 const [embedded,setEmbedded]=useState(false)
 const [navigation,setNavigation]=useState<WorkbenchDirectoryNavigation>({category:writeDirectoryFilterCategory({scope:'general',routed:'all'}),query:''})
 const changeNavigation=(patch:WorkbenchDirectoryPatch)=>setNavigation(previous=>{
  const next={...previous,...patch}
  return {...(next.category===undefined?{}:{category:next.category}),...(next.query===undefined?{}:{query:next.query}),...(next.selectedId===undefined?{}:{selectedId:next.selectedId}),...(next.scrollTop===undefined?{}:{scrollTop:next.scrollTop})}
 })
 const choose=(action:string,value:string)=>{
  calls.push({action,scope:value})
  if(action==='work'){
   setNavigation({category:writeDirectoryFilterCategory({scope:value,routed:'all'}),query:''})
   setSelected(null)
   setShowTasks(true)
  }
 }
 return <I18nProvider runtime={runtime}>
  <main className={`${tokens.tokens} ${css.page}`}>
   <button type="button">菜单外面</button>
   <button type="button" onClick={()=>setShowTasks(false)}>离开任务</button>
   <button type="button" onClick={()=>setShowTasks(true)}>返回任务</button>
   <button type="button" onClick={()=>setNavigation({})}>清空外部筛选</button>
   <button type="button" onClick={()=>setEmbedded(true)}>嵌入窄框</button>
   <button type="button" onClick={()=>setPersistent(true)}>正式任务模式</button>
   <button type="button" onClick={()=>{setSelected('SOC验收任务');setShowTasks(true)}}>打开示例任务</button>
   <output aria-label="navigation-category">{navigation.category??''}</output>
   <div className={css.content} style={embedded?{width:210,height:220,marginLeft:150,border:'1px solid #bbb'}:undefined}>
    <div className={css.container}>
     {embedded&&<div style={{height:130}}/>}
     <div className={css.scopeBar} style={embedded?undefined:{justifyContent:'flex-end'}}>
      {embedded&&<><dl className={css.scopeStats}><div className={css.scopeStat}><dt>数据源</dt><dd>2</dd></div><div className={css.scopeStat}><dt>同事</dt><dd>1</dd></div><div className={css.scopeStat}><dt>自动化</dt><dd>1</dd></div></dl><button type="button" className={css.scopeStaff}>同事</button><button type="button" className={css.scopeStaff}>项目</button></>}
      <BusinessMoreMenu scope={scope} choose={choose}/>
     </div>
     {embedded&&<div style={{height:180}}/>}
    </div>
   </div>
   <TaskPage key={persistent?'persistent':'sandbox'} {...(persistent?{persistence}:{})} visible={showTasks} mode="tasks" state={taskState} selected={selected} select={setSelected} change={()=>{}} navigation={{state:navigation,change:changeNavigation}} conversations={()=>null} openArtifacts={()=>{}} openPlans={()=>{}} attentionItems={[]} openAttention={()=>{}} switchMode={()=>{}} openSource={()=>{}} team={()=>{}} openRole={()=>{}} openBusiness={()=>{}} saveTemplate={()=>{}}/>
  </main>
 </I18nProvider>
}
createRoot(document.getElementById('root')!).render(<App/>)
