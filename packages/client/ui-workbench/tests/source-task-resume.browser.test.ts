// @ts-expect-error 本机可信文档夹具为 MJS 模块。
import {setLocalDocument} from './fixtures/local-document.mjs'
import test,{before,after} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,writeFile,mkdir,rm} from 'node:fs/promises'
import {fileURLToPath} from 'node:url'
import {join} from 'node:path'
import {build} from 'vite'
// @ts-expect-error 既有测试浏览器夹具为无声明的 MJS 模块。
import {launchOptions,loadPlaywright} from './fixtures/load-playwright.mjs'
const root=fileURLToPath(new URL('../../../../',import.meta.url)),client=fileURLToPath(new URL('../src/client/',import.meta.url)),contract=fileURLToPath(new URL('../../../contract/src/index.ts',import.meta.url))
let browser:any,temp:string,script:string,styles:string
const entry=`
import React from 'react';import {createRoot} from 'react-dom/client';import {TaskExecutions} from '${client}TaskExecutions.tsx';import {createWorkControlApi} from '${client}work-control-api.ts';import {I18nProvider} from '${client}i18n/provider.tsx';import {translateMessage} from '${client}i18n/messages.ts';
const locale='zh-CN',snapshot={locale,dshLocale:'zh',revision:1},runtime={t:(key,params)=>translateMessage(locale,key,params),subscribe:()=>()=>{},getSnapshot:()=>snapshot},f=window.sourceResumeFixture={calls:[],taskState:'paused',taskVersion:6,stale:false},taskId='22222222-2222-4222-8222-222222222222',roleId='33333333-3333-4333-8333-333333333333',scope='business_source_resume',sid='task-run-original',stamp='2026-11-02T00:00:00Z';
const definition={id:'11111111-1111-4111-8111-111111111111',ownerId:'local:owner',generation:2,version:3,state:'paused',scope:'definition',pendingRunIds:[],unknownOperationIds:[]},round={...definition,id:'55555555-5555-4555-8555-555555555555',scope:'round',generation:1,version:1,state:'active'};
const row={id:'66666666-6666-4666-8666-666666666666',taskId,roleId,roleVersion:4,taskVersion:1,sessionId:sid,nativeRequestId:'77777777-7777-4777-8777-777777777777',state:'ended',evidence:{state:'ended',turn:1,messageSeq:8,endSeq:16,reason:'completed'},reason:'completed',stopRequestedAt:null,createdAt:stamp,goal:'按固定规则研判原告警',roleName:'原告警研判岗',skills:[],knowledge:[],lineage:{schema:'teloa.work-lineage/v1',ownerId:'local:owner',rootTaskId:taskId,definition:{planId:'88888888-8888-4888-8888-888888888888',definitionVersion:2,occurrenceId:'event:source'},parentRunId:null,definitionControlId:definition.id,roundControlId:round.id,controlGeneration:1,budgetAccountId:'99999999-9999-4999-8999-999999999999'},businessContext:{taskId,sourceId:'source/list_alerts',notice:'固定来源',object:{scope,type:'alert',id:'AL-01',version:1,snapshotHash:'a'.repeat(64),title:'AL-01',summary:'合成来源',fields:[],source:'本地记录',quality:'complete',observedAt:stamp,receivedAt:stamp}}};
const rows=[row,{...row,id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',state:'withdrawn',evidence:null,reason:undefined,taskVersion:4,nativeRequestId:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'}];
const api={readiness:async()=>undefined,origin:async()=>({taskId,source:null}),list:async()=>structuredClone(rows),pending:()=>undefined,recoveryMessage:()=>undefined,sourceFollowup:{pending:()=>undefined,recoveryError:()=>undefined},prepare:async()=>{f.calls.push({method:'FORBIDDEN_PREPARE'});throw Error('恢复不应创建Run')},start:async()=>{f.calls.push({method:'FORBIDDEN_START'});throw Error('恢复不应发送模型')}};
let journal=null;const controls=createWorkControlApi(async(method,payload)=>{f.calls.push({method,payload:structuredClone(payload)});if(method==='work-controls/get')return payload.controlId===definition.id?{...definition,...(f.stale?{version:4}:{})}:round;if(method==='work-recovery/inspect')return [];if(method==='work-recovery/resume'){f.taskState='ready';f.taskVersion++;definition.state='active';definition.version++;definition.generation++;return {...definition}}throw Error('未授权夹具调用 '+method)},{read:()=>journal,write:raw=>{journal=raw},clear:()=>{journal=null}},()=> 'cccccccc-cccc-4ccc-8ccc-cccccccccccc');
const app=createRoot(document.getElementById('root')),changed=()=>f.render();f.render=()=>app.render(<I18nProvider runtime={runtime}><TaskExecutions taskId={taskId} taskVersion={f.taskVersion} taskState={f.taskState} assigned api={api} controls={controls} changed={changed} open={async()=>{throw Error('不应另开会话')}}/></I18nProvider>);f.render();
`
before(async()=>{
 await mkdir(join(client,'../../.runtime'),{recursive:true});temp=await mkdtemp(join(client,'../../.runtime/source-task-resume-'));await writeFile(join(temp,'fixture.tsx'),entry)
 const result=await build({configFile:false,root,logLevel:'error',resolve:{alias:[{find:'@teloa/contract',replacement:contract}]},define:{'process.env.NODE_ENV':'"development"'},build:{write:false,minify:false,rollupOptions:{external:(id:string)=>id.startsWith('node:'),treeshake:{moduleSideEffects:false}},lib:{entry:join(temp,'fixture.tsx'),name:'SourceResumeFixture',formats:['iife']}}})
 const bundle=Array.isArray(result)?result[0]:result;assert.ok(bundle&&'output'in bundle);script=bundle.output.find(item=>item.type==='chunk')!.code
 styles=':root{--teloa-font-section:18px;--teloa-font-body:14px;--teloa-font-caption:12px;--teloa-font-control:14px;--teloa-weight-heading:600;--teloa-weight-medium:500;--teloa-leading-heading:1.4;--teloa-border:#ddd;--teloa-surface:#fff;--teloa-subtle:#f5f5f2;--teloa-text:#252823;--teloa-muted:#646a62;--teloa-accent:#9e4226;--teloa-primary:#252823;--teloa-on-primary:#fff}body{font-family:system-ui;margin:20px}'+bundle.output.flatMap(item=>item.type==='asset'&&item.fileName.endsWith('.css')?[String(item.source)]:[]).join('\n')
 browser=await loadPlaywright().chromium.launch(launchOptions())
})
for(const stale of [false,true])test('J07 原任务面板明确恢复、不新建Run；控制变化拒绝 '+stale,async()=>{
 if(process.env.TELOA_SOURCE_RESUME_SCREENSHOTS)await mkdir(process.env.TELOA_SOURCE_RESUME_SCREENSHOTS,{recursive:true});
 const page=await browser.newPage({viewport:{width:1280,height:1100}}),errors:string[]=[];page.setDefaultTimeout(7000);page.on('pageerror',(error:Error)=>errors.push(error.message));await page.route('**/*',(route:any)=>route.abort())
 try{
  await setLocalDocument(page,'<!doctype html><html lang="zh-CN"><style>'+styles+'</style><div id="root"></div><script>'+script.replace(/<\/script/gi,'<\\/script')+'</script></html>')
  const button=page.getByRole('button',{name:'继续接收来源更新',exact:true});await button.waitFor();await page.waitForFunction(()=>!(document.querySelector('[data-teloa-focus="resume"]') as HTMLButtonElement)?.disabled)
  const before=await page.evaluate(()=>(window as any).sourceResumeFixture.calls);assert.equal(before.some((x:any)=>x.method==='work-recovery/resume'),false)
  if(process.env.TELOA_SOURCE_RESUME_SCREENSHOTS){await mkdir(process.env.TELOA_SOURCE_RESUME_SCREENSHOTS,{recursive:true});await page.screenshot({path:join(process.env.TELOA_SOURCE_RESUME_SCREENSHOTS,'before-'+stale+'.png'),fullPage:true})}
  if(stale)await page.evaluate(()=>(window as any).sourceResumeFixture.stale=true)
  await button.click()
  if(stale)await page.getByRole('alert').waitFor();else await page.waitForFunction(()=>(window as any).sourceResumeFixture.taskState==='ready')
  const actual=await page.evaluate(()=>{const f=(window as any).sourceResumeFixture;return {taskState:f.taskState,taskVersion:f.taskVersion,mutations:f.calls.filter((x:any)=>!['work-controls/get','work-recovery/inspect'].includes(x.method))}})
  if(stale){assert.equal(actual.taskState,'paused');assert.deepEqual(actual.mutations,[])}else{assert.equal(actual.taskVersion,7);assert.equal(actual.mutations.length,1);assert.equal(actual.mutations[0].method,'work-recovery/resume');assert.equal(actual.mutations[0].payload.sourceTask.sessionId,'task-run-original');assert.deepEqual(actual.mutations[0].payload.candidateRunIds,[])}
  assert.deepEqual(errors,[]);if(process.env.TELOA_SOURCE_RESUME_SCREENSHOTS)await page.screenshot({path:join(process.env.TELOA_SOURCE_RESUME_SCREENSHOTS,'after-'+stale+'.png'),fullPage:true})
 }catch(error){if(process.env.TELOA_SOURCE_RESUME_SCREENSHOTS)await writeFile(join(process.env.TELOA_SOURCE_RESUME_SCREENSHOTS,'failed-'+stale+'.json'),JSON.stringify({errors,body:await page.locator('body').innerText()},null,2));throw error}finally{await page.close()}
})
after(async()=>{await browser?.close();if(temp)await rm(temp,{recursive:true,force:true})})
