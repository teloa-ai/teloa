import test from 'node:test'
import assert from 'node:assert/strict'
import {fileURLToPath} from 'node:url'
import {createServer} from 'node:http'
import {build} from 'vite'
// @ts-expect-error 复用既有无头浏览器夹具。
import {loadPlaywright,launchOptions} from './fixtures/load-playwright.mjs'

test('员工配置冲突后只读加载新版，保留目标/执行位置/原请求，由本人再提交',async t=>{
 const root=fileURLToPath(new URL('../../../../',import.meta.url)),client=fileURLToPath(new URL('../src/client/',import.meta.url)),virtual=root+'__issue7_role_recovery.tsx'
 const entry=`import React,{useState} from 'react';import {createRoot} from 'react-dom/client';import {CreateConversationDialog} from '${client}CreateConversationDialog.tsx';import {I18nProvider} from '${client}i18n/provider.tsx';import {translateMessage} from '${client}i18n/messages.ts';
 const f=window.recoveryFixture={calls:[],version:2},snapshot={locale:'zh-CN',dshLocale:'zh',revision:1},runtime={getSnapshot:()=>snapshot,subscribe:()=>()=>{},t:(key,params)=>translateMessage('zh-CN',key,params)},native={ready:true,workspaces:[{workspaceId:'workspace',title:'原执行位置',path:'/test',sessionIds:[]}],archived:[]},management={subscribe:()=>()=>{},getSnapshot:()=>native};
 function App(){const [scope,setScope]=useState('SOC');return <I18nProvider runtime={runtime}><CreateConversationDialog management={management} current={undefined} initialWorkspaceId="workspace" pendingRequestId="original-request" restart={()=>{throw Error('不应另建')}} locked={true} busy={false} goal="保留的工作目标" scopeChoices={[{id:'SOC',label:'安全运营'}]} selectedScope={scope} onScopeChange={setScope} create={async workspaceId=>{f.calls.push({action:'create',workspaceId,requestId:'original-request',version:f.version});if(f.version===2)throw Object.assign(Error('old'),{code:'teloa/version-conflict'})}} reloadConfiguration={async()=>{f.calls.push({action:'read'});f.version=3}} close={()=>{}} settings={()=>{}}/></I18nProvider>}createRoot(document.getElementById('root')).render(<App/>);`
 const result=await build({configFile:false,root,logLevel:'error',define:{'process.env.NODE_ENV':'"development"'},plugins:[{name:'issue7-role-recovery',resolveId:id=>id.endsWith('issue7-role-recovery')?virtual:null,load:id=>id===virtual?entry:null}],build:{write:false,minify:false,rollupOptions:{external:(id:string)=>id.startsWith('node:')},lib:{entry:'issue7-role-recovery',name:'RoleRecovery',formats:['iife']}}})
 const bundle=Array.isArray(result)?result[0]:result;assert.ok(bundle&&'output'in bundle)
 const browser=await loadPlaywright().chromium.launch(launchOptions());t.after(()=>browser.close());const page=await browser.newPage();page.setDefaultTimeout(4000)
 const server=createServer((_req,res)=>res.end('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><div id="root"></div></html>'));await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise<void>(resolve=>server.close(()=>resolve())))
 const errors:string[]=[];page.on('pageerror',(error:Error)=>errors.push(error.message));await page.goto('http://127.0.0.1:'+(server.address() as {port:number}).port);await page.addStyleTag({content:bundle.output.flatMap(row=>row.type==='asset'&&row.fileName.endsWith('.css')?[String(row.source)]:[]).join('\n')});await page.addScriptTag({content:bundle.output.find(row=>row.type==='chunk')!.code})
 await page.getByRole('button',{name:'重试创建',exact:true}).click();await page.getByRole('alert').waitFor();await page.getByRole('button',{name:'加载员工最新版配置',exact:true}).click();await page.getByText('已加载最新版配置，工作目标和原创建请求已保留。请核对范围后再次创建；本次刷新未创建工作。',{exact:true}).waitFor()
 assert.deepEqual(await page.evaluate(()=>(window as any).recoveryFixture.calls),[{action:'create',workspaceId:'workspace',requestId:'original-request',version:2},{action:'read'}]);await page.getByText('保留的工作目标',{exact:true}).waitFor();assert.equal(await page.getByLabel('业务范围',{exact:true}).inputValue(),'SOC')
 await page.getByRole('button',{name:'重试创建',exact:true}).click();assert.deepEqual(await page.evaluate(()=>(window as any).recoveryFixture.calls.at(-1)),{action:'create',workspaceId:'workspace',requestId:'original-request',version:3});assert.deepEqual(errors,[])
})
