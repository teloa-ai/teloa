import assert from 'node:assert/strict'
import {before,after,test,type TestContext} from 'node:test'
import {fileURLToPath} from 'node:url'
import {build} from 'vite'
// @ts-expect-error 复用固定的独立无头浏览器加载器。
import {loadPlaywright,launchOptions} from './fixtures/load-playwright.mjs'
const root=fileURLToPath(new URL('../../../../',import.meta.url)),client=fileURLToPath(new URL('../src/client/',import.meta.url)),virtual=root+'__skill_secrets_state_fixture.tsx'
let browser:ReturnType<typeof loadPlaywright> extends {chromium:{launch:()=>Promise<infer B>}}?B:never,script:string,styles:string
declare global{interface Window{skillSecretsState:{calls:{owner:number;endpoint:string;payload:unknown}[];changeApi:()=>void;changeSkill:()=>void;rerender:()=>void;resolveWrite:()=>void;rejectConflict:()=>void;resolveDescribe:()=>void;rejectDescribe:()=>void}}}
before(async()=>{
 const entry=`import React from 'react';import {createRoot} from 'react-dom/client';import {SkillSecretsView} from '__CLIENT__SkillSecretsView.tsx';import {ContextDrawer} from '__CLIENT__ContextDrawer.tsx';import {createSkillSecretsApi} from '__CLIENT__skill-secrets-api.ts';import {I18nProvider} from '__CLIENT__i18n/provider.tsx';import {translateMessage} from '__CLIENT__i18n/messages.ts';
 const f=window.skillSecretsState={calls:[]},mode=document.getElementById('root').dataset.mode;
 const state=(owner,configured,skill)=>({skill,binding:'a'.repeat(64),writable:true,reconfirm:false,vars:[{envVarName:'SERVICE_API_KEY',label:{'zh-CN':owner?'新服务密钥':'旧服务密钥',en:owner?'New service key':'Old service key'},required:true,configured,target:'bearer',endpoints:[{origin:owner?'https://new.example.test':'https://old.example.test',pathPrefixes:['/v1/']}]}]});
 const apis=[0,1].map(owner=>createSkillSecretsApi(async(endpoint,payload)=>{f.calls.push({owner,endpoint,payload});if(endpoint==='skill-secrets/describe'){if((owner===1&&mode==='held-new-read')||(owner===0&&mode==='held-old-read')||(mode==='held-new-skill'&&payload.skill==='other-skill'))return new Promise((resolve,reject)=>{f.resolveDescribe=()=>resolve(state(owner,owner===0,payload.skill));f.rejectDescribe=()=>reject(Error('Old describe failed'))});return state(owner,owner===0,payload.skill)}return new Promise((resolve,reject)=>{f.resolveWrite=()=>resolve(state(owner,endpoint==='skill-secrets/save',payload.skill));f.rejectConflict=()=>reject(Object.assign(Error('Known binding conflict'),{code:'teloa/version-conflict'}))})}));
 const snapshot={locale:'zh-CN',dshLocale:'zh',revision:1},runtime={getSnapshot:()=>snapshot,subscribe:()=>()=>{},t:(key,params)=>translateMessage('zh-CN',key,params)};
 function App(){const [owner,setOwner]=React.useState(0),[open,setOpen]=React.useState(true),[skill,setSkill]=React.useState('same-skill'),[revision,setRevision]=React.useState(0);f.changeApi=()=>setOwner(1);f.changeSkill=()=>setSkill('other-skill');f.rerender=()=>setRevision(n=>n+1);return <I18nProvider runtime={runtime}><main><textarea aria-label="原入口草稿" defaultValue="保留原入口"/>{open&&<ContextDrawer title="技能配置" close={()=>setOpen(false)}><SkillSecretsView key="same-skill" embedded skill={skill} title={"测试技能 "+revision} api={apis[owner]} onBack={()=>setOpen(false)}/></ContextDrawer>}</main></I18nProvider>};createRoot(document.getElementById('root')).render(<App/>);`.replaceAll('__CLIENT__',client)
 const result=await build({configFile:false,root,logLevel:'error',plugins:[{name:'skill-secrets-state-fixture',resolveId:id=>id.endsWith('skill-secrets-state-fixture')?virtual:null,load:id=>id===virtual?entry:null}],define:{'process.env.NODE_ENV':'"development"'},build:{write:false,minify:false,rollupOptions:{external:(id:string)=>id.startsWith('node:')},lib:{entry:'skill-secrets-state-fixture',name:'SkillSecretsStateFixture',formats:['iife']}}})
 const bundle=Array.isArray(result)?result[0]:result;assert.ok(bundle&&'output'in bundle);script=bundle.output.find(row=>row.type==='chunk')!.code;styles=bundle.output.flatMap(row=>row.type==='asset'&&row.fileName.endsWith('.css')?[String(row.source)]:[]).join('\n');browser=await loadPlaywright().chromium.launch(launchOptions())
})
after(async()=>{await browser?.close()})
async function open(t:TestContext,mode='normal'){
 const page=await browser.newPage({viewport:{width:1280,height:900}}),errors:string[]=[];page.setDefaultTimeout(1500);page.on('pageerror',(error:Error)=>errors.push(error.message));t.after(async()=>{await page.close();assert.deepEqual(errors,[])})
 await page.route('**/*',(route:{abort:()=>Promise<void>})=>route.abort());await page.setContent('<!doctype html><div id="root" data-mode="'+mode+'"></div>');await page.addStyleTag({content:styles});await page.addScriptTag({content:script});const drawer=page.getByRole('dialog',{name:'技能配置',exact:true});await drawer.waitFor();await page.waitForFunction(()=>window.skillSecretsState.calls.length===1);return{page,drawer}
}
test('同技能切换 API 后收起旧密钥表单，新声明就绪前不能沿用旧输入',{timeout:20000},async t=>{
 const{page,drawer}=await open(t,'held-new-read');await drawer.getByLabel(/旧服务密钥/).fill('synthetic-old-only');await page.evaluate(()=>window.skillSecretsState.rerender());await page.evaluate(()=>new Promise<void>(resolve=>requestAnimationFrame(()=>resolve())));assert.equal(await drawer.getByLabel(/旧服务密钥/).inputValue(),'synthetic-old-only');assert.equal(await page.evaluate(()=>window.skillSecretsState.calls.length),1);await page.evaluate(()=>window.skillSecretsState.changeApi());await page.waitForFunction(()=>window.skillSecretsState.calls.length===2)
 assert.equal(await drawer.locator('input[type=password]').count(),0,'新连接读取中不得暴露旧连接的可写密码框')
 await page.evaluate(()=>window.skillSecretsState.resolveDescribe());await drawer.getByLabel(/新服务密钥/).waitFor();assert.equal(await drawer.locator('input[type=password]').inputValue(),'');assert.deepEqual(await page.evaluate(()=>window.skillSecretsState.calls.filter(c=>c.endpoint!=='skill-secrets/describe')),[])
})
for(const operation of ['save','remove'] as const)test('旧 API 的 '+operation+' ACK 不覆盖新连接声明',{timeout:20000},async t=>{
 const{page,drawer}=await open(t);await drawer.getByLabel(/旧服务密钥/).waitFor()
 if(operation==='save'){await drawer.getByLabel(/旧服务密钥/).fill('synthetic-save-value');await drawer.getByRole('button',{name:'保存',exact:true}).click()}else{await drawer.getByRole('button',{name:'删除密钥',exact:true}).click();await drawer.getByRole('button',{name:'确认删除',exact:true}).click()}
 await page.waitForFunction(()=>window.skillSecretsState.calls.length===2);await page.evaluate(()=>window.skillSecretsState.changeApi());await drawer.getByLabel(/新服务密钥/).waitFor()
 await page.evaluate(()=>window.skillSecretsState.resolveWrite());await page.evaluate(()=>new Promise<void>(resolve=>requestAnimationFrame(()=>resolve())))
 assert.equal(await drawer.getByLabel(/新服务密钥/).count(),1,'旧写 ACK 不得将新表单切回旧目标');assert.equal(await drawer.getByLabel(/新服务密钥/).inputValue(),'');assert.equal(await drawer.getByRole('button',{name:'保存',exact:true}).isEnabled(),true)
 assert.deepEqual(await page.evaluate(()=>window.skillSecretsState.calls.map(c=>[c.owner,c.endpoint])),[[0,'skill-secrets/describe'],[0,'skill-secrets/'+(operation==='save'?'save':'delete')],[1,'skill-secrets/describe']])
})
for(const departure of ['replace-api','unmount'] as const)test(departure+' 后旧绑定冲突不再派发旧 describe',{timeout:20000},async t=>{
 const{page,drawer}=await open(t);await drawer.getByLabel(/旧服务密钥/).fill('synthetic-conflict-value');await drawer.getByRole('button',{name:'保存',exact:true}).click();await page.waitForFunction(()=>window.skillSecretsState.calls.length===2)
 if(departure==='replace-api'){await page.evaluate(()=>window.skillSecretsState.changeApi());await drawer.getByLabel(/新服务密钥/).waitFor()}else{await drawer.getByRole('button',{name:'关闭',exact:true}).click();await drawer.waitFor({state:'detached'})}
 await page.evaluate(()=>window.skillSecretsState.rejectConflict());await page.evaluate(()=>new Promise<void>(resolve=>requestAnimationFrame(()=>resolve())))
 assert.equal(await page.evaluate(()=>window.skillSecretsState.calls.filter(c=>c.owner===0&&c.endpoint==='skill-secrets/describe').length),1,'离开原连接/卸载后不得自动重读旧 API');if(departure==='replace-api'){assert.equal(await drawer.getByLabel(/新服务密钥/).count(),1);assert.equal(await drawer.getByRole('alert').count(),0)}assert.equal(await page.getByRole('textbox',{name:'原入口草稿',exact:true}).inputValue(),'保留原入口')
})
for(const result of ['resolve','reject'] as const)test('旧 describe '+result+' 不覆盖新 API 的就绪状态',{timeout:20000},async t=>{
 const{page,drawer}=await open(t,'held-old-read');await page.evaluate(()=>window.skillSecretsState.changeApi());await drawer.getByLabel(/新服务密钥/).waitFor();await drawer.getByLabel(/新服务密钥/).fill('synthetic-current-only')
 await page.evaluate((result:'resolve'|'reject')=>{const f=window.skillSecretsState;if(result==='resolve')f.resolveDescribe();else f.rejectDescribe()},result);await page.evaluate(()=>new Promise<void>(resolve=>requestAnimationFrame(()=>resolve())))
 assert.equal(await drawer.getByLabel(/新服务密钥/).inputValue(),'synthetic-current-only');assert.equal(await drawer.getByRole('alert').count(),0);assert.equal(await drawer.getByRole('button',{name:'保存',exact:true}).isEnabled(),true)
})

test('同一 API 切换技能时同步隔离旧密码草稿，即使声明指纹相同也不沿用',{timeout:20000},async t=>{
 const{page,drawer}=await open(t,'held-new-skill');await drawer.getByLabel(/旧服务密钥/).fill('synthetic-other-skill');await page.evaluate(()=>window.skillSecretsState.changeSkill());await page.waitForFunction(()=>window.skillSecretsState.calls.length===2)
 assert.equal(await drawer.locator('input[type=password]').count(),0);await page.evaluate(()=>window.skillSecretsState.resolveDescribe());await drawer.getByLabel(/旧服务密钥/).waitFor();assert.equal(await drawer.locator('input[type=password]').inputValue(),'')
 assert.deepEqual(await page.evaluate(()=>window.skillSecretsState.calls.map(c=>[c.owner,c.endpoint,c.payload])),[[0,'skill-secrets/describe',{skill:'same-skill'}],[0,'skill-secrets/describe',{skill:'other-skill'}]])
})
