import {test,before,after,type TestContext} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,writeFile,rm} from 'node:fs/promises'
import {fileURLToPath} from 'node:url'
import {join} from 'node:path'
import {createHash} from 'node:crypto'
import {build} from 'vite'
import {pageCreateCanonicalBody,pageCreateFieldRows,readPageCreatePlanDraft} from '@teloa/contract'
// @ts-expect-error 复用已有无头浏览器加载器。
import {loadPlaywright,launchOptions} from './fixtures/load-playwright.mjs'
const root=fileURLToPath(new URL('../../../../',import.meta.url)),client=fileURLToPath(new URL('../src/client/',import.meta.url))
const id='10000000-0000-4000-8000-000000000001',sourceId='20000000-0000-4000-8000-000000000001'
const schedule={kind:'schedule',cadence:'daily',weekday:1,time:'11:00',timezone:'Asia/Singapore'}
const work={completion:{kind:'manual'},triggers:[{kind:'schedule',schedule}],budget:{maxGoalRounds:4,maxTokens:10000,maxElapsedMs:600000,maxConcurrent:1,maxRetries:2,stagnationRounds:3,money:null},overlap:'forbid',missed:'coalesce',safeRecovery:false}
const definition={title:'每日资料核对',goal:'# 本次目标\n核对原始资料，未知项单列。',scope:'general',dataScope:'仅本人已选择的资料',delivery:'带来源的摘要与待确认项',trigger:schedule,notificationPolicy:'attention'}
const cases={
 owner:{definition:{...definition,executor:{kind:'owner'},roleId:null},work,intent:'save-paused',source:{artifactId:sourceId,version:2,basisHash:'e'.repeat(64)}},
 role:{definition:{...definition,scope:'SOC',roleId:sourceId,expectedRoleVersion:3,groupId:'30000000-0000-4000-8000-000000000001'},work:{...work,triggers:[...work.triggers,{kind:'local-event',eventKind:'business-object-version',sourceRef:{kind:'business-object',scope:'SOC',type:'lead',id:'business-record-private'},coalesce:'latest'}]},intent:'create-and-enable',source:{artifactId:sourceId,version:2,basisHash:'e'.repeat(64)}},
 configure:{kind:'configure-work',planId:sourceId,expectedVersion:3,expectedConfigVersion:2,work,intent:'save-paused'},
}
const referencePeer={...cases.role,definition:{...cases.role.definition,scope:'APP',roleId:'20000000-0000-4000-8000-000000000002',groupId:'30000000-0000-4000-8000-000000000002'},work:{...cases.role.work,triggers:[{kind:'local-event',eventKind:'business-object-version',sourceRef:{kind:'business-object',scope:'APP',type:'lead',id:'business-record-peer'},coalesce:'latest'},{kind:'local-event',eventKind:'material-version',sourceId:'40000000-0000-4000-8000-000000000002',coalesce:'none'}]}}
const fixtureCases={...cases,rolePeer:referencePeer}
const previews=Object.fromEntries(Object.entries(fixtureCases).map(([kind,value])=>{
 const body=pageCreateCanonicalBody(readPageCreatePlanDraft(value)),bodyHash=createHash('sha256').update(body).digest('hex')
 const draft={id,ownerId:'local:teloa-owner',requestId:id,entity:'plan',body,bodyHash,title:'每日资料核对',status:'draft',createdAt:'2026-10-17T00:00:00.000Z',updatedAt:'2026-10-17T00:00:00.000Z'}
 const fields=pageCreateFieldRows(JSON.parse(body));assert.ok(fields.length>15)
 return [kind,{schema:'teloa.page-create-draft-preview/v1',draft,fields,fieldsTruncated:false,consequences:kind==='role'||kind==='rolePeer'?[{kind:'impact',id:'plan-create-and-enable',required:true},{kind:'permission',id:'plan-execution-authorization',required:true}]:[{kind:'impact',id:'plan-save-paused',required:true}],next:{endpoint:kind==='configure'?'plans/configure-work-confirmed':kind==='owner'?'plans/create-owner-confirmed':'plans/create-confirmed',consentKeys:kind==='role'||kind==='rolePeer'?['create.consequence.permission']:[]},computedAt:draft.createdAt}]
}))
let browser:any,script:string,styles:string,temp:string
before(async()=>{
 const entry=`
import React,{useState} from 'react';import {createRoot} from 'react-dom/client';
import {CreateEntry} from '${client}CreateEntry.tsx';import {ContextDrawer} from '${client}ContextDrawer.tsx';
import {createPageCreateApi} from '${client}page-create-api.ts';import {planDraftConfirmLabel} from '${client}plan-draft-api.ts';
import {I18nProvider} from '${client}i18n/provider.tsx';import {translateMessage} from '${client}i18n/messages.ts';
const fixtures=${JSON.stringify(previews)},preview=fixtures[window.previewCase||'owner'],calls=window.previewCalls=[],snap={locale:document.documentElement.lang,dshLocale:'zh-CN',revision:1},runtime={getSnapshot:()=>snap,subscribe:()=>()=>{},t:(key,args)=>translateMessage(snap.locale,key,args)};
const api=createPageCreateApi(async(endpoint,input)=>{calls.push([endpoint,input]);if(endpoint==='page-create-drafts/preview')return preview;if(endpoint==='page-create-drafts/directory')return {schema:'teloa.page-create-drafts/v1',entity:'plan',readAt:preview.computedAt,drafts:[preview.draft]};if(endpoint==='page-create-drafts/settle')return {schema:'teloa.page-create-drafts/v1',entity:'plan',readAt:preview.computedAt,drafts:[]};throw Error(endpoint)});
function Probe(){const [open,setOpen]=useState(true);return open?<ContextDrawer title="原计划草案" close={()=>setOpen(false)}><CreateEntry entity="plan" api={api} embedded hideSentence focusDraft={{draftId:preview.draft.id,bodyHash:preview.draft.bodyHash}} prepare={()=>{throw Error('不能自动执行')}} confirmLabelKey={planDraftConfirmLabel} onConfirm={value=>{calls.push(['confirmed',value.draft]);return '${sourceId}'}}/></ContextDrawer>:<button onClick={()=>setOpen(true)}>重新打开</button>}
createRoot(document.getElementById('root')).render(<I18nProvider runtime={runtime}><Probe/></I18nProvider>);
`
 temp=await mkdtemp(join(root,'.runtime-plan-preview-'));await writeFile(join(temp,'fixture.tsx'),entry)
 const result=await build({configFile:false,root,logLevel:'error',define:{'process.env.NODE_ENV':'"development"'},build:{write:false,minify:false,rollupOptions:{external:(id:string)=>id.startsWith('node:')},lib:{entry:join(temp,'fixture.tsx'),formats:['iife'],name:'PlanPreview'}}})
 const output=(Array.isArray(result)?result[0]:result);assert.ok(output&&'output'in output)
 script=output.output.find(item=>item.type==='chunk')!.code;styles=output.output.flatMap(item=>item.type==='asset'&&item.fileName.endsWith('.css')?[String(item.source)]:[]).join('\n')
 browser=await loadPlaywright().chromium.launch(launchOptions())
})
after(async()=>{await browser?.close();if(temp)await rm(temp,{recursive:true,force:true})})
async function mount(t:TestContext,kind:keyof typeof fixtureCases){
 const page=await browser.newPage({viewport:{width:1440,height:1000}});page.setDefaultTimeout(2500)
 const errors:string[]=[];page.on('pageerror',(error:Error)=>errors.push(error.message));t.after(async()=>{await page.close();assert.deepEqual(errors,[])})
 await page.route('**/*',(route:any)=>route.request().isNavigationRequest()?route.fulfill({contentType:'text/html',body:'<html lang="zh-CN"><body><div id="root"></div></body></html>'}):route.abort())
 await page.goto('https://fixture.invalid');await page.evaluate((value:string)=>(window as any).previewCase=value,kind)
 await page.addStyleTag({content:'*{box-sizing:border-box}body{font:14px system-ui}'+styles});await page.addScriptTag({content:script})
 const dialog=page.getByRole('dialog');await dialog.getByRole('button',{name:kind==='role'||kind==='rolePeer'?'保存并启用':kind==='configure'?'保存配置':'保存计划',exact:true}).waitFor()
 return {page,dialog}
}
for(const kind of ['owner','role','configure'] as const)test(kind+' 正式完整plan字段回包使用紧凑可读预览，保真实额度和权限，关闭零写',async t=>{
 const {page,dialog}=await mount(t,kind)
 const content=await dialog.innerText()
 assert.doesNotMatch(content,/definition\.|work\.budget|source\.basisHash|plan-save-paused|plan-create-and-enable|plan-execution-authorization|20000000-0000|business-record-private/)
 assert.match(content,kind==='owner'?/本人通用 Agent/:kind==='role'?/已选员工/:/沿用原计划负责人/)
 assert.match(content,/累计额度/);assert.match(content,/10000/);assert.match(content,/4/);assert.match(content,/10 分钟/);assert.match(content,/2 次/);assert.match(content,/3 轮/)
 if(kind!=='configure'){assert.match(content,/核对原始资料，未知项单列/);assert.match(content,/仅本人已选择的资料/);assert.match(content,/带来源的摘要与待确认项/)}
 else assert.match(content,/沿用原计划目标/)
 assert.match(content,/11:00/);assert.match(content,/Asia\/Singapore/)
 if(kind==='role'){assert.match(content,/业务记录更新/);assert.match(content,/有效委托/);assert.match(content,/启用/)}
 else if(kind==='owner')assert.match(content,/暂停/)
 else assert.doesNotMatch(content,/保存后暂停/)
 await page.keyboard.press('Escape');await dialog.waitFor({state:'hidden'})
 assert.deepEqual(await page.evaluate(()=>(window as any).previewCalls.filter((row:any)=>row[0]==='confirmed'||row[0]==='page-create-drafts/settle')),[])
})
test('计划可读投影不改变采用时的原body/hash或真实plan appliedRef',async t=>{
 const {page,dialog}=await mount(t,'owner')
 await dialog.getByRole('button',{name:'保存计划',exact:true}).click()
 await page.waitForFunction(()=>(window as any).previewCalls.some((row:any)=>row[0]==='page-create-drafts/settle'))
 const calls=await page.evaluate(()=>(window as any).previewCalls)
 assert.deepEqual(calls.find((row:any)=>row[0]==='confirmed')[1],(previews.owner as any).draft)
 assert.deepEqual(calls.find((row:any)=>row[0]==='page-create-drafts/settle')[1].expectedBodyHash,(previews.owner as any).draft.bodyHash)
 assert.equal(calls.find((row:any)=>row[0]==='page-create-drafts/settle')[1].appliedRef,sourceId)
})

