import {before,after,test} from 'node:test'
import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {mkdtemp,writeFile,rm} from 'node:fs/promises'
import {fileURLToPath} from 'node:url'
import {join} from 'node:path'
import {build} from 'vite'
// @ts-expect-error 复用既有无头浏览器加载器。
import {launchOptions,loadPlaywright} from './fixtures/load-playwright.mjs'

const root=fileURLToPath(new URL('../../../../',import.meta.url)),client=fileURLToPath(new URL('../src/client/',import.meta.url))
let browser:any,script:string,styles:string,temp:string
const entry=`
import React,{useEffect,useLayoutEffect,useMemo,useRef,useState} from 'react';import {createRoot} from 'react-dom/client';import {flushSync} from 'react-dom';
import {createSnapshotStore} from '${client}../../node_modules/@deepseek-ai/dsh-client-store/lib/index.js';
import {ConversationOverviewTab} from '${client}ConversationOverviewTab.tsx';
import {createArtifactApi} from '${client}artifact-api.ts';
import {ArtifactPanel} from '${client}ArtifactPanel.tsx';import {emptyTaskPreview} from '${client}task-preview.ts';import {publishTeloaTabHost,retractTeloaTabHost,notifyTeloaTabHost} from '${client}sidebar-right-tab-host.ts';
import {I18nProvider} from '${client}i18n/provider.tsx';import {translateMessage} from '${client}i18n/messages.ts';
const view=createRoot(document.getElementById('root')),locale='zh-CN',i18nSnapshot={locale,dshLocale:locale,revision:1};
const runtime={t:(key,params)=>translateMessage(locale,key,params),subscribe:()=>()=>{},getSnapshot:()=>i18nSnapshot};
const paths=['long','a','b','c','d','e',...Array.from({length:12},(_,i)=>'record-'+i)].map(name=>'output/'+name+'.md');
const event=(seq,type,data)=>({type:'event',event:{seq,type,data,time:1791360000000+seq,...(type==='user/message'?{surfaceOp:'append'}:{})}});
const entries=()=>[event(1,'turn/start',{turn:1}),event(2,'user/message',{id:'human',source:{kind:'user'},content:[]}),event(3,'deliverables/presented',{turn:1,callId:'delivery',files:paths.map(path=>({path}))}),event(100,'tool/call',{turn:1,step:1,callId:'outer',name:'run_code',arguments:'{}'}),event(101,'tool/ptc-dispatch-start',{rootCallId:'outer',parentCallId:'outer',subCallId:'nested',name:'mcp_search'}),event(102,'tool/ptc-dispatch',{rootCallId:'outer',parentCallId:'outer',subCallId:'nested',name:'mcp_search',isError:false}),event(103,'tool/result',{turn:1,step:1,message:{role:'tool',toolCallId:'outer',content:[],isError:true}})];
const bindings=new Map();
for(const id of ['main','other']){const projections={todos:createSnapshotStore([]),goal:createSnapshotStore(null),subagentCatalog:createSnapshotStore([]),subagentTiming:createSnapshotStore(null),subagent:createSnapshotStore(null)},state=createSnapshotStore({running:false,removed:false,openState:'open',lastAgentError:null,promptError:null,awaitingFirstTurn:false,subagent:null});bindings.set(id,{sessionId:id,eventSource:createSnapshotStore({entries:entries()}),session:{...state,sessionId:id,projections:{faceOf:key=>projections[key]},cancel:async()=>({ok:true})}})}
const list=createSnapshotStore({byId:{main:{title:'当前会话',cwd:'/fixture'},other:{title:'另一会话',cwd:'/fixture'}}}),retention=createSnapshotStore({referenceCount:1,retainedBy:{}}),connection=createSnapshotStore('connected'),pendingInteraction=createSnapshotStore(false),artifactChanges=createSnapshotStore(0);
const sessions={list,binding:id=>bindings.get(id),retainInfo:()=>retention,retain:()=>{throw Error('夹具没有子会话')},subagentAddress:()=>undefined,refresh:async()=>{},refreshProjections:async()=>{}};
const job=id=>({id:'job-'+id,kind:'command',label:'核对命令',owner:id,status:'running',startedAt:1791360000000});
const jobState=createSnapshotStore({rows:{main:[job('main')],other:[job('other')]},observed:{}}),calls={files:[],artifacts:[],resources:[],observe:[],release:[],downloads:[],artifactTargets:[],artifactChanges:[],nativeArtifacts:[]},waiting={files:[],artifacts:[],resources:[]};
const jobs={state:jobState,watchRows:id=>()=>calls.release.push(['rows',id]),observe:(id,jobId)=>{calls.observe.push([id,jobId]);jobState.set({...jobState.getSnapshot(),observed:{...jobState.getSnapshot().observed,[jobId]:{text:'真实命令记录 · '+id}}});return()=>calls.release.push(['observe',id,jobId])},kill:async()=>({ok:true})};
let selected='main',settings={heldFiles:[],artifactModes:{},resourceModes:{},artifactValues:{}};
const mode=(kind,id)=>settings[kind==='artifacts'?'artifactModes':'resourceModes'][id]??'success';
const failure=kind=>Object.assign(Error('fixture unavailable'),{code:kind==='resources'?'teloa/storage-unavailable':'teloa/source-unavailable'});
const resource=id=>({schema:'teloa.resource-use-snapshot/v1',sessionId:id,parentCallSeq:100,startSeq:101,parentCallId:'outer',use:{schema:'teloa.resource-use/v1',kind:'mcp',providerId:'fixture',name:id==='main'?'当前实际工具':'另一实际工具',toolName:'mcp_search',state:'used',callId:'nested',rootCallId:'outer'}});
const registered=(id,title)=>({id:id==='main'?'12345678-1234-4234-8234-123456789012':'22345678-1234-4234-8234-123456789012',source:{kind:'session',id},storage:'persistent',primary:false,links:[],feedback:[],versions:[{number:1,title,sections:[{id:'body',title:'正文',text:title}],source:{ref:{kind:'session',id},title:'来源会话',scope:'general',version:'binding',author:'本人',private:true,evidence:[]},note:'已保存',author:'本人',at:'2026-10-07T13:00:00Z',files:[]}]});
const read=(kind,id)=>{calls[kind].push(id);if(mode(kind,id)==='fail')return Promise.reject(failure(kind));if(mode(kind,id)==='hold')return new Promise((resolve,reject)=>waiting[kind].push({id,resolve,reject}));return Promise.resolve(kind==='artifacts'?settings.artifactValues[id]??[]:[resource(id)])};
const nativeApi=createArtifactApi(async(method,payload)=>{calls.nativeArtifacts.push([method,payload]);if(method==='artifacts/conversation/list')return {sessionId:payload.sessionId,artifacts:settings.nativeDirectory[payload.sessionId]??[]};if(method==='artifacts/versions')return settings.nativeVersions[payload.artifactId]??[];if(method==='artifacts/snapshot'&&settings.nativeSnapshots[payload.snapshotId])return settings.nativeSnapshots[payload.snapshotId];throw Error('未声明的成果读取 '+method)});
const artifacts={conversation:async id=>{if(!settings.nativeDirectory)return read('artifacts',id);const rows=await nativeApi.conversation(id);settings.artifactValues={...settings.artifactValues,[id]:rows};return rows},pendingFor:()=>[]};
async function snapshot(id,path,text){const bytes=new TextEncoder().encode(text),sha=await window.fixtureSha(text);return {schema:'teloa.file-snapshot/v1',sessionId:id,id:'a'.repeat(64),path,sha256:sha,bytes:bytes.length,capturedAt:'2026-10-07T13:00:00Z',contentBase64:btoa(String.fromCharCode(...bytes))}}
const files={read:(id,path)=>{calls.files.push([id,path]);if(settings.heldFiles.includes(id+':'+path))return new Promise((resolve,reject)=>waiting.files.push({id,path,resolve,reject}));return snapshot(id,path,'# '+path.split('/').at(-1)+' 快照\\n\\n来自 '+id)}};
const blobs=new Map(),createUrl=URL.createObjectURL.bind(URL),revokeUrl=URL.revokeObjectURL.bind(URL);
URL.createObjectURL=blob=>{const url=createUrl(blob);blobs.set(url,blob);return url};URL.revokeObjectURL=url=>{blobs.delete(url);revokeUrl(url)};
HTMLAnchorElement.prototype.click=function(){const blob=blobs.get(this.href);if(!blob)throw Error('下载未使用捕获快照');const name=this.download;void blob.arrayBuffer().then(buffer=>calls.downloads.push({name,bytes:Array.from(new Uint8Array(buffer)),text:new TextDecoder().decode(buffer)}))};
const signals=new Map([['main',new AbortController()],['other',new AbortController()]]);
function SharedArtifacts(){const [target,setTarget]=useState(null),[mount,setMount]=useState(null),latest=useRef(target);latest.current=target;const host=useMemo(()=>({render:()=>null,hasEvidence:()=>false,label:()=>undefined,bindTab:()=>{},releaseTab:()=>{},artifactPreview:{target:id=>id===selected?latest.current:null,mount:(_id,node)=>{setMount(node);return()=>setMount(null)},open:(id,value)=>{calls.artifactTargets.push([id,value]);setTarget(value)},close:()=>setTarget(null)}}),[]);useEffect(()=>{publishTeloaTabHost(host);return()=>retractTeloaTabHost(host)},[host]);useEffect(()=>notifyTeloaTabHost(),[target]);return <ArtifactPanel inline portal={mount} open={!!target} target={target} state={{...emptyTaskPreview(),tasks:settings.taskValues??[],artifacts:settings.artifactValues[selected]??[]}} conversation={{id:selected,title:'原会话',scope:'general',bindingId:'binding'}} taskSources={{list:async()=>[]}} nativeArtifacts={{}} artifactFileApi={files} close={()=>setTarget(null)} change={async command=>calls.artifactChanges.push(command)} openSource={()=>{}} openTask={()=>{}}/>}
function render(){const sessionId=selected,props={sessionId,sessions,jobs,connection,pendingInteraction,artifacts,files,artifactChanges,readResourceUses:id=>read('resources',id),useTabInfo:()=>({tab:{signal:signals.get(sessionId).signal,actions:{openResource:()=>{throw Error('夹具没有子会话地址')}}}})};flushSync(()=>view.render(<I18nProvider runtime={runtime}><div style={{display:'flex',height:600}}><div><textarea aria-label="原任务输入" defaultValue="保留的任务草稿"/></div><aside style={{width:380,height:'100%',minHeight:0}}><ConversationOverviewTab {...props}/></aside>{settings.shared&&<SharedArtifacts/>}</div></I18nProvider>))}
window.tabFixture={calls,notice:id=>{const store=bindings.get(id).eventSource,current=store.getSnapshot();store.set({entries:[...current.entries,event(104,'user/message',{id:'work-notice',source:{kind:'plugin:teloa.work',form:'notice',summary:'交办状态'},content:[{type:'text',text:'后台交办已完成'}]})]})},configure:value=>{settings={...settings,...value}},mount:id=>{selected=id??'main';render()},select:id=>{selected=id;render()},connect:value=>connection.set(value),registered,copy:key=>runtime.t(key),settle:()=>new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done))),resolveFile:async(id,path,text)=>{const row=waiting.files.find(item=>item.id===id&&item.path===path);if(!row)throw Error('无待完成文件读取');waiting.files.splice(waiting.files.indexOf(row),1);row.resolve(await snapshot(id,path,text))},resolve:async(kind,id,value)=>{const rows=waiting[kind].filter(row=>row.id===id);if(!rows.length)throw Error('无待完成目录读取');waiting[kind]=waiting[kind].filter(row=>row.id!==id);for(const row of rows)row.resolve(value)}};
`

