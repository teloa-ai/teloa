import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import test from 'node:test'
import type {TabId,TabRecord} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import {createRailTabs,type RailFace} from '../src/client/sidebar-right-rail.ts'
import {objectRefTarget} from '../src/client/business-preview.ts'
import {businessTaskSourceMissing,shouldLoadBusinessTaskSource,withBusinessTaskSource} from '../src/client/business-task-presentation.ts'
import {businessTargetMissing} from '../src/client/business-page-mode.ts'
import type {PreviewTask} from '../src/client/task-preview.ts'
import type {WorkbenchDetailTarget} from '../src/client/workbench-detail-target.ts'

const root=new URL('../src/client/',import.meta.url)
const read=(name:string)=>readFile(new URL(name,root),'utf8')
const id=(value:string)=>value as unknown as TabId

const source=(reference:{scope:'SOC';type:string;id:string;version:number}) => ({
 schema:'teloa.business-task-source/v1' as const,
 taskId:'11111111-1111-4111-8111-111111111111',
 ownerId:'local:teloa-owner',
 sourceId:'security-alert-http',
 reference:{...reference,snapshotHash:'a'.repeat(64)},
 createdAssignee:null,
 createdAt:'2026-09-16T01:00:00.000Z',
})

const savedTask=():PreviewTask=>({
 storage:'persistent',id:'11111111-1111-4111-8111-111111111111',title:'调查：可疑登录',goal:'核对来源',scope:'SOC',object:'本机任务',
 version:1,state:'ready',need:null,request:'',authorId:'self',assigneeId:'self',assigneeHistory:['self'],
 createdAt:'2026-09-16T01:00:00.000Z',updatedAt:'2026-09-16T01:00:00.000Z',
 result:'',evidence:[],history:[],supplements:[],approvalRequired:false,risk:'未提出外部动作',execution:'not_started',
})

/**
 * 桩右栏，只建模本用例要钉的一条：`multiple:false` 的同 kind 再开一次走「揭示既有页签」——
 * 不跑关闭钩子、不换 tab id，只把导航参数换掉。页签正文里的「返回目录」走的正是这条路。
 */
function stubRail(){
 const tabs=new Map<string,{id:string;kind:string;params:unknown}>()
 const calls:string[]=[]
 let activeId:string|undefined,pending:{id:string;kind:string;params:unknown}|undefined,serial=0
 let closed=0
 const record=(value:{id:string;kind:string})=>({id:id(value.id),kind:value.kind,contentId:'c-'+value.id,title:'t-'+value.id}) as TabRecord
 const face:RailFace={
  active:()=>{const current=activeId!==undefined&&tabs.get(activeId);return current?record(current):undefined},
  openTab:(kind,options)=>{
   calls.push('openTab:'+kind+':'+JSON.stringify(options?.params??null)+':'+String(options?.replaceTab??''))
   const replaced=options?.replaceTab===undefined?undefined:tabs.get(String(options.replaceTab))
   if(options?.replaceTab!==undefined&&!replaced)throw Error('findTabPane: 未知页签 '+String(options.replaceTab))
   // 同 kind 去重：既有页签留在条上，只换导航参数。
   if(replaced&&replaced.kind===kind){replaced.params=options?.params;activeId=replaced.id;return}
   if(replaced){closed++;tabs.delete(replaced.id)}
   pending={id:'tab'+(++serial),kind,params:options?.params}
  },
  close:tabId=>{calls.push('close:'+String(tabId));closed++;tabs.delete(String(tabId))},
 }
 return {
  face,calls,
  commit(){if(pending){tabs.set(pending.id,pending);activeId=pending.id;pending=undefined}return activeId},
  params:(tabId:string)=>tabs.get(tabId)?.params,
  tabIds:()=>[...tabs.keys()],
  closedCount:()=>closed,
 }
}

test('业务对象引用只有一把导航钥匙',()=>{
 assert.deepEqual(objectRefTarget({scope:'SOC',type:'alert',id:'evt-1',version:3,title:'可疑登录'}),{scope:'SOC',section:'data',id:'evt-1',objectType:'alert'})
})

