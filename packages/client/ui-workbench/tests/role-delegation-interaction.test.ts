import test,{before,after} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises'
import {fileURLToPath} from 'node:url'
import {join} from 'node:path'
import {build} from 'vite'
// @ts-expect-error 既有无头浏览器夹具为 MJS 模块。
import {launchOptions,loadPlaywright} from './fixtures/load-playwright.mjs'
const root=fileURLToPath(new URL('../../../../',import.meta.url)),client=fileURLToPath(new URL('../src/client/',import.meta.url))
let browser:any,script:string,styles:string,temp:string
const entry=`
import React from 'react';import {createRoot} from 'react-dom/client';
import {RoleDelegation} from '${client}RoleDelegation.tsx';import {createRoleDelegationApi} from '${client}role-delegation-api.ts';import {createRoleToolGrantApi} from '${client}role-tool-grant-api.ts';
import {I18nProvider} from '${client}i18n/provider.tsx';import {translateMessage} from '${client}i18n/messages.ts';
import {TwinProfile} from '${client}TwinProfile.tsx';import tokens from '${client}theme-tokens.module.css';import pageCss from '${client}TaskPage.module.css';import {prototypeThemes} from '${client}../brand/prototype-theme.ts';
document.body.classList.add(tokens.tokens);Object.entries(prototypeThemes.light).forEach(([key,value])=>document.body.style.setProperty(key,value));
let sequence=100;if(!crypto.randomUUID)crypto.randomUUID=()=> '00000000-0000-4000-8000-'+String(++sequence).padStart(12,'0');
const roleId='11111111-1111-4111-8111-111111111111',delegationId='22222222-2222-4222-8222-222222222222';
const fields={scope:'general',allowedTools:['read'],knowledgeIds:[],memoryViewId:null,groupIds:[],safeRecovery:false};
const resumed=window.testMode?.startsWith('resumed'),role={id:roleId,version:resumed?4:2,kind:resumed?'employee':'twin',state:'active',name:resumed?'原员工':'我的分身',scopes:['general'],knowledge:[],skills:[],storage:'persistent'};
const snapshot={locale:'zh-CN',dshLocale:'zh',revision:1},runtime={t:(key,params)=>translateMessage('zh-CN',key,params),subscribe:()=>()=>{},getSnapshot:()=>snapshot};
const f=window.delegationFixture={calls:[],receipts:new Map(),raw:null,lost:false,reject:false,delegations:[],version:role.version,toolReadVersion:role.version,grant:{roleId,roleVersion:resumed?3:2,state:'active',rules:[{name:'read',allowed:[],workspaceFiles:'default-workspace'}],createdAt:'2026-10-09T00:00:00.000Z'}};
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
const tools=createRoleToolGrantApi(async()=>({roleVersion:f.toolReadVersion,grant:f.grant}),{read:()=>null,write:()=>{},clear:()=>{}});
f.render=()=>{const manager=<RoleDelegation overview={window.testMode?.startsWith('overview')} role={{...role,duty:'准备产品周报和会议资料'}} api={api} resources={{directory:async()=>({resources:[]})}} toolGrants={tools}/>;app.render(<I18nProvider runtime={runtime}><main className={pageCss.page} style={{padding:32,maxWidth:1160,margin:'auto'}}>{window.testMode?.startsWith('overview')?<TwinProfile profileName="Q" role={role} draft={undefined} update={()=>{}} save={()=>false} conversations={null} samples={null} delegation={manager}/>:manager}</main></I18nProvider>);};
f.setup=mode=>{f.delegations=resumed||mode==='overview-empty'?[]:mode==='bumped'?[record(4,'ended',1)]:[record(1)];if(mode==='resumed-stale-tools')f.toolReadVersion=3;if(mode==='resumed-future-grant')f.grant.roleVersion=5;if(mode==='resumed-foreign-grant')f.grant.roleId='77777777-7777-4777-8777-777777777777';if(mode==='resumed-revoked'){f.grant.state='revoked';f.grant.rules=[];}if(mode==='resumed-missing')f.grant=null;if(mode==='resumed-stale-access')f.version=3;f.render();};
f.rejectedSave=async()=>{f.reject=true;try{await api.change({requestId:crypto.randomUUID(),roleId,expectedRoleVersion:2,expectedVersion:1,action:'save',fields});}catch{}f.render();};
f.unknownSave=async()=>{f.lost=true;try{await api.change({requestId:crypto.randomUUID(),roleId,expectedRoleVersion:2,expectedVersion:f.delegations.find(row=>row.roleVersion===2).version,action:'save',fields});}catch{}api=createRoleDelegationApi(call,journal);f.render();};
f.pending=()=>api.pending();f.fields=fields;f.setup(window.testMode);
`
before(async()=>{
 await mkdir(join(client,'../../.runtime'),{recursive:true});temp=await mkdtemp(join(client,'../../.runtime/role-delegation-ui-'));await writeFile(join(temp,'fixture.tsx'),entry)
 const result=await build({configFile:false,root,logLevel:'error',define:{'process.env.NODE_ENV':'"development"'},build:{write:false,minify:false,rollupOptions:{external:(id:string)=>id.startsWith('node:'),treeshake:{moduleSideEffects:false}},lib:{entry:join(temp,'fixture.tsx'),name:'RoleDelegationFixture',formats:['iife']}}})
 const bundle=Array.isArray(result)?result[0]:result;assert.ok(bundle&&'output'in bundle);script=bundle.output.find(item=>item.type==='chunk')!.code;styles=bundle.output.flatMap(item=>item.type==='asset'&&item.fileName.endsWith('.css')?[String(item.source)]:[]).join('\n')
 const {chromium}=loadPlaywright();browser=await chromium.launch(launchOptions())
})
after(async()=>{await browser?.close();if(temp)await rm(temp,{recursive:true,force:true})})
async function fixture(t:any,mode:string){
 const page=await browser.newPage();page.setDefaultTimeout(2500);const errors:string[]=[],requests:string[]=[]
 page.on('pageerror',(error:Error)=>errors.push(error.message));await page.route('**/*',(route:any)=>{requests.push(route.request().url());return route.abort()})
 t.after(async()=>{await page.close();assert.deepEqual(errors,[]);assert.deepEqual(requests,[])})
 await page.setContent('<!doctype html><html lang="zh-CN"><body><div id="root"></div></body></html>');await page.addStyleTag({content:styles});await page.evaluate((mode:string)=>(window as any).testMode=mode,mode);await page.addScriptTag({content:script});if(mode.startsWith('overview'))await page.getByRole('tab',{name:'授权边界',exact:true}).click();await page.getByRole('button',{name:mode.startsWith('overview')?'设置与核对范围':'核对并保存委托范围',exact:true}).waitFor();return page
}
test('分身范围总览只展示真实状态；抽屉关闭保留选择但清除确认，不自动授权',async t=>{
 const page=await fixture(t,'overview-empty')
 await page.setViewportSize({width:1440,height:1020})
 await page.getByRole('heading',{name:'工作范围',exact:true}).waitFor()
 assert.equal(await page.getByRole('dialog').isVisible(),false)
 assert.equal(await page.getByText('准备产品周报和会议资料',{exact:true}).isVisible(),true)
 assert.equal(await page.getByRole('button',{name:'本人确认保存委托',exact:true}).isVisible(),false)
 assert.deepEqual(await page.evaluate(()=>(window as any).delegationFixture.calls.filter((row:any)=>row.endpoint!=='role-delegations/get')),[])
 const open=page.getByRole('button',{name:'设置与核对范围',exact:true});await open.click()
 const drawer=page.getByRole('dialog',{name:'设置与核对范围',exact:true});await drawer.waitFor()
 await drawer.getByRole('button',{name:'核对并保存委托范围',exact:true}).click()
 await drawer.getByLabel('读取当前工作目录',{exact:true}).check()
 await drawer.getByLabel('中断后允许安全恢复，仍须重新核对权限',{exact:true}).check()
 await drawer.getByLabel('我已核对以上范围，明确确认保存执行委托',{exact:true}).check()
 await page.keyboard.press('Escape');assert.equal(await drawer.isVisible(),false)
 await open.click()
 assert.equal(await drawer.getByLabel('读取当前工作目录',{exact:true}).isChecked(),true)
 assert.equal(await drawer.getByLabel('中断后允许安全恢复，仍须重新核对权限',{exact:true}).isChecked(),true)
 assert.equal(await drawer.getByLabel('我已核对以上范围，明确确认保存执行委托',{exact:true}).isChecked(),false)
 assert.equal(await drawer.getByRole('button',{name:'本人确认保存委托',exact:true}).isDisabled(),true)
 assert.equal(await page.evaluate(()=>(window as any).delegationFixture.calls.some((row:any)=>row.endpoint!=='role-delegations/get')),false)
 await drawer.getByLabel('我已核对以上范围，明确确认保存执行委托',{exact:true}).check()
 await drawer.getByRole('button',{name:'本人确认保存委托',exact:true}).click()
 await drawer.getByText('委托已保存，等待本人确认分身执行',{exact:true}).waitFor()
 const writes=await page.evaluate(()=>(window as any).delegationFixture.calls.filter((row:any)=>row.endpoint!=='role-delegations/get'))
 assert.equal(writes.length,1);assert.equal(writes[0].input.expectedVersion,null);assert.deepEqual(writes[0].input.fields.allowedTools,['read'])
 assert.equal(writes.some((row:any)=>row.endpoint.includes('consents/confirm')),false)
 await page.keyboard.press('Escape');await page.setViewportSize({width:430,height:932});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false)
})
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
test('员工暂停授工具后恢复升版，仍沿最新有效旧版工具明确保存当前委托',async t=>{
 const page=await fixture(t,'resumed'),edit=page.getByRole('button',{name:'核对并保存委托范围'})
 await edit.click();await page.getByLabel('read',{exact:true}).check()
 const save=page.getByRole('button',{name:'本人确认保存委托'})
 assert.equal(await save.isDisabled(),true,'原授权不自动变成本次委托确认')
 assert.equal(await page.evaluate(()=>(window as any).delegationFixture.calls.some((row:any)=>row.endpoint!=='role-delegations/get')),false)
 await page.getByLabel('我已核对以上范围，明确确认保存执行委托').check();await save.click()
 await page.waitForFunction(()=>(window as any).delegationFixture.calls.some((row:any)=>row.input.action==='save'))
 const writes=await page.evaluate(()=>(window as any).delegationFixture.calls.filter((row:any)=>row.endpoint!=='role-delegations/get'))
 assert.equal(writes.length,1);assert.equal(writes[0].input.expectedRoleVersion,4);assert.equal(writes[0].input.expectedVersion,null);assert.deepEqual(writes[0].input.fields.allowedTools,['read'])
 assert.equal(await page.evaluate(()=>(window as any).delegationFixture.grant.roleVersion),3,'不补造或重授旧工具回执')
})
test('恢复后的过期读取、未来/异主/撤销/空工具授权及旧委托版本仍阻止编辑且不自动提交',async t=>{
 for(const mode of ['resumed-stale-tools','resumed-future-grant','resumed-foreign-grant','resumed-revoked','resumed-missing','resumed-stale-access']){
  const page=await fixture(t,mode),edit=page.getByRole('button',{name:'核对并保存委托范围'})
  if(mode==='resumed-future-grant'||mode==='resumed-foreign-grant')await page.getByRole('alert').first().waitFor()
  else if(mode==='resumed-stale-access')await page.getByText(/职责或授权版本已变更/).waitFor()
  else await page.getByText(/尚未取得当前工具授权/).waitFor()
  assert.equal(await edit.isDisabled(),true,mode)
  assert.equal(await page.getByRole('button',{name:'本人确认保存委托'}).count(),0,mode)
  assert.equal(await page.evaluate(()=>(window as any).delegationFixture.calls.some((row:any)=>row.endpoint!=='role-delegations/get')),false,mode)
 }
})