before(async()=>{
 temp=await mkdtemp(join(root,'.runtime-overview-tab-'));await writeFile(join(temp,'fixture.tsx'),entry)
 const result=await build({configFile:false,root,logLevel:'error',define:{'process.env.NODE_ENV':'"development"'},build:{write:false,minify:false,rollupOptions:{external:(id:string)=>id.startsWith('node:'),treeshake:{moduleSideEffects:false}},lib:{entry:join(temp,'fixture.tsx'),name:'ConversationOverviewTabFixture',formats:['iife']}}})
 const bundle=Array.isArray(result)?result[0]:result;assert.ok(bundle&&'output'in bundle)
 script=bundle.output.find(item=>item.type==='chunk')!.code;styles=bundle.output.flatMap(item=>item.type==='asset'&&item.fileName.endsWith('.css')?[String(item.source)]:[]).join('\n')
 browser=await loadPlaywright().chromium.launch(launchOptions())
})
after(async()=>{await browser?.close();if(temp)await rm(temp,{recursive:true,force:true})})

test('概况注册成果交给同一完整预览，放大保持反馈并按原成果与版本保存',async t=>{
 const page=await pageFor(t)
 await page.evaluate(()=>{const f=(window as any).tabFixture,artifact=f.registered('main','完整成果');artifact.versions.push({...structuredClone(artifact.versions[0]),number:2,sections:[{id:'body',title:'正文',text:'已保存第二版'}]});f.configure({shared:true,artifactValues:{main:[artifact]}});f.mount('main');f.connect('disconnected');f.connect('connected')})
 const entry=page.getByRole('button',{name:'预览完整成果.md',exact:true}).first();await entry.click()
 await page.getByText('已保存第二版',{exact:true}).waitFor()
 assert.equal(await page.getByRole('dialog').count(),1)
 assert.ok(await page.getByRole('dialog').evaluate((element:HTMLElement)=>element.getBoundingClientRect().width)<=380)
 assert.deepEqual(await page.evaluate(()=>(window as any).tabFixture.calls.artifactTargets),[['main',{source:{kind:'session',id:'main'},artifact:{id:'12345678-1234-4234-8234-123456789012',version:2}}]])
 const download=page.getByRole('link',{name:'下载',exact:true});assert.equal(await download.getAttribute('download'),'teloa-12345678-1234-4234-8234-123456789012-v2.md')
 await page.getByRole('button',{name:'版本与反馈',exact:true}).click()
 const feedback=page.getByRole('textbox',{name:'反馈内容',exact:true});await feedback.fill('第二版原段落反馈')
 await page.getByRole('button',{name:'放大',exact:true}).click();assert.equal(await feedback.inputValue(),'第二版原段落反馈')
 await page.getByRole('button',{name:'收起',exact:true}).click();assert.equal(await feedback.inputValue(),'第二版原段落反馈')
 await page.locator('[data-artifact-close]').click();await entry.waitFor({state:'visible'})
 assert.equal(await entry.evaluate((element:HTMLElement)=>element===document.activeElement),true)
 await entry.click();await page.getByRole('button',{name:'版本与反馈',exact:true}).click();assert.equal(await feedback.inputValue(),'第二版原段落反馈')
 await page.getByRole('button',{name:'保存此版反馈',exact:true}).click();await settle(page)
 const changes=await page.evaluate(()=>(window as any).tabFixture.calls.artifactChanges)
 assert.equal(changes.length,1);assert.equal(changes[0].id,'12345678-1234-4234-8234-123456789012');assert.equal(changes[0].change.version,2);assert.equal(changes[0].change.sectionId,'body');assert.equal(changes[0].change.text,'第二版原段落反馈')
 assert.equal(await page.getByLabel('原任务输入').inputValue(),'保留的任务草稿')
})

