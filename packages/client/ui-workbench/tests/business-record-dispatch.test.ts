import assert from 'node:assert/strict'
import {test,before,after} from 'node:test'
import {mkdtemp,writeFile,rm,mkdir} from 'node:fs/promises'
import {fileURLToPath} from 'node:url'
import {join} from 'node:path'
import {build} from 'vite'
// @ts-expect-error 既有浏览器夹具没有 MJS 类型声明。
import {launchOptions,loadPlaywright} from './fixtures/load-playwright.mjs'
const root=fileURLToPath(new URL('../../../../',import.meta.url)),client=fileURLToPath(new URL('../src/client/',import.meta.url))
let browser:any,script:string,styles:string,temp:string
const entry=`
import React from 'react';import {createRoot} from 'react-dom/client';
import {BusinessConfigurationPage} from '${client}BusinessConfigurationPage.tsx';
import {TaskDetail} from '${client}TaskDetail.tsx';
import {withBusinessTaskSource} from '${client}business-task-presentation.ts';
import {emptyBusinessPreview} from '${client}business-preview.ts';
import {readTaskInputs} from '${client}task-inputs.ts';
import {createBusinessTaskListApi} from '${client}business-task-list-api.ts';
import {BusinessRecordFlow} from '${client}business-record-flow.ts';
import {I18nProvider} from '${client}i18n/provider.tsx';import {translateMessage} from '${client}i18n/messages.ts';
const locale=document.documentElement.lang,snapshot={locale,dshLocale:locale==='en'?'en':'zh',revision:1};
const runtime={t:(k,p)=>translateMessage(locale,k,p),subscribe:()=>()=>{},getSnapshot:()=>snapshot};
const state=window.dispatchFixture={calls:[],sent:[],enabled:true,hold:false,fail:false,release:null,preview:false,reference:undefined,badHash:false,tasks:false,taskCalls:[],opened:[],taskView:false,goTask:false,external:false,writable:false};
const stamp='2026-09-29T00:00:00.000Z';
const record=v=>({scope:'sales',type:'order',id:'order-one',version:v,snapshotHash:(v===1?'a':'b').repeat(64),title:locale==='en'?'Customer order':'客户订单',summary:'',source:state.external?'mcp/list_items':'local',observedAt:stamp,receivedAt:stamp,quality:'complete',fields:[]});
const definition={format:'teloa.business-object-type/v1',id:'order',version:'1.0.0',domain:'sales',title:'Orders',unit:'item',lead:'',sourceId:'local',fields:[]};
const page={kind:'records',definition:{id:'orders',kind:'records',title:locale==='en'?'Orders':'订单',objectType:'order',fields:[],allowCreate:false,allowEdit:true,allowArchive:true},objectType:definition,emptyState:'no-records'};
const flow=new BusinessRecordFlow({list:async()=>({sourceId:'local',items:[record(2)]}),get:async input=>{state.calls.push(input);if(state.hold)await new Promise(r=>state.release=r);if(state.fail)throw Error('read failed');return {...record(input.version??2),...(state.badHash?{snapshotHash:'f'.repeat(64)}:{})}},create:async()=>{throw Error('write forbidden')},edit:async()=>{await new Promise(resolve=>state.saveRelease=resolve);return record(2)},archive:async()=>{throw Error('write forbidden')}},()=> '11111111-1111-4111-8111-111111111111');
const taskId='22222222-2222-4222-8222-222222222222';
const reference={scope:'sales',type:'order',id:'order-one',version:1,snapshotHash:'a'.repeat(64)};
const source={schema:'teloa.business-task-source/v1',taskId,ownerId:'owner',sourceId:'local',reference,createdAssignee:null,createdAt:stamp};
const taskList={api:createBusinessTaskListApi(async(endpoint,input)=>{state.taskCalls.push({endpoint,input});return {items:[{task:{id:taskId,ownerId:'owner',scope:'sales',title:'Review order',version:1,state:'waiting',assigneeRoleId:null,assigneeRoleVersion:null,createdAt:stamp,updatedAt:stamp},source,progress:null,completion:null}]}},'owner'),openTask:id=>{state.opened.push(id);if(state.goTask){state.taskView=true;state.render()}}};
const task=withBusinessTaskSource({storage:'persistent',id:taskId,title:'Review order',goal:'Review',scope:'sales',object:'Order',version:1,state:'waiting',need:null,request:'',authorId:'self',assigneeId:'self',assigneeHistory:[],createdAt:stamp,updatedAt:stamp,result:'Result received; awaiting review',evidence:[],history:[],supplements:[],approvalRequired:false,risk:'',execution:'completed'},source);
const noop=()=>{};
const taskProps={attentionNeeds:[],securityItems:[],securityActions:null,industrySource:null,executions:()=>null,knowledge:null,handoffs:null,handoffRows:[],conversations:()=>null,draft:readTaskInputs({},task),patch:noop,clear:noop,review:noop,openArtifacts:noop,openPlans:noop,task,approvals:[],artifacts:[],change:noop,back:noop,backHidden:false,openSource:noop,roles:[],team:noop,openRole:noop,business:emptyBusinessPreview(),openBusiness:target=>{state.reference=target.recordReference;state.taskView=false;state.render()},saveTemplate:noop};
state.saveBackground=()=>{const session=flow.forTarget('sales','order');session.configure(definition,{create:true,edit:true,archive:true});session.edit(record(1));return session.save()};
const app=createRoot(document.getElementById('root'));
state.render=()=>app.render(<I18nProvider runtime={runtime}>{state.taskView?<TaskDetail {...taskProps}/>:<BusinessConfigurationPage projection={{scope:'sales',configurationHash:'c'.repeat(64),...(state.preview?{mode:'preview',draftId:'11111111-1111-4111-8111-111111111111',revision:1}:{mode:'saved',configurationVersion:1}),page}} colorScheme="light" recordFlow={flow} recordReference={state.reference} {...(state.writable?{capabilities:{create:true,edit:true,archive:true}}:{})} {...(state.tasks?{taskList}:{})} {...(state.enabled?{onDispatch:reference=>state.sent.push(reference)}:{})}/>}</I18nProvider>);
state.render();`
before(async()=>{
 await mkdir(join(root,'.runtime'),{recursive:true});temp=await mkdtemp(join(root,'.runtime/record-dispatch-'))
 await writeFile(join(temp,'fixture.tsx'),entry)
 const built=await build({configFile:false,root,logLevel:'error',define:{'process.env.NODE_ENV':'"development"'},build:{write:false,minify:false,rollupOptions:{external:(id:string)=>id.startsWith('node:'),treeshake:{moduleSideEffects:false}},lib:{entry:join(temp,'fixture.tsx'),name:'RecordDispatchFixture',formats:['iife']}}})
 const bundle=Array.isArray(built)?built[0]:built;assert.ok(bundle&&'output' in bundle)
 script=bundle.output.find(x=>x.type==='chunk')!.code;styles=bundle.output.flatMap(x=>x.type==='asset'&&x.fileName.endsWith('.css')?[String(x.source)]:[]).join('\n')
 browser=await loadPlaywright().chromium.launch(launchOptions());await mkdir('/tmp/teloa-record-dispatch',{recursive:true})
})
after(async()=>{await browser?.close();if(temp)await rm(temp,{recursive:true,force:true})})
async function fixture(t:any,locale='zh-CN',width=1400){
 const p=await browser.newPage({viewport:{width,height:960}});p.setDefaultTimeout(3000)
 const errors:string[]=[];p.on('pageerror',(e:Error)=>errors.push(e.message));await p.route('**/*',(r:any)=>r.abort())
 t.after(async()=>{await p.close();assert.deepEqual(errors,[])})
 await p.setContent('<html lang="'+locale+'"><body><div id="root"></div></body></html>');await p.addStyleTag({content:':root{--teloa-font-section:18px;--teloa-font-body:14px;--teloa-font-caption:12px;--teloa-font-control:14px;--teloa-weight-heading:600;--teloa-weight-medium:500;--teloa-leading-heading:1.4;--teloa-border:#ddd;--teloa-surface:#fff;--teloa-subtle:#f5f5f2;--teloa-text:#252823;--teloa-muted:#646a62;--teloa-accent:#9e4226}body{font-family:system-ui;margin:16px}'+styles});await p.addScriptTag({content:script})
 await p.getByRole('button',{name:locale==='en'?/Customer order/:/客户订单/}).click();await p.waitForFunction(()=>(window as any).dispatchFixture.calls.length===1)
 return p
}
for(const locale of ['zh-CN','en'])for(const width of [390,1400])test(locale+'/'+width+' 正式记录交办传递选中历史版完整引用，预览和未接通不提供交办',async t=>{
 const p=await fixture(t,locale,width),name=locale==='en'?'Delegate this record':'交办此记录'
 await p.getByRole('button',{name,exact:true}).click()
 assert.deepEqual(await p.evaluate(()=>(window as any).dispatchFixture.sent),[{scope:'sales',type:'order',id:'order-one',version:2,snapshotHash:'b'.repeat(64)}])
 await p.getByRole('button',{name:locale==='en'?'View previous version':'查看历史版本',exact:true}).click()
 await p.waitForFunction(()=>(window as any).dispatchFixture.calls.length===2)
 await p.getByRole('button',{name,exact:true}).click()
 assert.equal(await p.evaluate(()=>(window as any).dispatchFixture.sent.at(-1).version),1)
 assert.equal(await p.evaluate(()=>(window as any).dispatchFixture.sent.at(-1).snapshotHash),'a'.repeat(64))
 assert.equal(await p.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false)
 await p.screenshot({path:'/tmp/teloa-record-dispatch/'+locale+'-'+width+'.png',fullPage:true})
 await p.evaluate(()=>{const s=(window as any).dispatchFixture;s.enabled=false;s.render()});assert.equal(await p.getByRole('button',{name,exact:true}).count(),0)
 await p.evaluate(()=>{const s=(window as any).dispatchFixture;s.enabled=true;s.preview=true;s.render()});assert.equal(await p.getByRole('button',{name,exact:true}).count(),0)
})
test('记录详情读取在途/失败时不允许将旧选择作为已核实对象交办',async t=>{
 const p=await fixture(t)
 await p.evaluate(()=>(window as any).dispatchFixture.hold=true)
 await p.getByRole('button',{name:'查看历史版本',exact:true}).click()
 await p.waitForFunction(()=>!!(window as any).dispatchFixture.release)
 const action=p.getByRole('button',{name:'交办此记录',exact:true});assert.equal(await action.isDisabled(),true)
 await p.evaluate(()=>{const s=(window as any).dispatchFixture;s.fail=true;s.release()})
 await p.getByRole('alert').waitFor();assert.equal(await action.isDisabled(),true)
 assert.deepEqual(await p.evaluate(()=>(window as any).dispatchFixture.sent),[])
})

