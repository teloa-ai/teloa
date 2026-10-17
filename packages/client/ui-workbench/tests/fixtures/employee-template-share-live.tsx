import {useEffect,useState} from 'react'
import {createRoot} from 'react-dom/client'
import type {TemplateShareBridge,TemplateShareIntent} from '@teloa/contract'
import {EmployeeTemplateShare,TemplateShareProvider} from '../../src/client/EmployeeTemplateShare.js'
import {TemplateShareReceive} from '../../src/client/TemplateShareReceive.js'
import {createShareAcceptance} from '../../src/client/template-share-accept.js'
import {createRoleApi} from '../../src/client/role-api.js'
import {createMarketContentApi} from '../../src/client/market-content-api.js'
import {createIndustryLoadApi} from '../../src/client/industry-load-api.js'
import {createIndustryKnowledgeApi} from '../../src/client/industry-knowledge-api.js'
import {createIndustryRoleApi} from '../../src/client/industry-role-api.js'
import {createBusinessSpaceApi} from '../../src/client/business-space-api.js'
import {I18nProvider} from '../../src/client/i18n/provider.js'
import {translateMessage} from '../../src/client/i18n/messages.js'
import type {PreviewRole} from '../../src/client/role-preview.js'
import {prototypeThemes} from '../../src/brand/prototype-theme.js'
import tokens from '../../src/client/theme-tokens.module.css'
import taskCss from '../../src/client/TaskPage.module.css'
import teamCss from '../../src/client/TeamPage.module.css'

