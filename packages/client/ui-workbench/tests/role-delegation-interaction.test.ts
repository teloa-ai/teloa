import test,{before,after} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises'
import {fileURLToPath} from 'node:url'
import {join} from 'node:path'
import {build} from 'vite'
// @ts-expect-error 既有无头浏览器夹具为 MJS 模块。
import {launchOptions,loadPlaywright} from './fixtures/load-playwright.mjs'
const root=fileURLToPath(new URL('../../../../',import.meta.url)),client=fileURLToPath(new URL('../src/client/',import.meta.url))
let browser:any,script:string,temp:string
const entry=`
import React from 'react';import {createRoot} from 'react-dom/client';
import {RoleDelegation} from '${client}RoleDelegation.tsx';import {createRoleDelegationApi} from '${client}role-delegation-api.ts';
import {I18nProvider} from '${client}i18n/provider.tsx';import {translateMessage} from '${client}i18n/messages.ts';
let sequence=100;if(!crypto.randomUUID)crypto.randomUUID=()=> '00000000-0000-4000-8000-'+String(++sequence).padStart(12,'0');
const roleId='11111111-1111-4111-8111-111111111111',delegationId='22222222-2222-4222-8222-222222222222';
const fields={scope:'general',allowedTools:['read'],knowledgeIds:[],memoryViewId:null,groupIds:[],safeRecovery:false};
const role={id:roleId,version:2,kind:'twin',state:'active',name:'我的分身',scopes:['general'],knowledge:[],skills:[],storage:'persistent'};
const snapshot={locale:'zh-CN',dshLocale:'zh',revision:1},runtime={t:(key,params)=>translateMessage('zh-CN',key,params),subscribe:()=>()=>{},getSnapshot:()=>snapshot};
const f=window.delegationFixture={calls:[],receipts:new Map(),raw:null,lost:false,reject:false,delegations:[],version:2};
const record=(version,state='active',roleVersion=2)=>({id:roleVersion===1?delegationId:'33333333-3333-4333-8333-333333333333',ownerId:'owner',roleId,roleVersion,version,state,...fields,createdAt:'2026-10-09T00:00:00.000Z',updatedAt:'2026-10-09T00:00:00.000Z'});
const call=async(endpoint,input)=>{
 f.calls.push({endpoint,input});
 if(endpoint==='role-delegations/get')return {roleId,roleVersion:f.version,delegations:f.delegations,consents:[],canEditExecution:true};
 if(endpoint!=='role-delegations/change')throw Error('不得自动确认执行');
 if(f.reject){f.reject=false;throw Object.assign(Error('先暂停活跃委托'),{rejected:true,code:'teloa/conflict'});}
 const receipt=f.receipts.get(input.requestId)??{...record((input.expectedVersion??0)+1,input.action==='pause'?'paused':input.action==='end'?'ended':'active',input.expectedRoleVersion),...(input.fields??{})};
 f.receipts.set(input.requestId,receipt);f.delegations=[...f.delegations.filter(row=>row.roleVersion!==receipt.roleVersion),receipt];
 if(f.lost){f.lost=false;throw Error('回执未知');}return receipt;
};
const journal={read:()=>f.raw,write:value=>{f.raw=value},clear:()=>{f.raw=null}};
let api=createRoleDelegationApi(call,journal);const app=createRoot(document.getElementById('root'));
f.render=()=>app.render(<I18nProvider runtime={runtime}><RoleDelegation role={role} api={api} resources={{directory:async()=>({resources:[]})}} toolGrants={{get:async()=>({roleVersion:2,grant:{roleVersion:2,state:'active',rules:[{name:'read'}]}})}}/></I18nProvider>);
f.setup=mode=>{f.delegations=mode==='bumped'?[record(4,'ended',1)]:[record(1)];f.render();};
f.rejectedSave=async()=>{f.reject=true;try{await api.change({requestId:crypto.randomUUID(),roleId,expectedRoleVersion:2,expectedVersion:1,action:'save',fields});}catch{}f.render();};
f.unknownSave=async()=>{f.lost=true;try{await api.change({requestId:crypto.randomUUID(),roleId,expectedRoleVersion:2,expectedVersion:f.delegations.find(row=>row.roleVersion===2).version,action:'save',fields});}catch{}api=createRoleDelegationApi(call,journal);f.render();};
f.pending=()=>api.pending();f.fields=fields;f.setup(window.testMode);
`
before(async()=>{
 await mkdir(join(client,'../../.runtime'),{recursive:true});temp=await mkdtemp(join(client,'../../.runtime/role-delegation-ui-'));await writeFile(join(temp,'fixture.tsx'),entry)
 const result=await build({configFile:false,root,logLevel:'error',define:{'process.env.NODE_ENV':'"development"'},build:{write:false,minify:false,rollupOptions:{external:(id:string)=>id.startsWith('node:'),treeshake:{moduleSideEffects:false}},lib:{entry:join(temp,'fixture.tsx'),name:'RoleDelegationFixture',formats:['iife']}}})
 const bundle=Array.isArray(result)?result[0]:result;assert.ok(bundle&&'output'in bundle);script=bundle.output.find(item=>item.type==='chunk')!.code
 const {chromium}=loadPlaywright();browser=await chromium.launch(launchOptions())
})
after(async()=>{await browser?.close();if(temp)await rm(temp,{recursive:true,force:true})})
async function fixture(t:any,mode:string){
 const page=await browser.newPage();page.setDefaultTimeout(2500);const errors:string[]=[],requests:string[]=[]
 page.on('pageerror',(error:Error)=>errors.push(error.message));await page.route('**/*',(route:any)=>{requests.push(route.request().url());return route.abort()})
 t.after(async()=>{await page.close();assert.deepEqual(errors,[]);assert.deepEqual(requests,[])})
 await page.setContent('<!doctype html><html lang="zh-CN"><body><div id="root"></div></body></html>');await page.evaluate((mode:string)=>(window as any).testMode=mode,mode);await page.addScriptTag({content:script});await page.getByRole('button',{name:'核对并保存委托范围'}).waitFor();return page
}
test('配置升版后旧委托只在历史中；本人新建范围提交 expectedVersion:null',async t=>{
 const page=await fixture(t,'bumped'),edit=page.getByRole('button',{name:'核对并保存委托范围'})
 assert.equal(await page.getByRole('button',{name:'本人确认恢复委托'}).count(),0);assert.equal(await page.getByRole('button',{name:'结束执行委托'}).count(),0)
 await page.getByText('委托记录',{exact:true}).click();assert.match(await page.locator('body').innerText(),/职责或授权版本已变更/)
 await edit.click();await page.getByLabel('read',{exact:true}).check();await page.getByLabel('我已核对以上范围，明确确认保存执行委托').check();await page.getByRole('button',{name:'本人确认保存委托'}).click()
 await page.waitForFunction(()=>(window as any).delegationFixture.calls.some((row:any)=>row.input.action==='save'))
 const writes=await page.evaluate(()=>(window as any).delegationFixture.calls.filter((row:any)=>row.endpoint!=='role-delegations/get'))
 assert.equal(writes.length,1);assert.equal(writes[0].input.expectedRoleVersion,2);assert.equal(writes[0].input.expectedVersion,null)
 await page.getByText('委托已保存，等待本人确认分身执行',{exact:true}).waitFor();assert.equal(await page.evaluate(()=>(window as any).delegationFixture.raw),null)
})
test('活跃范围先暂停编辑；确定 conflict 清日志允许暂停，未知结果保留原请求核对',async t=>{
 const page=await fixture(t,'active'),edit=page.getByRole('button',{name:'核对并保存委托范围'})
 const editDisabled=await edit.isDisabled();await page.evaluate(()=>(window as any).delegationFixture.rejectedSave())
 assert.deepEqual({editDisabled,pending:await page.evaluate(()=>!!(window as any).delegationFixture.pending())},{editDisabled:true,pending:false});assert.equal(await page.evaluate(()=>(window as any).delegationFixture.raw),null)
 await page.getByRole('button',{name:'暂停执行委托'}).click();await page.getByText('执行委托已暂停；代拟仍可用',{exact:true}).waitFor();assert.equal(await edit.isDisabled(),false)
 await edit.click();await page.getByLabel('我已核对以上范围，明确确认保存执行委托').check();await page.getByRole('button',{name:'本人确认保存委托'}).click();await page.getByText('委托已保存，等待本人确认分身执行',{exact:true}).waitFor()
 await page.evaluate(()=>(window as any).delegationFixture.unknownSave());await page.getByRole('button',{name:'核对原请求'}).waitFor()
 const pending=await page.evaluate(()=>(window as any).delegationFixture.pending());assert.ok(pending);assert.ok(await page.evaluate(()=>(window as any).delegationFixture.raw));assert.equal(await page.getByRole('button',{name:'暂停执行委托'}).isDisabled(),true)
 await page.getByRole('button',{name:'核对原请求'}).click();await page.waitForFunction(()=>(window as any).delegationFixture.raw===null)
 const matching=await page.evaluate((id:string)=>(window as any).delegationFixture.calls.filter((row:any)=>row.input.requestId===id),pending.input.requestId)
 assert.equal(matching.length,2);assert.deepEqual(matching[0],matching[1]);assert.equal(await page.evaluate(()=>(window as any).delegationFixture.calls.some((row:any)=>row.endpoint.includes('consents/confirm'))),false)
})