test('同步来源告警可交办，但不显示手工记录编辑和归档操作',async t=>{
 const p=await fixture(t)
 await p.evaluate(()=>{const s=(window as any).dispatchFixture;s.external=true;s.writable=true;s.render()})
 await p.getByRole('button',{name:'客户订单'}).click()
 await p.getByText('同步数据 · 只读').waitFor()
 assert.equal(await p.getByRole('button',{name:'交办此记录',exact:true}).count(),1)
 assert.equal(await p.getByRole('button',{name:'编辑记录',exact:true}).count(),0)
 assert.equal(await p.getByRole('button',{name:'归档记录',exact:true}).count(),0)
})

for(const locale of ['zh-CN','en'])for(const width of [390,1400])test(locale+'/'+width+' 记录详情复用对象任务目录，真实等待状态不冒充验收完成',async t=>{
 const p=await fixture(t,locale,width)
 await p.evaluate(()=>{const s=(window as any).dispatchFixture;s.tasks=true;s.render()})
 const list=p.getByRole('region',{name:locale==='en'?'Related tasks':'对象相关任务',exact:true})
 await list.getByRole('heading',{name:'Review order'}).waitFor()
 assert.deepEqual(await p.evaluate(()=>(window as any).dispatchFixture.taskCalls),[{endpoint:'business-tasks/list-for-object',input:{scope:'sales',type:'order',id:'order-one',limit:20}}])
 assert.match(await list.innerText(),locale==='en'?/Waiting/:/等待处理/)
 await list.getByRole('button',{name:locale==='en'?'View task and results':'查看任务与成果',exact:true}).click()
 assert.deepEqual(await p.evaluate(()=>(window as any).dispatchFixture.opened),['22222222-2222-4222-8222-222222222222'])
 assert.equal(await p.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false)
 await p.screenshot({path:'/tmp/teloa-record-dispatch/tasks-'+locale+'-'+width+'.png',fullPage:true})
 await p.getByRole('button',{name:locale==='en'?'Close details':'关闭详情',exact:true}).click()
 assert.equal(await list.count(),0)
 await p.evaluate(()=>{const s=(window as any).dispatchFixture;s.preview=true;s.render()})
 assert.equal(await list.count(),0)
 assert.equal(await p.evaluate(()=>(window as any).dispatchFixture.taskCalls.length),1)
})

