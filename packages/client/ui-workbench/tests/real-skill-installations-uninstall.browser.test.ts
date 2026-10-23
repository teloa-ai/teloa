import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,writeFile,rm} from 'node:fs/promises'
import {fileURLToPath} from 'node:url'
import {join} from 'node:path'
import {build} from 'vite'
// @ts-expect-error 复用既有无头浏览器加载器。
import {launchOptions,loadPlaywright} from './fixtures/load-playwright.mjs'

const root=fileURLToPath(new URL('../../../../',import.meta.url)),client=fileURLToPath(new URL('../src/client/',import.meta.url))
const stamp='2026-10-22T00:00:00.000Z',hash='b'.repeat(64)
let browser:any,script:string,styles:string,tempDir:string

test.before(async()=>{
 const temp=tempDir=await mkdtemp(join(root,'.runtime-skill-uninstall-'))
 await writeFile(join(temp,'entry.tsx'),`import React,{useState} from 'react';import {createRoot} from 'react-dom/client';import {RealSkillInstallations} from '${client}RealSkillInstallations.tsx';import {I18nProvider} from '${client}i18n/provider.tsx';import {translateMessage} from '${client}i18n/messages.ts';import tokens from '${client}theme-tokens.module.css';import {prototypeThemes} from '${client}../brand/prototype-theme.ts';
 const noop=()=>()=>{},stamp='${stamp}',hash='${hash}',installedId='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',preparingId='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
 const native={name:'audit-skill',description:'审计技能',modelInvocable:true,userInvocable:true,bodyHash:'d'.repeat(64)},source={kind:'atomic',contentId:'11111111-1111-4111-8111-111111111111',contentHash:'a'.repeat(64),resourceId:'market.skill',resourceVersion:'2.1.0'};
 const record=(id,state)=>({id,ownerId:'owner',source,bundleHash:hash,native,state,version:3,createdAt:stamp,updatedAt:stamp});
 const fixture=window.installFixture={selected:window.__initialSkillSelected??installedId,records:[record(installedId,'installed'),record(preparingId,'preparing')],calls:[],listCalls:0,selectCalls:[],uninstallMode:'success'};
 const api={pending:()=>undefined,recoveryMessage:()=>undefined,list:async()=>{fixture.listCalls++;return {items:fixture.records,usages:[]}},get:async id=>{const row=fixture.records.find(item=>item.id===id);if(!row)throw Error('记录不存在');return row},uninstall:async input=>{fixture.calls.push(input);if(fixture.uninstallMode==='conflict'){const error=Object.assign(Error('conflict'),{code:'teloa/conflict',details:{reason:'skill-in-use',blockers:['selected','run-history']}});throw error}if(fixture.uninstallMode==='network')throw Error('断线');fixture.records=fixture.records.filter(item=>item.id!==input.installationId);return {requestId:input.requestId,installationId:input.installationId,nativeName:fixture.uninstallName??'audit-skill',bundleHash:hash,removedAt:new Date().toISOString()}}};
 const localeState={locale:'zh-CN',dshLocale:'zh-CN',revision:1},runtime={t:(key,params)=>translateMessage('zh-CN',key,params),subscribe:noop,getSnapshot:()=>localeState};
 Object.entries(prototypeThemes.light).forEach(([key,value])=>document.body.style.setProperty(key,value));document.body.classList.add(tokens.tokens);
 function App(){const [selected,setSelected]=useState(fixture.selected);fixture.select=id=>{fixture.selectCalls.push(id??null);setSelected(id??null)};return <I18nProvider runtime={runtime}><RealSkillInstallations api={api} selected={selected} select={fixture.select}/></I18nProvider>}
 createRoot(document.getElementById('root')).render(<App/>);`)
 const result=await build({configFile:false,plugins:[{name:'forbid-host-crypto',enforce:'pre',resolveId(id){if(id==='node:crypto')return '\0forbid-host-crypto'},load(id){if(id==='\0forbid-host-crypto')return "function blocked(){throw Error('浏览器验收不允许执行宿主摘要或签名算法')} export {blocked as createHash,blocked as createPublicKey,blocked as verify}"}}],root,logLevel:'error',define:{'process.env.NODE_ENV':'"development"'},build:{write:false,minify:false,lib:{entry:join(temp,'entry.tsx'),name:'SkillUninstallTest',formats:['iife']}}})
 const bundle=Array.isArray(result)?result[0]:result;assert.ok(bundle&&'output'in bundle)
 script=bundle.output.find(item=>item.type==='chunk')!.code;styles=bundle.output.flatMap(item=>item.type==='asset'&&item.fileName.endsWith('.css')?[String(item.source)]:[]).join('\n')
 browser=await loadPlaywright().chromium.launch(launchOptions())
})
test.after(async()=>{await browser?.close();if(tempDir)await rm(tempDir,{recursive:true,force:true})})

