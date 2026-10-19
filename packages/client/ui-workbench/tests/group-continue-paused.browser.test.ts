import test from 'node:test'
import assert from 'node:assert/strict'
import {fileURLToPath} from 'node:url'
import {build} from 'vite'
// @ts-expect-error 复用已固定的无头浏览器加载器。
import {launchOptions,loadPlaywright} from './fixtures/load-playwright.mjs'

test('续办被原任务暂停挡住：原消息下说明在等恢复并就地确认整项恢复；关闭不恢复、草稿保留，已停止的不给恢复；三语文案',{timeout:60000},async t=>{
 const root=fileURLToPath(new URL('../../../../',import.meta.url)),client=fileURLToPath(new URL('../src/client/',import.meta.url)),entryId=root+'__group_continue_paused.tsx',markdown='\0group-continue-paused-markdown',crypto='\0group-continue-paused-crypto'
 const entry=String.raw`import React from 'react';import {createRoot} from 'react-dom/client';import {flushSync} from 'react-dom';import {SavedCollaborationPage} from '${client}SavedCollaborationPage.tsx';import {createGroupApi} from '${client}group-api.ts';import {createGroupRoutingApi} from '${client}group-routing-api.ts';import {createGroupReactionApi} from '${client}group-reaction-api.ts';import {createWorkControlApi} from '${client}work-control-api.ts';import tokens from '${client}theme-tokens.module.css';import {prototypeThemes} from '${client}../brand/prototype-theme.ts';import {I18nProvider} from '${client}i18n/provider.tsx';import {translateMessage} from '${client}i18n/messages.ts';import {groupMessagePageFixture,groupMessageReadingFixture} from '${client}../../tests/fixtures/group-message-page-rpc.ts';
 const id=n=>'00000000-0000-4000-8000-'+String(n).padStart(12,'0'),at=n=>new Date(Date.UTC(2026,9,19,0,0,n)).toISOString(),ids={group:id(1),role:id(3),task:id(4),run:id(5),paused:id(10),ended:id(11),stuck:id(12),pausedControl:id(20),endedControl:id(21),stuckControl:id(22),stuckRun:id(30),stuckRequest:id(31)};
 const f=window.fixture={ids,calls:[],resumed:false,opened:[],snapshot:{locale:'zh-CN',dshLocale:'zh-CN',revision:1},render:()=>{}};
 document.body.style.margin='0';for(const [name,value] of Object.entries(prototypeThemes.light))document.body.style.setProperty(name,value);document.getElementById('root').style.height='100dvh';
 const group={id:ids.group,ownerId:'self',version:1,name:'安全运营群',scope:'general',announcement:'',rules:{historyVisibleToNewMembers:true,draftsVisibleInGroup:true,mentionAllAllowed:true},pinned:false,archived:false,createdAt:at(0),updatedAt:at(0)};
 const own=(key,n,text)=>({id:key,groupId:ids.group,rootId:null,authorId:'self',text,references:[],mentions:[],createdAt:at(n)}),rows=[own(ids.ended,1,'继续另一项已停止的工作'),own(ids.paused,2,'质量退回，继续原任务'),own(ids.stuck,3,'继续仍在执行的原工作')];
 const recipient=phase=>({roleId:ids.role,name:'T2 调查员',taskId:ids.task,runId:null,phase,resultMessageId:null,executionMode:'work'});
 const statusOf=messageId=>messageId===ids.paused?(f.resumed?{messageId,attemptVersion:1,phase:'running',recipients:[{...recipient('running'),runId:ids.run}],hintCode:null,canRetry:false}:{messageId,attemptVersion:1,phase:'paused',recipients:[recipient('paused')],hintCode:'continue-paused',canRetry:false,controlId:ids.pausedControl}):{messageId,attemptVersion:1,phase:'paused',recipients:[recipient('paused')],hintCode:'continue-paused',canRetry:false,controlId:messageId===ids.stuck?ids.stuckControl:ids.endedControl};
 const control=(controlId,state,version)=>({id:controlId,ownerId:'self',generation:3,version,state,scope:'round',pendingRunIds:[],unknownOperationIds:[]});
 const call=async(endpoint,input)=>{f.calls.push([endpoint,input]);
  if(endpoint==='groups/get')return {group,members:[{groupId:ids.group,roleId:null,createdAt:at(0)},{groupId:ids.group,roleId:ids.role,createdAt:at(0)}]};
  if(endpoint==='groups/messages/list')return rows;if(endpoint==='groups/messages/page')return groupMessagePageFixture(rows,input);
  if(endpoint==='groups/reading/get'||endpoint==='groups/reading/mark')return groupMessageReadingFixture(endpoint,input,f.cursors||(f.cursors={}));
  if(endpoint==='groups/attention')return {schema:'teloa.group-attention/v1',items:[]};
  if(endpoint==='groups/resources/list')return [];if(endpoint==='groups/agent-grants/get')return {groupVersion:1,roleVersion:1,grant:null,status:'not-granted'};
  if(endpoint==='groups/reactions/list'||endpoint==='groups/routing/list')return {items:[]};
  if(endpoint==='groups/routing/status')return {items:input.messageIds.filter(messageId=>[ids.paused,ids.ended,ids.stuck].includes(messageId)).map(statusOf)};
  if(endpoint==='work-controls/get'&&input.controlId===ids.stuckControl)return control(ids.stuckControl,'paused',4);
  if(endpoint==='work-recovery/inspect'&&input.controlId===ids.stuckControl)return [{controlId:ids.stuckControl,expectedGeneration:3,runId:ids.stuckRun,nativeRequestId:ids.stuckRequest,goal:null,reason:'accepted',safeRecovery:false,resumable:false}];
  if(endpoint==='work-controls/get')return input.controlId===ids.endedControl?control(ids.endedControl,'stopped',5):control(ids.pausedControl,f.resumed?'active':'paused',f.resumed?10:9);
  if(endpoint==='work-recovery/inspect')return [];
  if(endpoint==='work-recovery/resume'){if(f.dropNext){f.dropNext=false;throw Error('连接中断')}f.resumed=true;return control(ids.pausedControl,'active',10)}
  throw Error('不应调用：'+endpoint)};
 const api=createGroupApi(call),routing=createGroupRoutingApi(call),reactions=createGroupReactionApi(call),controls=createWorkControlApi(call,window.brokenControlJournal?{read:()=>'{broken',write:()=>{},clear:()=>{f.cleared=(f.cleared||0)+1}}:undefined),roles=[{id:ids.role,name:'T2 调查员',kind:'employee',state:'active',scopes:['general'],version:1,duty:'调查',dataScope:'授权日志',executionScope:'只读',skills:[],knowledge:[],memories:[],history:[]}];
 const work={tasks:[{id:ids.task,storage:'persistent',title:'E03 T2 深度调查',groupId:ids.group,state:'blocked',assigneeId:ids.role,need:null,source:{groupId:ids.group,messageId:ids.paused,rootId:ids.paused,text:'原工作'}}],openTask:taskId=>f.opened.push(taskId),openRole:()=>{},controls};
 const listeners=new Set(),runtime={getSnapshot:()=>f.snapshot,subscribe:listener=>{listeners.add(listener);return()=>listeners.delete(listener)},t:(key,params)=>translateMessage(f.snapshot.locale,key,params)},app=createRoot(document.getElementById('root'));
 f.setLocale=locale=>{f.snapshot={locale,dshLocale:locale,revision:f.snapshot.revision+1};flushSync(()=>listeners.forEach(listener=>listener()))};
 f.render=()=>flushSync(()=>app.render(<I18nProvider runtime={runtime}><div className={tokens.tokens} style={{height:"100%",background:"var(--teloa-background)",color:"var(--teloa-text)",font:"var(--teloa-design-text-base) var(--teloa-design-font)"}}><SavedCollaborationPage api={api} routing={routing} reactions={reactions} work={work} visible={true} target={{groupId:ids.group,rootId:''}} roles={roles} profileName="Max" directory={{refresh:async()=>{},open:()=>{},select:()=>{},createRequest:0,createHandled:()=>{}}}/></div></I18nProvider>));f.render();`
 const result=await build({configFile:false,root,logLevel:'error',resolve:{alias:[{find:'@deepseek-ai/dsh-client-ui-primitives',replacement:markdown},{find:'node:crypto',replacement:crypto}]},plugins:[{name:'group-continue-paused',resolveId:id=>id.endsWith('group-continue-paused-test')?entryId:[markdown,crypto].includes(id)?id:null,load:id=>id===entryId?entry:id===markdown?'export const MarkdownText=({text})=>text':id===crypto?'export function createHash(){throw Error("不应执行服务器摘要")};export function randomUUID(){return crypto.randomUUID()};export function createPublicKey(){throw Error("不应执行签名")};export function verify(){throw Error("不应执行签名")}':null}],define:{'process.env.NODE_ENV':'"development"'},build:{write:false,minify:false,lib:{entry:'group-continue-paused-test',name:'GroupContinuePausedTest',formats:['iife']}}})
 const bundle=Array.isArray(result)?result[0]:result;assert.ok(bundle&&'output'in bundle)
 const browser=await loadPlaywright().chromium.launch(launchOptions());t.after(()=>browser.close())
 const page=await browser.newPage({viewport:{width:1440,height:960}});t.after(()=>page.close());page.setDefaultTimeout(6000)
 const errors:string[]=[];page.on('pageerror',(error:Error)=>errors.push(error.message));await page.route('**/*',(route:any)=>route.abort())
 await page.route('http://127.0.0.1:49321/group-continue-paused-test',(route:any)=>route.fulfill({status:200,contentType:'text/html',body:'<html lang="zh-CN"><body><div id="root"></div></body></html>'}))
 const mount=async(brokenControlJournal=false)=>{await page.goto('http://127.0.0.1:49321/group-continue-paused-test');if(brokenControlJournal)await page.evaluate(()=>{(window as any).brokenControlJournal=true});await page.addStyleTag({content:bundle.output.flatMap(item=>item.type==='asset'&&item.fileName.endsWith('.css')?[String(item.source)]:[]).join('\n')});await page.addScriptTag({content:bundle.output.find(item=>item.type==='chunk')!.code})}
 await mount()
 const ids=await page.evaluate(()=>(window as any).fixture.ids),calls=(endpoint:string)=>page.evaluate((name:string)=>(window as any).fixture.calls.filter(([e]:any)=>e===name).length,endpoint)
 const main=page.getByRole('region',{name:'讨论',exact:true}),draft=main.getByRole('textbox'),status=(messageId:string)=>page.locator('[data-teloa-message-id="'+messageId+'"] + [role="status"]'),paused=status(ids.paused),ended=status(ids.ended),stuck=status(ids.stuck)
 const hint='原工作已暂停，你的继续要求已保存，恢复原工作后会按它继续。'
 await paused.getByText(hint,{exact:true}).waitFor()
 assert.equal(await paused.getByText('已暂停',{exact:true}).count(),1,'不再只显示「排队」')
 assert.equal(await calls('work-recovery/resume'),0,'只读状态，不静默恢复')
 await page.screenshot({path:'/tmp/gcp-link/group-continue-paused-status.png'})
 // 草稿在打开与关闭抽屉后保留；Escape 关闭不恢复。
 await draft.fill('补充：请先核对 ja4h 字段')
 await paused.getByRole('button',{name:'恢复原工作',exact:true}).click()
 const drawer=page.getByRole('dialog',{name:'恢复原工作'})
 await drawer.getByText('恢复时会重新核对负责员工的角色、授权和工作额度，不会扩大原有授权。恢复后，原工作会按你的继续要求接着做。',{exact:true}).waitFor()
 assert.equal(await calls('work-recovery/inspect'),1,'打开只核对候选');assert.equal(await calls('work-recovery/resume'),0)
 await page.screenshot({path:'/tmp/gcp-link/group-continue-paused-drawer.png'})
 await page.keyboard.press('Escape');await drawer.waitFor({state:'hidden'})
 assert.equal(await calls('work-recovery/resume'),0,'关闭不恢复');assert.equal(await draft.inputValue(),'补充：请先核对 ja4h 字段')
 // 再次打开并明确确认：先重读控制与候选，再按原版本提交整项恢复。首次提交结果未知（连接中断）时，
 // 抽屉就地给出按原请求核对，不另发新请求，也不把本人引到没有核对入口的页面；核对成功后状态随即刷新。
 await page.evaluate(()=>{(window as any).fixture.dropNext=true})
 await paused.getByRole('button',{name:'恢复原工作',exact:true}).click()
 await drawer.getByRole('button',{name:'确认恢复',exact:true}).click()
 await drawer.getByText('上次恢复请求的结果还未确认。核对原请求即可，不会重新发起恢复。',{exact:true}).waitFor()
 assert.equal(await drawer.getByRole('button',{name:'确认恢复'}).count(),0,'结果未知时不能再发新的恢复')
 await drawer.getByRole('button',{name:'核对恢复结果',exact:true}).click()
 await drawer.waitFor({state:'hidden'})
 const resume=await page.evaluate(()=>(window as any).fixture.calls.filter(([e]:any)=>e==='work-recovery/resume').map(([,input]:any)=>input))
 assert.equal(resume.length,2);assert.deepEqual(resume[1],resume[0],'核对沿用原请求身份与内容')
 assert.deepEqual({controlId:resume[0].controlId,expectedVersion:resume[0].expectedVersion,candidateRunIds:resume[0].candidateRunIds},{controlId:ids.pausedControl,expectedVersion:9,candidateRunIds:[]})
 await paused.getByText(hint,{exact:true}).waitFor({state:'hidden'})
 assert.equal(await main.getByRole('button',{name:'恢复原工作',exact:true}).count(),2,'只剩另外两条仍被暂停挡住的消息')
 assert.equal(await draft.inputValue(),'补充：请先核对 ja4h 字段')
 // 状态过期而控制已停止：抽屉如实说明不能恢复，只给查看工作，不给确认按钮。
 await ended.getByRole('button',{name:'恢复原工作',exact:true}).click()
 await drawer.getByText('原工作已停止，不能恢复。如需继续，请重新交办。',{exact:true}).waitFor()
 assert.equal(await drawer.getByRole('button',{name:'确认恢复'}).count(),0)
 await drawer.getByRole('button',{name:'查看工作',exact:true}).click();await drawer.waitFor({state:'hidden'})
 assert.deepEqual(await page.evaluate(()=>(window as any).fixture.opened),[ids.task]);assert.equal(await calls('work-recovery/resume'),2,'已停止的控制不复活')
 // 服务端判定不会接受的候选（已受理却没有可接续的内容）：如实说明先停止那次执行，不给必然失败的确认按钮。
 await stuck.getByRole('button',{name:'恢复原工作',exact:true}).click()
 await drawer.getByText('原工作里有一次执行已开始但没有可接续的内容，不能直接恢复。请先在工作详情中停止这次执行，再回来恢复。',{exact:true}).waitFor()
 assert.equal(await drawer.getByRole('button',{name:'确认恢复'}).count(),0)
 await page.keyboard.press('Escape');await drawer.waitFor({state:'hidden'})
 assert.equal(await calls('work-recovery/resume'),2)
 // 定稿三语：繁体与英文同一状态的说明与动作。
 await page.evaluate(()=>(window as any).fixture.setLocale('zh-TW'))
 await ended.getByText('原工作已暫停，你的繼續要求已儲存，恢復原工作後會依此繼續。',{exact:true}).waitFor()
 await ended.getByRole('button',{name:'恢復原工作',exact:true}).waitFor()
 await page.evaluate(()=>(window as any).fixture.setLocale('en'))
 await ended.getByText('The original work is paused. Your follow-up is saved and will continue once you resume the work.',{exact:true}).waitFor()
 await ended.getByRole('button',{name:'Resume work',exact:true}).waitFor()
 // 本机控制恢复记录损坏：抽屉就地说明并给出丢弃出路；丢弃只清本机记录后重新核对，不恢复、不派发。
 await mount(true)
 await ended.getByRole('button',{name:'恢复原工作',exact:true}).click()
 await drawer.getByRole('alert').waitFor();assert.match(await drawer.getByRole('alert').innerText(),/可丢弃这条恢复记录后重试/)
 assert.equal(await drawer.getByRole('button',{name:'确认恢复'}).count(),0)
 await drawer.getByRole('button',{name:'丢弃这条恢复记录',exact:true}).click()
 await drawer.getByText('已丢弃本地恢复记录；如果上一次请求已经生效，请到目录里核对。',{exact:true}).waitFor()
 await drawer.getByText('原工作已停止，不能恢复。如需继续，请重新交办。',{exact:true}).waitFor()
 assert.equal(await page.evaluate(()=>(window as any).fixture.cleared),1,'丢弃只清本机恢复记录一次');assert.equal(await calls('work-recovery/resume'),0,'丢弃不恢复')
 assert.deepEqual(errors,[])
})