test('任务来源直接读固定版本且只读；哈希不一致不显示来源详情/任务，允许显式回当前',async t=>{
 const p=await fixture(t)
 const reference={scope:'sales',type:'order',id:'order-one',version:1,snapshotHash:'a'.repeat(64)}
 await p.evaluate((ref:typeof reference)=>{const s=(window as any).dispatchFixture;s.reference=ref;s.tasks=true;s.render()},reference)
 await p.getByRole('button',{name:'返回当前版本',exact:true}).waitFor()
 assert.deepEqual(await p.evaluate(()=>(window as any).dispatchFixture.calls.at(-1)),{scope:'sales',type:'order',id:'order-one',version:1})
 await p.getByRole('button',{name:'交办此记录',exact:true}).click()
 assert.equal(await p.evaluate(()=>(window as any).dispatchFixture.sent.at(-1).version),1)
 await p.getByRole('button',{name:'返回当前版本',exact:true}).click()
 await p.waitForFunction(()=>(window as any).dispatchFixture.calls.at(-1).version===undefined)
 await p.evaluate(()=>{const s=(window as any).dispatchFixture;s.badHash=true;s.reference={...s.reference,version:2,snapshotHash:'b'.repeat(64)};s.render()})
 await p.getByRole('alert').waitFor()
 assert.equal(await p.getByRole('button',{name:'交办此记录',exact:true}).count(),0)
 assert.equal(await p.getByRole('region',{name:'对象相关任务',exact:true}).count(),0)
})