test('概况中的注册成果文件打开原成果指定版本的文件与来源，不读取当前文件',async t=>{
 const page=await pageFor(t)
 await page.evaluate(async()=>{const f=(window as any).tabFixture,artifact=f.registered('main','含文件的原成果'),text='VERSION ONE SNAPSHOT';artifact.versions[0].files=[{schema:'teloa.file-snapshot/v1',sessionId:'main',id:'b'.repeat(64),path:'output/original.txt',sha256:await (window as any).fixtureSha(text),bytes:text.length,capturedAt:'2026-10-11T00:00:00Z',contentBase64:btoa(text)}];f.configure({shared:true,artifactValues:{main:[artifact]}});f.mount('main');f.connect('disconnected');f.connect('connected')})
 await page.getByRole('button',{name:'预览original.txt',exact:true}).click()
 await page.getByRole('button',{name:'文件与来源',exact:true}).waitFor()
 assert.equal(await page.getByRole('button',{name:'文件与来源',exact:true}).getAttribute('aria-current'),'page')
 assert.deepEqual(await page.evaluate(()=>(window as any).tabFixture.calls.artifactTargets),[['main',{source:{kind:'session',id:'main'},artifact:{id:'12345678-1234-4234-8234-123456789012',version:1},initialView:'files'}]])
 assert.deepEqual(await page.evaluate(()=>(window as any).tabFixture.calls.files),[])
 await page.locator('[data-artifact-close]').click()
 assert.equal(await page.getByLabel('原任务输入').inputValue(),'保留的任务草稿')
})

