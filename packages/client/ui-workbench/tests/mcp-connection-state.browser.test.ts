import assert from 'node:assert/strict'
import {before,after,test,type TestContext} from 'node:test'
import {fileURLToPath} from 'node:url'
import {build} from 'vite'
// @ts-expect-error 复用固定的独立无头浏览器加载器。
import {loadPlaywright,launchOptions} from './fixtures/load-playwright.mjs'
const root=fileURLToPath(new URL('../../../../',import.meta.url)),client=fileURLToPath(new URL('../src/client/',import.meta.url)),virtual=root+'__mcp_connection_state_fixture.tsx'
let browser:ReturnType<typeof loadPlaywright> extends {chromium:{launch:()=>Promise<infer B>}}?B:never,script:string,styles:string
type Call={owner:number;endpoint:string;payload:unknown}
declare global{interface Window{mcpConnectionState:{calls:Call[];backs:number;frames:{owner:number;passwords:string[]}[];changeApi:()=>void;rerender:()=>void;resolve:()=>void;reject:()=>void}}}
before(async()=>{
 const entry=`import React from 'react';import {createRoot} from 'react-dom/client';import {McpConnectionView} from '__CLIENT__McpConnectionView.tsx';import {ContextDrawer} from '__CLIENT__ContextDrawer.tsx';import {createManagedMcpConnectionApi} from '__CLIENT__mcp-connections-api.ts';import {I18nProvider} from '__CLIENT__i18n/provider.tsx';import {translateMessage} from '__CLIENT__i18n/messages.ts';
 const mode=document.getElementById('root').dataset.mode,f=window.mcpConnectionState={calls:[],backs:0,frames:[]},id='11111111-1111-4111-8111-111111111111',stamp='2026-10-16T00:00:00.000Z';
 const record=(owner,status)=>({id,catalogId:'teloa.test-remote',serverName:'remote',status,tools:status==='connected'?[{name:owner?'new_owner_tool':'old_owner_tool',fullName:owner?'mcp.new_owner_tool':'mcp.old_owner_tool',readOnly:true}]:[],createdAt:stamp,updatedAt:stamp});
 const states=mode==='connect-list'||mode==='connect-add'||mode==='oauth-list'||mode==='oauth-start'||mode==='secret'?[]:[record(0,mode==='connect'||mode==='connect-error'?'saved':'connected')];
 const apis=[0,1].map(owner=>createManagedMcpConnectionApi(async(endpoint,payload)=>{
  f.calls.push({owner,endpoint,payload});const lists=f.calls.filter(c=>c.owner===owner&&c.endpoint==='mcp-connections/list').length;
  const value=()=>endpoint==='mcp-connections/list'?{items:owner?(mode==='secret'?[]:[record(1,'connected')]):states}:endpoint==='mcp-connections/add'?record(owner,'saved'):endpoint==='mcp-connections/oauth-start'?{status:'already-connected'}:record(owner,endpoint==='mcp-connections/disconnect'?'saved':'connected');
  if(owner===0&&((endpoint==='mcp-connections/list'&&lists>1&&(mode==='connect-list'||mode==='oauth-list'))||(endpoint==='mcp-connections/add'&&mode==='connect-add')||(endpoint==='mcp-connections/connect'&&(mode==='connect'||mode==='connect-error'))||(endpoint==='mcp-connections/disconnect'&&mode==='disconnect')||(endpoint==='mcp-connections/delete'&&mode==='delete')||(endpoint==='mcp-connections/oauth-start'&&mode==='oauth-start')))return new Promise((resolve,reject)=>{f.resolve=()=>resolve(value());f.reject=()=>reject(Object.assign(Error('Unknown connection result'),{code:'teloa/source-unavailable'}))});
  return value();
 }));
 const auth=mode.startsWith('oauth')?{kind:'oauth',supported:true,requiresUserClientId:false,scopes:[]}:mode==='secret'?{kind:'secret',vars:[{target:'env',envVarName:'SERVICE_TOKEN',label:{'zh-CN':'测试服务密钥',en:'Test service key'},required:true}]}:{kind:'none'};
 const entry={format:'teloa.market-catalog-entry/v1',id:'teloa.test-remote',kind:'connector',delivery:'managed',version:'1.0.0',connector:{serverName:'remote',title:{'zh-CN':'测试服务',en:'Test service'},auth},compatibility:{status:'needs-configuration'}};
 const snapshot={locale:'zh-CN',dshLocale:'zh',revision:1},runtime={getSnapshot:()=>snapshot,subscribe:()=>()=>{},t:(key,params)=>translateMessage('zh-CN',key,params)};
 function App(){const [owner,setOwner]=React.useState(0),[open,setOpen]=React.useState(true),[revision,setRevision]=React.useState(0);f.changeApi=()=>setOwner(1);f.rerender=()=>setRevision(n=>n+1);React.useLayoutEffect(()=>{f.frames.push({owner,passwords:[...document.querySelectorAll('input[type=password]')].map(input=>input.value)})},[owner]);return <I18nProvider runtime={runtime}><main><textarea aria-label="原入口草稿" defaultValue="保留原入口"/><span data-revision={revision}/>{open&&<ContextDrawer title="连接配置" close={()=>setOpen(false)}><McpConnectionView key="same-connector" catalogId={entry.id} entry={entry} api={apis[owner]} onBack={()=>{f.backs++;setOpen(false)}}/></ContextDrawer>}</main></I18nProvider>};createRoot(document.getElementById('root')).render(<App/>);`.replaceAll('__CLIENT__',client)
 const result=await build({configFile:false,root,logLevel:'error',plugins:[{name:'mcp-connection-state-fixture',resolveId:id=>id.endsWith('mcp-connection-state-fixture')?virtual:null,load:id=>id===virtual?entry:null}],define:{'process.env.NODE_ENV':'"development"'},build:{write:false,minify:false,rollupOptions:{external:(id:string)=>id.startsWith('node:')},lib:{entry:'mcp-connection-state-fixture',name:'McpConnectionStateFixture',formats:['iife']}}})
 const bundle=Array.isArray(result)?result[0]:result;assert.ok(bundle&&'output'in bundle);script=bundle.output.find(row=>row.type==='chunk')!.code;styles=bundle.output.flatMap(row=>row.type==='asset'&&row.fileName.endsWith('.css')?[String(row.source)]:[]).join('\n');browser=await loadPlaywright().chromium.launch(launchOptions())
})
after(async()=>{await browser?.close()})
async function open(t:TestContext,mode:string){
 const page=await browser.newPage({viewport:{width:1280,height:900}}),errors:string[]=[];page.setDefaultTimeout(1500);page.on('pageerror',(error:Error)=>errors.push(error.message));t.after(async()=>{await page.close();assert.deepEqual(errors,[])})
 await page.route('**/*',(route:{abort:()=>Promise<void>})=>route.abort());await page.setContent('<!doctype html><div id="root" data-mode="'+mode+'"></div>');await page.addStyleTag({content:styles});await page.addScriptTag({content:script});const drawer=page.getByRole('dialog',{name:'连接配置',exact:true});await drawer.waitFor();await page.waitForFunction(()=>window.mcpConnectionState.calls.length===1);return{page,drawer}
}
test('同对象换 API 的首个已提交帧不暴露旧密码，同连接重渲染保留未提交输入',{timeout:20000},async t=>{
 const{page,drawer}=await open(t,'secret');await drawer.getByLabel('测试服务密钥',{exact:true}).fill('synthetic-old-only');await page.evaluate(()=>window.mcpConnectionState.rerender());await page.evaluate(()=>new Promise<void>(resolve=>requestAnimationFrame(()=>resolve())));assert.equal(await drawer.getByLabel('测试服务密钥',{exact:true}).inputValue(),'synthetic-old-only');assert.equal(await page.evaluate(()=>window.mcpConnectionState.calls.length),1)
 await page.evaluate(()=>window.mcpConnectionState.changeApi());await page.waitForFunction(()=>window.mcpConnectionState.frames.length===2);assert.deepEqual(await page.evaluate(()=>window.mcpConnectionState.frames.at(-1)!.passwords),[],'新连接首次 commit 必须先移除旧密码 DOM');await drawer.getByLabel('测试服务密钥',{exact:true}).waitFor();assert.equal(await drawer.getByLabel('测试服务密钥',{exact:true}).inputValue(),'')
})
for(const mode of ['connect-list','oauth-list'] as const)test(mode+' 读取未决时关闭，迟答不再登记连接',{timeout:20000},async t=>{
 const{page,drawer}=await open(t,mode);await drawer.getByRole('button',{name:mode==='oauth-list'?'去授权':'测试连接',exact:true}).click();await page.waitForFunction(()=>typeof window.mcpConnectionState.resolve==='function');await drawer.getByRole('button',{name:'关闭',exact:true}).click();await drawer.waitFor({state:'detached'});await page.evaluate(()=>window.mcpConnectionState.resolve());await page.evaluate(()=>new Promise<void>(resolve=>requestAnimationFrame(()=>resolve())))
 assert.deepEqual(await page.evaluate(()=>window.mcpConnectionState.calls.map(c=>c.endpoint)),['mcp-connections/list','mcp-connections/list'],'离开后不得由旧读取继续 add/connect/oauthStart');assert.equal(await page.getByRole('textbox',{name:'原入口草稿',exact:true}).inputValue(),'保留原入口')
})
test('登记已发但关闭后才返回，不再继续测试连接',{timeout:20000},async t=>{
 const{page,drawer}=await open(t,'connect-add');await drawer.getByRole('button',{name:'测试连接',exact:true}).click();await page.waitForFunction(()=>typeof window.mcpConnectionState.resolve==='function');await drawer.getByRole('button',{name:'关闭',exact:true}).click();await drawer.waitFor({state:'detached'});await page.evaluate(()=>window.mcpConnectionState.resolve());await page.evaluate(()=>new Promise<void>(resolve=>requestAnimationFrame(()=>resolve())))
 assert.deepEqual(await page.evaluate(()=>window.mcpConnectionState.calls.map(c=>c.endpoint)),['mcp-connections/list','mcp-connections/list','mcp-connections/add'],'已派发 add 不假称取消，也不得闭窗后续 connect')
})
for(const mode of ['connect','disconnect'] as const)test('旧 '+mode+' ACK 不覆盖新 API 的当前连接',{timeout:20000},async t=>{
 const{page,drawer}=await open(t,mode);await drawer.getByRole('button',{name:mode==='connect'?'测试连接':'断开',exact:true}).click();await page.waitForFunction(()=>typeof window.mcpConnectionState.resolve==='function');await page.evaluate(()=>window.mcpConnectionState.changeApi());await drawer.getByText('new_owner_tool',{exact:true}).waitFor();await page.evaluate(()=>window.mcpConnectionState.resolve());await page.evaluate(()=>new Promise<void>(resolve=>requestAnimationFrame(()=>resolve())))
 assert.equal(await drawer.getByText('new_owner_tool',{exact:true}).count(),1);assert.equal(await drawer.getByText('old_owner_tool',{exact:true}).count(),0);assert.equal(await drawer.getByRole('button',{name:'断开',exact:true}).isEnabled(),true)
})
test('旧删除 ACK 不导航离开新的连接配置',{timeout:20000},async t=>{
 const{page,drawer}=await open(t,'delete');await drawer.getByRole('button',{name:'删除',exact:true}).click();await drawer.getByRole('button',{name:'确认删除',exact:true}).click();await page.waitForFunction(()=>typeof window.mcpConnectionState.resolve==='function');await page.evaluate(()=>window.mcpConnectionState.changeApi());await drawer.getByText('new_owner_tool',{exact:true}).waitFor();await page.evaluate(()=>window.mcpConnectionState.resolve());await page.evaluate(()=>new Promise<void>(resolve=>requestAnimationFrame(()=>resolve())))
 assert.equal(await page.evaluate(()=>window.mcpConnectionState.backs),0);assert.equal(await drawer.getByText('new_owner_tool',{exact:true}).count(),1)
})
test('旧连接未决结果迟到报错，不再重取旧记录或覆盖新状态',{timeout:20000},async t=>{
 const{page,drawer}=await open(t,'connect-error');await drawer.getByRole('button',{name:'测试连接',exact:true}).click();await page.waitForFunction(()=>typeof window.mcpConnectionState.reject==='function');await page.evaluate(()=>window.mcpConnectionState.changeApi());await drawer.getByText('new_owner_tool',{exact:true}).waitFor();await page.evaluate(()=>window.mcpConnectionState.reject());await page.evaluate(()=>new Promise<void>(resolve=>requestAnimationFrame(()=>resolve())))
 assert.equal(await page.evaluate(()=>window.mcpConnectionState.calls.filter(c=>c.owner===0&&c.endpoint==='mcp-connections/get').length),0);assert.equal(await drawer.getByText('new_owner_tool',{exact:true}).count(),1);assert.equal(await drawer.getByRole('alert').count(),0)
})
test('授权已派发但窗口关闭后才回已连接，不再读取旧连接',{timeout:20000},async t=>{
 const{page,drawer}=await open(t,'oauth-start');await drawer.getByRole('button',{name:'去授权',exact:true}).click();await page.waitForFunction(()=>typeof window.mcpConnectionState.resolve==='function');await drawer.getByRole('button',{name:'关闭',exact:true}).click();await drawer.waitFor({state:'detached'});await page.evaluate(()=>window.mcpConnectionState.resolve());await page.evaluate(()=>new Promise<void>(resolve=>requestAnimationFrame(()=>resolve())))
 assert.equal(await page.evaluate(()=>window.mcpConnectionState.calls.filter(c=>c.endpoint==='mcp-connections/get').length),0);assert.equal(await page.evaluate(()=>window.mcpConnectionState.calls.filter(c=>c.endpoint==='mcp-connections/oauth-start').length),1)
})

test('已发连接仍未决时关闭只停止本页轮询，不取消或重发该连接',{timeout:20000},async t=>{
 const{page,drawer}=await open(t,'connect');await drawer.getByRole('button',{name:'测试连接',exact:true}).click();await page.waitForFunction(()=>window.mcpConnectionState.calls.some(c=>c.endpoint==='mcp-connections/get'),undefined,{timeout:3000})
 const reads=await page.evaluate(()=>window.mcpConnectionState.calls.filter(c=>c.endpoint==='mcp-connections/get').length);await drawer.getByRole('button',{name:'关闭',exact:true}).click();await drawer.waitFor({state:'detached'});await new Promise(resolve=>setTimeout(resolve,1150))
 assert.equal(await page.evaluate(()=>window.mcpConnectionState.calls.filter(c=>c.endpoint==='mcp-connections/get').length),reads);assert.equal(await page.evaluate(()=>window.mcpConnectionState.calls.filter(c=>c.endpoint==='mcp-connections/connect').length),1)
 await page.evaluate(()=>window.mcpConnectionState.resolve());await page.evaluate(()=>new Promise<void>(resolve=>requestAnimationFrame(()=>resolve())));assert.equal(await page.evaluate(()=>window.mcpConnectionState.backs),0)
})