test('对象任务列表→真实TaskDetail→固定来源版本；收到成果仍是等待状态',async t=>{
 const p=await fixture(t)
 await p.evaluate(()=>{const s=(window as any).dispatchFixture;s.tasks=true;s.goTask=true;s.render()})
 await p.getByRole('button',{name:'查看任务与成果',exact:true}).click()
 await p.getByRole('heading',{name:'Review order',exact:true}).waitFor()
 await p.getByRole('button',{name:'资料与关联会话',exact:true}).click()
 const returned=p.getByRole('button',{name:'返回来源工作',exact:true})
 await returned.click()
 await p.getByRole('button',{name:'返回当前版本',exact:true}).waitFor()
 assert.deepEqual(await p.evaluate(()=>(window as any).dispatchFixture.calls.at(-1)),{scope:'sales',type:'order',id:'order-one',version:1})
 await p.getByRole('button',{name:'交办此记录',exact:true}).click()
 assert.deepEqual(await p.evaluate(()=>(window as any).dispatchFixture.sent.at(-1)),{scope:'sales',type:'order',id:'order-one',version:1,snapshotHash:'a'.repeat(64)})
})

test('切到另一固定版本后，迟到旧记录响应不能覆盖新版本；来源失败不沿用旧对象',async t=>{
 const p=await fixture(t)
 const reference={scope:'sales',type:'order',id:'order-one',version:1,snapshotHash:'a'.repeat(64)}
 await p.evaluate((ref:typeof reference)=>{const s=(window as any).dispatchFixture;s.hold=true;s.reference=ref;s.render()},reference)
 await p.waitForFunction(()=>!!(window as any).dispatchFixture.release)
 await p.evaluate(()=>{const s=(window as any).dispatchFixture;s.hold=false;s.reference={...s.reference,version:2,snapshotHash:'b'.repeat(64)};s.render()})
 await p.getByRole('button',{name:'交办此记录',exact:true}).waitFor()
 await p.evaluate(()=>(window as any).dispatchFixture.release())
 await p.getByRole('button',{name:'交办此记录',exact:true}).click()
 assert.equal(await p.evaluate(()=>(window as any).dispatchFixture.sent.at(-1).version),2)
 const before=await p.evaluate(()=>(window as any).dispatchFixture.calls.length)
 await p.evaluate(()=>{const s=(window as any).dispatchFixture;s.reference={...s.reference,scope:'other'};s.render()})
 await p.getByRole('alert').waitFor()
 assert.equal(await p.evaluate(()=>(window as any).dispatchFixture.calls.length),before)
 assert.equal(await p.getByRole('button',{name:'交办此记录',exact:true}).count(),0)
})

test('原记录保存迟到回执刷新列表但不能改写任务来源固定版本',async t=>{
 const p=await fixture(t)
 await p.evaluate(()=>{void (window as any).dispatchFixture.saveBackground()})
 await p.waitForFunction(()=>!!(window as any).dispatchFixture.saveRelease)
 await p.evaluate(()=>{const s=(window as any).dispatchFixture;s.reference={scope:'sales',type:'order',id:'order-one',version:1,snapshotHash:'a'.repeat(64)};s.render()})
 await p.getByRole('button',{name:'返回当前版本',exact:true}).waitFor()
 await p.evaluate(()=>(window as any).dispatchFixture.saveRelease())
 await p.getByText('记录已保存。',{exact:true}).waitFor()
 await p.getByRole('button',{name:'交办此记录',exact:true}).click()
 assert.equal(await p.evaluate(()=>(window as any).dispatchFixture.sent.at(-1).version),1)
})