test('关联任务通过真实客户端API呈现固定版本，预览下载保留任务归属，切会话不提升版本',async t=>{
 const page=await pageFor(t)
 await page.evaluate(async()=>{
  const f=(window as any).tabFixture,artifactId='32345678-1234-4234-8234-123456789012',taskId='42345678-1234-4234-8234-123456789012'
  const source={kind:'task',id:taskId,scope:'general',version:'v1',title:'原任务'}
  const versions=[1,2,3].map(number=>({artifactId,ownerId:'owner',number,source,content:{title:'任务固定稿',sections:[{id:'body',title:'正文',text:'任务成果第 '+number+' 版'}],snapshotIds:[String(number).repeat(64)],note:'固定版本'},createdAt:'2026-10-17T00:00:00Z'}))
  const snapshots:Record<string,unknown>={}
  for(const number of [1,2]){const text='TASK SNAPSHOT '+number;snapshots[String(number).repeat(64)]={schema:'teloa.file-snapshot/v1',sessionId:'original-worker-chat',id:String(number).repeat(64),path:'output/task-result.txt',sha256:await (window as any).fixtureSha(text),bytes:text.length,capturedAt:'2026-10-17T00:00:00Z',contentBase64:btoa(text)}}
  f.configure({shared:true,taskValues:[{id:taskId,title:'原任务',scope:'general',version:1,updatedAt:'2026-10-17T00:00:00Z',assigneeId:'owner',evidence:[],state:'completed',storage:'persistent'}],nativeDirectory:{main:[versions[1]],other:[versions[0]]},nativeVersions:{[artifactId]:versions},nativeSnapshots:snapshots});f.mount('main');f.connect('disconnected');f.connect('connected')
 })
 const entry=page.getByRole('button',{name:'预览任务固定稿.md',exact:true}).first()
 await entry.click();await page.getByText('任务成果第 2 版',{exact:true}).waitFor()
 assert.deepEqual((await page.evaluate(()=>(window as any).tabFixture.calls.artifactTargets))[0],['main',{source:{kind:'task',id:'42345678-1234-4234-8234-123456789012'},artifact:{id:'32345678-1234-4234-8234-123456789012',version:2}}])
 assert.equal(await page.getByText('任务成果第 3 版',{exact:true}).count(),0)
 await page.locator('[data-artifact-close]').click()
 await page.getByRole('button',{name:'下载task-result.txt',exact:true}).first().click()
 await page.waitForFunction(()=>(window as any).tabFixture.calls.downloads.length===1)
 assert.equal((await page.evaluate(()=>(window as any).tabFixture.calls.downloads))[0].text,'TASK SNAPSHOT 2')
 await page.getByRole('button',{name:'预览task-result.txt',exact:true}).first().click()
 await page.getByRole('button',{name:'文件与来源',exact:true}).waitFor()
 const fileTarget=(await page.evaluate(()=>(window as any).tabFixture.calls.artifactTargets)).at(-1)
 assert.deepEqual(fileTarget,['main',{source:{kind:'task',id:'42345678-1234-4234-8234-123456789012'},artifact:{id:'32345678-1234-4234-8234-123456789012',version:2},initialView:'files'}])
 await page.locator('[data-artifact-close]').click()
 await page.evaluate(()=>(window as any).tabFixture.select('other'))
 await page.getByRole('button',{name:'预览任务固定稿.md',exact:true}).click()
 await page.getByText('任务成果第 1 版',{exact:true}).waitFor()
 assert.equal(await page.getByText('任务成果第 2 版',{exact:true}).count(),0)
 assert.equal((await page.evaluate(()=>(window as any).tabFixture.calls.artifactTargets)).at(-1)[0],'other')
 await page.locator('[data-artifact-close]').click()
 await page.getByRole('button',{name:'下载task-result.txt',exact:true}).click()
 await page.waitForFunction(()=>(window as any).tabFixture.calls.downloads.length===2)
 assert.deepEqual((await page.evaluate(()=>(window as any).tabFixture.calls.downloads)).map((row:any)=>row.text),['TASK SNAPSHOT 2','TASK SNAPSHOT 1'])
 assert.deepEqual(await page.evaluate(()=>(window as any).tabFixture.calls.files),[],'注册成果不能回退到当前会话的实时文件')
 const calls=await page.evaluate(()=>(window as any).tabFixture.calls.nativeArtifacts)
 assert.ok(calls.every(([method,payload]:any)=>['artifacts/conversation/list','artifacts/versions','artifacts/snapshot'].includes(method)&&(method!=='artifacts/snapshot'||payload.snapshotId!=='3'.repeat(64))))
 assert.equal(await page.getByLabel('原任务输入').inputValue(),'保留的任务草稿')
})