test('会话关联区把关联任务的业务对象直接开进右栏业务页签',async()=>{
 const frame=await read('WorkbenchFrame.tsx')
 // 任务有固定范围时直达；数字员工只有唯一范围时才直达，多范围必须让用户选择，不能擅取第一项。
 // 用户在新建/关联时明确选过的业务语境（conversationObject.scopeId）优先，其余判据不变。
 assert.match(frame,/const contextScope=conversationObject\?\.scopeId\?\?contextTask\?\.scope\?\?\(contextRole\?\.scopes\.length===1\?contextRole\.scopes\[0\]:undefined\)/)
 assert.match(frame,/openContextBusiness\(\{scope:contextScope,section:'overview'\}\)/)
 assert.match(frame,/localizedScopeNames\[contextScope\]\?\?contextScope/)
 assert.match(frame,/contextTask\?\.objectRefs/)
 assert.match(frame,/openContextBusiness\(objectRefTarget\(ref\)\)/)
 assert.match(frame,/t\('frame\.context\.businessObject'/)
 // 判据不能再是「此刻已经开着任务 / 岗位详情」：业务对象要当得成会话页上第一个被打开的详情。
 assert.doesNotMatch(frame,/const openContextBusiness=\(target:BusinessTarget\)=>\{if\(objectDetailOpen/)
 assert.match(frame,/const openContextBusiness=\(target:BusinessTarget\)=>\{if\(conversationVisible&&current\)/)
})

test('持久调查任务按来源回执补齐固定输入',()=>{
 const task=savedTask()
 const next=withBusinessTaskSource(task,source({scope:'SOC',type:'alert',id:'evt-1',version:3}))
 assert.deepEqual(next.objectRefs,[{scope:'SOC',type:'alert',id:'evt-1',version:3,snapshotHash:'a'.repeat(64),title:'evt-1'}])
 assert.deepEqual(next.businessSource,{scope:'SOC',section:'data',id:'evt-1',objectType:'alert',recordReference:{scope:'SOC',type:'alert',id:'evt-1',version:3,snapshotHash:'a'.repeat(64)}})
 assert.equal(withBusinessTaskSource(task,null),task,'没有来源就原样交回，不凭空造引用')
})

test('所有正式业务范围都补拉固定输入，通用与页面示例不请求业务来源',()=>{
 assert.equal(shouldLoadBusinessTaskSource({storage:'persistent',scope:'SOC'}),true)
 assert.equal(shouldLoadBusinessTaskSource({storage:'persistent',scope:'AppSec'}),true)
 assert.equal(shouldLoadBusinessTaskSource({storage:'persistent',scope:'GRC'}),true)
 assert.equal(shouldLoadBusinessTaskSource({storage:'persistent',scope:'general'}),false)
 assert.equal(shouldLoadBusinessTaskSource({storage:'local',scope:'SOC'}),false)
})

test('固定输入只把 not-found 当作无来源，其余真实错误必须上浮',()=>{
 assert.equal(businessTaskSourceMissing({code:'teloa/not-found'}),true)
 assert.equal(businessTaskSourceMissing(Object.assign(Error('不存在'),{code:'teloa/not-found'})),true)
 assert.equal(businessTaskSourceMissing({code:'teloa/forbidden'}),false)
 assert.equal(businessTaskSourceMissing({code:'teloa/storage-corrupt'}),false)
 assert.equal(businessTaskSourceMissing(Error('网络失败')),false)
 assert.equal(businessTaskSourceMissing(null),false)
})

test('持久任务的固定输入由来源接口补拉并并回台账',async()=>{
 const frame=await read('WorkbenchFrame.tsx')
 assert.match(frame,/businessTaskApi\.source\(/)
 assert.match(frame,/shouldLoadBusinessTaskSource\(task\)/)
 assert.doesNotMatch(frame,/task\.scope!==['"]SOC['"]/)
 assert.match(frame,/withBusinessTaskSource/)
 assert.match(frame,/businessTaskSourceMissing\(error\)/)
 assert.match(frame,/setBusinessSourceLoadErrors/)
 // 补拉按任务至多一次：拉不到来源的任务不该被反复追问。
 assert.match(frame,/businessSourceLoads/)
})

test('页签正文里的「返回目录」留在本页签里，只换参数不关页签',()=>{
 const stub=stubRail()
 const rail=createRailTabs(()=>stub.face,kind=>kind.startsWith('teloa.'))
 const detail:WorkbenchDetailTarget={kind:'conversation-object',sessionId:'s1',objectKind:'business',target:{scope:'SOC',section:'data',id:'evt-1',objectType:'alert'}}
 const catalog:WorkbenchDetailTarget={kind:'conversation-object',sessionId:'s1',objectKind:'business',target:{scope:'SOC',section:'data'}}
 rail.open('s1','teloa.business',{scope:'SOC',section:'data',id:'evt-1',objectType:'alert'},detail)
 const tab=stub.commit()!
 rail.bindTab('s1','teloa.business',id(tab))
 rail.open('s1','teloa.business',{scope:'SOC',section:'data'},catalog)
 assert.deepEqual(stub.tabIds(),[tab],'返回目录不该换一个新页签')
 assert.equal(stub.closedCount(),0,'返回目录一次也不该关页签')
 assert.deepEqual(stub.params(tab),{scope:'SOC',section:'data'},'目录视图的参数要真的落到页签上')
 assert.equal(rail.size('s1'),1)
})

test('真实对象目录按目标 id 自己选中，不再整页退回未找到',async()=>{
 assert.equal(businessTargetMissing({mode:'real',section:'data',id:'evt-1',found:false}),false)
 assert.equal(businessTargetMissing({mode:'sandbox',section:'data',id:'evt-1',found:false}),true)
 assert.equal(businessTargetMissing({mode:'sandbox',section:'data',id:'evt-1',found:true}),false)
 assert.equal(businessTargetMissing({mode:'real',section:'analysis',id:'run-1',found:false}),true)
 assert.equal(businessTargetMissing({mode:'real',section:'projects',id:'p-1',found:false}),false)
 assert.equal(businessTargetMissing({mode:'real',section:'data',found:false}),false)
 const page=await read('BusinessPage.tsx')
 assert.doesNotMatch(page,/businessTargetMissing/)
 assert.match(page,/objectType:target\.objectType/)
 assert.match(page,/objectId:target\.id/)
})