test('两份只换员工业务群与监听对象的正式草案，可展开核对各自固定引用，关闭均零写',async t=>{
 const snapshots:string[]=[]
 for(const kind of ['role','rolePeer'] as const){
  const {page,dialog}=await mount(t,kind),expected=fixtureCases[kind]
  assert.equal(await dialog.locator('dl').first().locator(':scope > div').count(),8)
  const main=await dialog.locator('dl').first().innerText()
  assert.match(main,new RegExp(expected.definition.scope))
  assert.doesNotMatch(main,/20000000-0000|30000000-0000|business-record/)
  await dialog.locator('summary',{hasText:'核对对象'}).click()
  const references=dialog.locator('details').filter({has:page.locator('summary',{hasText:'核对对象'})}).last()
  const text=await references.innerText();snapshots.push(text)
  assert.ok(text.includes(expected.definition.roleId))
  assert.ok(text.includes(expected.definition.groupId))
  assert.ok(text.includes(kind==='role'?'business-record-private':'business-record-peer'))
  if(kind==='rolePeer')assert.ok(text.includes('40000000-0000-4000-8000-000000000002'),'原UUID来源与复合业务来源均保真')
  assert.ok(text.includes(sourceId),'原方法成果引用保留')
  assert.ok(text.includes('e'.repeat(64)),'原方法来源摘要只在按需核对内可读')
  await page.keyboard.press('Escape');await dialog.waitFor({state:'hidden'})
  assert.deepEqual(await page.evaluate(()=>(window as any).previewCalls.filter((row:any)=>row[0]==='confirmed'||row[0]==='page-create-drafts/settle')),[])
 }
 assert.notEqual(snapshots[0],snapshots[1])
})