test('已打开的概览收到后台交办通知即重新读取成果，不依赖新一轮结束或网页刷新',async t=>{
 const page=await pageFor(t)
 await page.evaluate(()=>{const f=(window as any).tabFixture;f.configure({artifactValues:{main:[f.registered('main','后台任务初稿')]}});f.connect('disconnected');f.connect('connected')})
 await page.getByRole('button',{name:'预览后台任务初稿.md',exact:true}).waitFor()
 const before=await page.evaluate(()=>(window as any).tabFixture.calls.artifacts.length)
 await page.evaluate(()=>{const f=(window as any).tabFixture,artifact=f.registered('main','后台任务新版');artifact.versions.push({...structuredClone(artifact.versions[0]),number:2,sections:[{id:'body',title:'正文',text:'后台保存后的内容'}]});f.configure({artifactValues:{main:[artifact]}});f.notice('main')})
 await page.getByRole('button',{name:'预览后台任务新版.md',exact:true}).first().waitFor()
 assert.ok(await page.evaluate(()=>(window as any).tabFixture.calls.artifacts.length)>before)
 await page.getByRole('button',{name:'预览后台任务新版.md',exact:true}).first().click()
 await page.getByText('后台保存后的内容',{exact:true}).waitFor()
 assert.equal(await page.getByLabel('原任务输入').inputValue(),'保留的任务草稿')
})