// 只连接本轮回环 HTTP Harness；身份由测试宿主固定，不接受页面自报 owner。
async function call(endpoint:string,payload:unknown){
 const response=await fetch('/rpc',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({endpoint,payload})})
 const result=await response.json()
 if(!response.ok)throw Object.assign(Error(result.error.message),{rejected:true,code:result.error.code})
 return result.value
}
const journal=(key:string)=>({read:()=>localStorage.getItem(key),write:(value:string)=>localStorage.setItem(key,value),clear:()=>localStorage.removeItem(key)})
const roles=createRoleApi(call,journal('teloa.role-create/v1'))
const market=createMarketContentApi(call,journal('teloa.market-content-import/v1'))
const loads=createIndustryLoadApi(call,journal('teloa.industry-load-create/v1'))
const knowledge=createIndustryKnowledgeApi(call,journal('teloa.industry-knowledge/v1'))
const employees=createIndustryRoleApi(call,journal('teloa.industry-role/v1'))
const spaces=createBusinessSpaceApi(call)
const unavailable=async()=>{throw Error('本预览夹具不提供分享写入。')}
const previewBridge:TemplateShareBridge={
 policy:async()=>({receiveMode:'preview-only',canPublish:false}),publish:unavailable,list:unavailable,revoke:unavailable,
 async read({shareId}){const response=await fetch('/test/template-preview/'+shareId,{credentials:'omit',redirect:'error'});if(!response.ok)throw Error('模板读取失败');return response.json()},
 pending:()=>null,subscribe:()=>()=>{},dismiss:async()=>undefined,
}
// 可信测试宿主转接隔离 Worker 的具名 RPC；本人身份仅在 HTTP 宿主固定。
// 此桥用于本机开发验收，不代表生产账号、部署或正式发布验收。
async function publisherCall(method:string,input?:unknown){
 const response=await fetch('/test/template-publisher',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({method,input})})
 const result=await response.json();if(!response.ok)throw Error(result.error);return result
}
const publisherBridge:TemplateShareBridge={
 policy:async()=>({receiveMode:'personal-role',canPublish:true}),
 publish:input=>publisherCall('publish',input),list:async()=>(await publisherCall('list',{})).items,revoke:input=>publisherCall('revoke',input),
 async read({shareId}){const response=await fetch('/test/template-publisher/'+shareId,{credentials:'omit',redirect:'error'});if(!response.ok)throw Error('隔离 Worker 模板读取失败');return response.json()},
 pending:()=>null,subscribe:()=>()=>{},dismiss:async()=>undefined,
}
// v1 员工包沿用原端口；v2 包与 WorkbenchFrame 相同走固定内容 → 加载 → 一键准备，员工由加载真源实例化。
// 本夹具的分享员工不带公共技能或随包技能，技能端口被调用即视为越界。
const target=async()=>{const space=await spaces.current();return {kind:'existing' as const,spaceId:space.id,expectedVersion:space.version}}
const acceptance=createShareAcceptance(localStorage,{
 createRole:async(fields,requestId)=>(await roles.create(fields,requestId)).id,
 industry:{
  publicSkill:async()=>{throw Error('本夹具不提供公共技能。')},
  target,
  importContent:(item,requestId)=>market.importIndustry(item,requestId),
  load:input=>loads.create(input),getLoad:loadId=>loads.get(loadId),
  installSkill:async()=>{throw Error('本夹具不提供技能安装。')},
  prepare:async loadId=>{const readiness=await loads.readiness(loadId);if(!readiness.counts.auto)return readiness;const receipt=await loads.prepare(loadId,readiness.digest,{activate:false});return receipt.readiness??loads.readiness(loadId)},
  roles:async loadId=>(await employees.list()).filter(row=>row.loadId===loadId).map(row=>({itemInstanceId:row.itemInstanceId,state:row.state,...(row.role?{roleId:row.role.id}:{})})),
 },
 v1:{
  target,
  importContent:(item,requestId)=>market.importIndustry(item,requestId),
  load:input=>loads.create(input),knowledge:input=>knowledge.instantiate(input),role:input=>employees.instantiate(input),
 },
})
const source:PreviewRole={id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',name:'验收研究员工',avatarKey:'security-analyst',kind:'employee',state:'active',version:9,scopes:['SOC'],duty:'核对本人提供的资料并形成建议。',dataScope:'仅接收方明确提供的资料。',executionScope:'仅阅读与代拟，外部操作须本人批准。',skills:['核对方法'],knowledge:['source-private-resource'],runtimeConfig:{agentPresetId:'source-private-preset'},memories:[{id:'private-memory',title:'私人记忆',text:'SOURCE_PRIVATE_MEMORY',scope:'private',source:'本人',status:'confirmed',version:1,createdAt:'2026-10-10T00:00:00Z',updatedAt:'2026-10-10T00:00:00Z'}],history:[{text:'SOURCE_PRIVATE_HISTORY',actorId:'source-private-owner',at:'2026-10-10T00:00:00Z'}]}
const snapshot={locale:'zh-CN',dshLocale:'zh',revision:1}
const i18n={subscribe:()=>()=>{},getSnapshot:()=>snapshot,t:(key:any,params:any)=>translateMessage('zh-CN',key,params)}
function App(){
 const [share,setShare]=useState(false),[receive,setReceive]=useState(false),[opened,setOpened]=useState('')
 const [intent,setIntent]=useState<TemplateShareIntent|null>(null)
 const [publisher,setPublisher]=useState(false),[hostedPreview,setHostedPreview]=useState(false)
 useEffect(()=>{
  // 只模拟宿主收到另一条预览意图；实际组件负责慢回包、协议与摘要核对。
  const deliver=(event:Event)=>{const detail=(event as CustomEvent<TemplateShareIntent&{publisher?:boolean}>).detail;setHostedPreview(detail.publisher===true);setIntent({shareId:detail.shareId});setReceive(true)}
  const enablePublisher=()=>setPublisher(true)
  window.addEventListener('teloa-test-template-intent',deliver)
  window.addEventListener('teloa-test-template-publisher',enablePublisher)
  return()=>{window.removeEventListener('teloa-test-template-intent',deliver);window.removeEventListener('teloa-test-template-publisher',enablePublisher)}
 },[])
 return <div className={tokens.tokens} style={{...prototypeThemes.light,minHeight:'100vh',padding:24} as any}>
  {/* 真实宿主样式的祖先范围，验证员工详情内共享抽屉不会被通用标题/按钮样式覆盖；不模拟完整 App。 */}
  <div className={[taskCss.page,taskCss.alignedPage,teamCss.teamPage].join(' ')}><div className={taskCss.detail}>
  <p>{publisher?'隔离验收 · 本机 Worker RPC 与 PG · 非生产发布验收':'隔离验收 · 真实分享组件与本机持久化接口'}</p>
  <button onClick={()=>setShare(true)}>分享验收员工</button><button onClick={()=>setReceive(true)}>接收模板文件</button>
  <output aria-label="当前打开对象">{opened}</output>
  {/* 与 WorkbenchFrame→TeamPage 相同：员工分享只在宿主分享上下文内出现，发布者取本人显示名（宿主缺省回退为“账号”，不会为空）。 */}
  <TemplateShareProvider value={{storage:localStorage,bridge:publisher?publisherBridge:undefined,publisher:'验收作者',receive:()=>setReceive(true),openDraft:()=>{}}}>
   <EmployeeTemplateShare role={source} open={share} close={()=>setShare(false)} storage={localStorage} bridge={publisher?publisherBridge:undefined}/>
  </TemplateShareProvider>
  <TemplateShareReceive open={receive} close={()=>setReceive(false)} intent={intent} bridge={intent?(hostedPreview?publisherBridge:previewBridge):undefined} accept={(value,choice,currentIntent)=>acceptance.accept(value,choice,currentIntent)} openRole={id=>setOpened('role:'+id)} configure={id=>setOpened('load:'+id)}/>
  </div></div>
 </div>
}
createRoot(document.getElementById('root')!).render(<I18nProvider runtime={i18n as any}><App/></I18nProvider>)