async function open(t:any,{mode='success',selected}:{mode?:string;selected?:string}={}){
 const page=await browser.newPage({viewport:{width:1280,height:900}});t.after(()=>page.close());page.setDefaultTimeout(4000)
 const errors:string[]=[];page.on('pageerror',(error:Error)=>errors.push(error.message));await page.route('**/*',(route:any)=>route.abort())
 if(selected)await page.addInitScript((value:string)=>{;(window as any).__initialSkillSelected=value},selected)
 await page.route('http://127.0.0.1/skill-uninstall',(route:any)=>route.fulfill({contentType:'text/html',body:'<!doctype html><html lang="zh-CN"><body style="margin:0"><div id="root"></div></body></html>'}))
 await page.goto('http://127.0.0.1/skill-uninstall');if(styles)await page.addStyleTag({content:styles});await page.addScriptTag({content:script})
 await page.evaluate((mode:string)=>{(window as any).installFixture.uninstallMode=mode},mode)
 return {page,errors}
}

test('已安装技能详情提供危险区与二次确认，成功后卸载并刷新目录',{timeout:30000},async t=>{
 const {page,errors}=await open(t)
 await page.getByRole('heading',{name:'audit-skill',exact:true}).waitFor()
 const danger=page.getByRole('region',{name:'危险区',exact:true})
 await danger.waitFor()
 await danger.getByRole('button',{name:'卸载技能',exact:true}).click()
 const confirm=danger.getByRole('alertdialog',{name:'确认卸载技能',exact:true})
 await confirm.waitFor()
 const submit=confirm.getByRole('button',{name:'确认卸载',exact:true})
 assert.equal(await submit.isDisabled(),true,'未输入技能名前不能卸载')
 assert.equal(await danger.getByText(/不可撤销/).isVisible(),true)
 await confirm.getByRole('textbox').fill('audit-skill')
 assert.equal(await submit.isDisabled(),false)
 await submit.click()
 await page.waitForFunction(()=>(window as any).installFixture.calls.length===1)
 const calls=await page.evaluate(()=>(window as any).installFixture.calls)
 const call=calls[0]
 assert.match(call.requestId,/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i)
 assert.equal(call.installationId,'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')
 assert.equal(call.expectedVersion,3)
 assert.equal(call.expectedBundleHash,hash)
 assert.equal(call.confirm,true)
 await page.waitForFunction(()=>(window as any).installFixture.selectCalls.some((id:unknown)=>id===null))
 assert.ok((await page.evaluate(()=>(window as any).installFixture.listCalls))>=2,'成功后必须刷新列表')
 assert.equal(await page.getByRole('heading',{name:'audit-skill',exact:true}).count(),0,'成功后应返回目录')
 assert.deepEqual(errors,[])
})

test('preparing 状态不显示卸载危险区',{timeout:30000},async t=>{
 const {page,errors}=await open(t,{selected:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'})
 await page.getByRole('heading',{name:'audit-skill',exact:true}).waitFor()
 assert.equal(await page.getByRole('region',{name:'危险区',exact:true}).count(),0,'preparing 状态不得显示卸载')
 assert.equal(await page.getByRole('button',{name:'卸载技能',exact:true}).count(),0)
 assert.deepEqual(errors,[])
})

test('冲突 blocker 展示具体原因与下一步，保留详情可重试且不伪造成功',{timeout:30000},async t=>{
 const {page,errors}=await open(t,{mode:'conflict'})
 await page.getByRole('heading',{name:'audit-skill',exact:true}).waitFor()
 const danger=page.getByRole('region',{name:'危险区',exact:true})
 await danger.getByRole('button',{name:'卸载技能',exact:true}).click()
 await danger.getByRole('alertdialog',{name:'确认卸载技能',exact:true}).getByRole('textbox').fill('audit-skill')
 await danger.getByRole('button',{name:'确认卸载',exact:true}).click()
 const blocked=danger.getByRole('alert',{name:'暂时不能卸载'})
 await blocked.waitFor()
 const text=await blocked.innerText()
 assert.match(text,/当前版本选中/)
 assert.match(text,/历史执行|历史运行/)
 assert.match(text,/停用/)
 await page.getByRole('heading',{name:'audit-skill',exact:true}).waitFor({state:'visible'})
 await page.evaluate(()=>{(window as any).installFixture.uninstallMode='success'})
 await blocked.getByRole('button',{name:'重试',exact:true}).click()
 await page.waitForFunction(()=>(window as any).installFixture.calls.length===2)
 await page.waitForFunction(()=>(window as any).installFixture.selectCalls.some((id:unknown)=>id===null))
 assert.deepEqual(errors,[])
})