async function pageFor(t:any,configuration:Record<string,unknown>={}){
 const page=await browser.newPage({viewport:{width:1100,height:760}}),errors:string[]=[],requests:string[]=[]
 page.setDefaultTimeout(8000);page.on('pageerror',(error:Error)=>errors.push(error.message));await page.route('**/*',(route:any)=>{requests.push(route.request().url());return route.abort()})
 await page.exposeFunction('fixtureSha',(text:string)=>createHash('sha256').update(text).digest('hex'))
 t.after(async()=>{await page.close();assert.deepEqual(errors,[]);assert.deepEqual(requests,[])})
 const fixtureURL='http://127.0.0.1/teloa-overview-fixture'
 await page.route(fixtureURL,(route:any)=>route.fulfill({contentType:'text/html',body:'<!doctype html><html lang="zh-CN"><body style="margin:0"><main id="root"></main></body></html>'}))
 await page.goto(fixtureURL)
 await page.addStyleTag({content:':root{--teloa-text:#18202b;--teloa-muted:#657080;--teloa-border:#dce1e8;--teloa-surface:#fff;--teloa-background:#fff;--teloa-subtle:#f5f6f8;--teloa-hover:#eef0f3;--teloa-focus:#2c6bed;--teloa-info:#2766c4;--teloa-good:#208045;--teloa-warn:#925b0b;--teloa-font-caption:12px;--teloa-font-control:13px;--teloa-font-body:14px;--teloa-font-section:16px;--teloa-weight-medium:500;--teloa-weight-heading:600;--teloa-leading-body:1.6;--teloa-leading-label:1.5}'+styles})
 await page.addScriptTag({content:script});await page.evaluate((value:any)=>{(window as any).tabFixture.configure(value);(window as any).tabFixture.mount()},configuration)
 await previewButton(page,'a').waitFor()
 return page
}
const previewButton=(page:any,name:string)=>page.getByRole('button',{name:'预览'+name+'.md',exact:true})
const backButton=(page:any)=>page.getByRole('button',{name:'返回工作概览',exact:true})
const settle=(page:any)=>page.evaluate(()=>(window as any).tabFixture.settle())
const fileCalls=(page:any,path:string)=>page.evaluate((path:string)=>(window as any).tabFixture.calls.files.filter((row:any)=>row[1]===path).length,path)
async function scrollTop(button:any){return button.evaluate((node:any)=>{let parent=node.parentElement;while(parent){if(/auto|scroll/.test(getComputedStyle(parent).overflowY)&&parent.scrollHeight>parent.clientHeight)return parent.scrollTop;parent=parent.parentElement}throw Error('未找到真实概览滚动区')})}

test('慢文件不覆盖后开的成果、命令记录或返回意图；切会话后旧文件及目录回包不串入新会话',async t=>{
 const page=await pageFor(t,{heldFiles:['a','c','e'].map(name=>'main:output/'+name+'.md')})
 await previewButton(page,'a').click();await page.waitForFunction(()=>(window as any).tabFixture.calls.files.some((row:any)=>row[1]==='output/a.md'))
 await previewButton(page,'b').click();await page.getByRole('heading',{name:'b.md',exact:true}).waitFor()
 await page.evaluate(()=>(window as any).tabFixture.resolveFile('main','output/a.md','# 迟到 A'));await settle(page)
 assert.equal(await page.getByRole('heading',{name:'b.md',exact:true}).isVisible(),true)
 assert.equal(await page.getByRole('heading',{name:'迟到 A',exact:true}).count(),0)
 await backButton(page).click()
 await previewButton(page,'c').click();await previewButton(page,'d').click();await backButton(page).waitFor();await backButton(page).click()
 await page.evaluate(()=>(window as any).tabFixture.resolveFile('main','output/c.md','# 迟到 C'));await settle(page)
 assert.equal(await backButton(page).count(),0,'返回使未完成的预览意图失效')
 await previewButton(page,'e').click();await page.getByRole('button',{name:'查看记录',exact:true}).click()
 await page.evaluate(()=>(window as any).tabFixture.resolveFile('main','output/e.md','# 迟到 E'));await settle(page)
 assert.equal(await page.locator('aside pre').innerText(),'真实命令记录 · main')
 assert.equal(await page.getByRole('heading',{name:'迟到 E',exact:true}).count(),0)
 await backButton(page).press('Escape')
 // 重读当前会话目录，故意把三类旧回包留到另一会话已展示之后。
 await page.evaluate(()=>{const f=(window as any).tabFixture;f.configure({heldFiles:['main:output/long.md'],artifactModes:{main:'hold'},resourceModes:{main:'hold'}});f.connect('disconnected');f.connect('connected')})
 await previewButton(page,'long').click();await page.waitForFunction(()=>(window as any).tabFixture.calls.files.some((row:any)=>row[1]==='output/long.md'))
 await page.evaluate(()=>{const f=(window as any).tabFixture;f.configure({artifactValues:{other:[f.registered('other','另一会话成果')]}});f.select('other')})
 await page.getByRole('button',{name:'预览另一会话成果.md',exact:true}).waitFor();await page.getByRole('button',{name:/另一实际工具/}).waitFor()
 await page.evaluate(async()=>{const f=(window as any).tabFixture;await f.resolve('artifacts','main',[f.registered('main','旧会话成果')]);await f.resolve('resources','main',[]);await f.resolveFile('main','output/long.md','# 旧会话迟到内容')});await settle(page)
 assert.equal(await page.getByRole('button',{name:'预览旧会话成果.md',exact:true}).count(),0)
 assert.equal(await page.getByRole('button',{name:/另一实际工具/}).isVisible(),true)
 assert.equal(await backButton(page).count(),0)
 assert.equal(await page.getByLabel('原任务输入').inputValue(),'保留的任务草稿')
 assert.ok((await page.evaluate(()=>(window as any).tabFixture.calls.release)).some((row:any)=>row[0]==='rows'&&row[1]==='main'))
})

test('同一交付并发预览与下载只读一次同字节；键盘返回保留输入、滚动与触发处焦点',async t=>{
 const page=await pageFor(t,{heldFiles:['main:output/long.md']}),trigger=previewButton(page,'long'),text='# 捕获正文\n\n这是预览与下载共用的字节。'
 await page.getByLabel('原任务输入').fill('用户继续输入的草稿')
 await trigger.scrollIntoViewIfNeeded();const before=await scrollTop(trigger);assert.ok(before>0)
 await trigger.press('Enter');await page.getByRole('button',{name:'下载long.md',exact:true}).click()
 assert.equal(await fileCalls(page,'output/long.md'),1)
 await page.evaluate((text:string)=>(window as any).tabFixture.resolveFile('main','output/long.md',text),text)
 await page.getByRole('heading',{name:'捕获正文',exact:true}).waitFor();await page.waitForFunction(()=>(window as any).tabFixture.calls.downloads.length===1)
 assert.equal((await page.evaluate(()=>(window as any).tabFixture.calls.downloads))[0].text,text)
 assert.equal(await backButton(page).evaluate((node:any)=>node===document.activeElement),true,'进入预览时焦点在可见返回入口')
 await page.keyboard.press('Escape')
 assert.equal(await trigger.evaluate((node:any)=>node===document.activeElement),true)
 assert.equal(await scrollTop(trigger),before)
 assert.equal(await page.getByLabel('原任务输入').inputValue(),'用户继续输入的草稿')
 await trigger.press('Enter');await backButton(page).waitFor();await page.getByRole('button',{name:'下载',exact:true}).click()
 await page.waitForFunction(()=>(window as any).tabFixture.calls.downloads.length===2)
 const downloaded=await page.evaluate(()=>(window as any).tabFixture.calls.downloads)
 assert.deepEqual(downloaded[1].bytes,downloaded[0].bytes);assert.equal(await fileCalls(page,'output/long.md'),1)
 await page.keyboard.press('Escape');assert.equal(await trigger.evaluate((node:any)=>node===document.activeElement),true)
})

test('成果成功不抹侧车失败；连接恢复与显式重试分别重读真实目录和侧车',async t=>{
 const page=await pageFor(t,{artifactModes:{main:'hold'},resourceModes:{main:'fail'}})
 const resourceMessage=await page.evaluate(()=>(window as any).tabFixture.copy('error.storageUnavailable'))
 await page.getByRole('alert').filter({hasText:resourceMessage}).waitFor()
 await page.evaluate(()=>(window as any).tabFixture.resolve('artifacts','main',[]));await settle(page)
 assert.equal(await page.getByRole('alert').filter({hasText:resourceMessage}).isVisible(),true,'成果目录完成不能消除独立侧车错误')
 await page.evaluate(()=>{const f=(window as any).tabFixture;f.configure({artifactModes:{main:'fail'}});f.connect('disconnected');f.connect('connected')})
 const artifactMessage=await page.evaluate(()=>(window as any).tabFixture.copy('error.sourceUnavailable'))
 await page.getByRole('alert').filter({hasText:artifactMessage}).waitFor()
 const failed=await page.evaluate(()=>(window as any).tabFixture.calls)
 await page.evaluate(()=>{const f=(window as any).tabFixture;f.configure({artifactModes:{main:'success'},artifactValues:{main:[f.registered('main','恢复的注册成果')]}});f.connect('disconnected');f.connect('connected')})
 await page.getByRole('button',{name:'预览恢复的注册成果.md',exact:true}).waitFor();await settle(page)
 assert.equal(await page.getByRole('alert').filter({hasText:resourceMessage}).isVisible(),true)
 assert.equal(await page.getByRole('alert').filter({hasText:artifactMessage}).count(),0)
 const restored=await page.evaluate(()=>(window as any).tabFixture.calls)
 assert.ok(restored.artifacts.length>failed.artifacts.length);assert.ok(restored.resources.length>failed.resources.length)
 await page.evaluate(()=>(window as any).tabFixture.configure({resourceModes:{main:'success'}}))
 await page.getByRole('button',{name:'重试',exact:true}).click()
 await page.getByRole('button',{name:/当前实际工具/}).waitFor();await settle(page)
 assert.equal(await page.getByRole('alert').count(),0)
 const retried=await page.evaluate(()=>(window as any).tabFixture.calls)
 assert.ok(retried.artifacts.length>restored.artifacts.length);assert.ok(retried.resources.length>restored.resources.length)
 assert.equal(await page.getByRole('button',{name:'预览恢复的注册成果.md',exact:true}).isVisible(),true)
 assert.equal(await page.getByLabel('原任务输入').inputValue(),'保留的任务草稿')
})
