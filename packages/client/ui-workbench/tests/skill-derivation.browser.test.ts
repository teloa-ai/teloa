import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,writeFile,rm,mkdir} from 'node:fs/promises'
import {fileURLToPath} from 'node:url'
import {join} from 'node:path'
import {build} from 'vite'
// @ts-expect-error 既有无头浏览器加载器。
import {loadPlaywright,launchOptions} from './fixtures/load-playwright.mjs'

const root=fileURLToPath(new URL('../../../../',import.meta.url)),client=fileURLToPath(new URL('../src/client/',import.meta.url))
let browser:any,script:string,styles:string,temp:string
const evidence=process.env.TELOA_SKILL_DERIVATION_EVIDENCE_DIR
test.before(async()=>{
 if(evidence)await mkdir(evidence,{recursive:true})
 temp=await mkdtemp(join(root,'.runtime-skill-derivation-'))
 await writeFile(join(temp,'entry.tsx'),`import React,{useState} from 'react';import {createRoot} from 'react-dom/client';import {RealSkillInstallations} from '${client}RealSkillInstallations.tsx';import {I18nProvider} from '${client}i18n/provider.tsx';import {translateMessage} from '${client}i18n/messages.ts';import {readAtomicSkill} from '${client}atomic-skill.ts';import {atomicSkillItem} from '${client}atomic-market.ts';import tokens from '${client}theme-tokens.module.css';import {prototypeThemes} from '${client}../brand/prototype-theme.ts';
 const encode=s=>new TextEncoder().encode(s),sha=async bytes=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),x=>x.toString(16).padStart(2,'0')).join('');
 const files=[{path:'original/SKILL.md',bytes:encode('---\\nname: evidence-review\\ndescription: Review provided evidence.\\n---\\nOriginal instructions.\\n')},{path:'original/references/guide.md',bytes:encode('Original companion guide.\\n')},{path:'original/LICENSE',bytes:encode('Original Apache-2.0 copyright.\\n')},{path:'original/assets/sample.bin',bytes:new Uint8Array([0,255,1,128])}];
 const atomic=await readAtomicSkill(files.map(f=>({path:f.path,size:f.bytes.length,read:async()=>f.bytes})),{id:'evidence-review',title:'Evidence review',version:'1.2.0',categories:['review'],modelDependencies:[{catalogId:'teloa.model.sensevoice',version:'1.0.0',usage:'speech-to-text',required:true}]}),contentId='11111111-1111-4111-8111-111111111111',source={kind:'atomic',contentId,contentHash:atomic.hash,resourceId:atomic.id,resourceVersion:atomic.version},bundleHash=await sha(encode(JSON.stringify(atomic.files.map(f=>[f.path.slice('original/'.length),f.hash]))));
 const native={name:atomic.id,description:'Review provided evidence.',modelInvocable:true,userInvocable:true,bodyHash:await sha(encode(atomic.text))},record={id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',ownerId:'owner',source,bundleHash,native,state:'installed',version:1,createdAt:'2026-10-26T00:00:00Z',updatedAt:'2026-10-26T00:00:00Z'},original={...atomicSkillItem(atomic),author:'Original publisher',license:'Apache-2.0',trust:{publisher:'Original publisher',repository:null,license:{status:'declared',value:'Apache-2.0'},signature:{status:'verified',signer:'original-author'},compatibility:{teloa:'未声明',dsh:'未声明'},plugins:[],externalCapabilities:[],permissions:[],review:{conclusion:'approved',summary:'Original review'}},contentStorage:{contentId,createdAt:record.createdAt,loaded:true}};
 const fromDisk=localStorage.getItem('fixture-saved'),diskSaved=fromDisk?JSON.parse(fromDisk):undefined;if(diskSaved)for(const f of diskSaved.atomicSkill.files)f.bytes=Uint8Array.from(f.bytes);const fixture=window.derivationFixture={imports:[],totalImports:Number(localStorage.getItem('fixture-imports')??0),installCalls:[],recoveries:0,mode:'success',pending:JSON.parse(localStorage.getItem('fixture-pending')??'null')??undefined,saved:diskSaved,original,record};
 const api={pending:()=>undefined,recoveryMessage:()=>undefined,list:async()=>({items:[record,...(fixture.installed?[fixture.installed]:[])],usages:[]}),get:async()=>{if(fixture.denyGet)throw Error('原安装不再属于当前本人');return record},preview:async input=>{const item=input.contentId===contentId?original:fixture.saved;if(!item)throw Error('missing');const skill=item.atomicSkill;return {source:input.contentId===contentId?source:{kind:'atomic',contentId:input.contentId,contentHash:skill.hash,resourceId:skill.id,resourceVersion:skill.version},bundleHash:input.contentId===contentId?bundleHash:await sha(encode(JSON.stringify(skill.files.map(f=>[f.path,f.hash])))),native:{...native,name:skill.id},files:skill.files.map(f=>({path:f.path.replace(/^original\\//,''),hash:f.hash,size:f.bytes.length}))}},install:async input=>{fixture.installCalls.push(input);const p=await api.preview(input.source);return fixture.installed={...record,id:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',source:p.source,bundleHash:p.bundleHash,native:p.native}},observe:async()=>({installationId:fixture.installed.id,scope:'default-workspace',state:'available',current:null})};
 const contentApi={pending:()=>fixture.pending,recoveryMessage:()=>undefined,list:async()=>[original,...(fixture.saved?[fixture.saved]:[])],hydrate:async item=>item,importAtomic:async(content,name,options)=>{fixture.totalImports++;localStorage.setItem('fixture-imports',String(fixture.totalImports));fixture.imports.push({content:{...content,files:content.files.map(f=>({...f,bytes:Array.from(f.bytes)}))},name,options});fixture.saved={...atomicSkillItem(content),author:name,license:options?.license??'来源许可未声明',trust:{...original.trust,publisher:name,license:options?.license?{status:'declared',value:options.license}:{status:'missing'},signature:{status:'unverified',signer:null},review:{conclusion:'needs-review',summary:'Local derivative'}},contentStorage:{contentId:'22222222-2222-4222-8222-222222222222',createdAt:record.createdAt,loaded:true}};localStorage.setItem('fixture-saved',JSON.stringify({...fixture.saved,atomicSkill:{...fixture.saved.atomicSkill,files:fixture.saved.atomicSkill.files.map(f=>({...f,bytes:Array.from(f.bytes)}))}}));if(fixture.mode==='lost'||fixture.mode==='lost-before'){fixture.pending={kind:'atomic-skill',logicalId:content.id,version:content.version,hash:content.hash,requestId:'33333333-3333-4333-8333-333333333333',derivation:options?.derivation};localStorage.setItem('fixture-pending',JSON.stringify(fixture.pending));if(fixture.mode==='lost-before'){fixture.saved=undefined;localStorage.removeItem('fixture-saved')}throw Error('response lost')}fixture.pending=undefined;localStorage.removeItem('fixture-pending');return fixture.saved},recover:async()=>{fixture.recoveries++;if(!fixture.saved)throw Object.assign(Error('not found'),{code:'teloa/not-found',rejected:true});fixture.pending=undefined;localStorage.removeItem('fixture-pending');return fixture.saved}};
 const localeState={locale:'zh-CN',dshLocale:'zh-CN',revision:1},runtime={t:(key,params)=>translateMessage('zh-CN',key,params),subscribe:()=>()=>{},getSnapshot:()=>localeState};Object.entries(prototypeThemes.light).forEach(([key,value])=>document.body.style.setProperty(key,value));document.body.classList.add(tokens.tokens);
 createRoot(document.getElementById('root')).render(<I18nProvider runtime={runtime}><RealSkillInstallations api={api} marketContentApi={contentApi} selected={record.id} select={()=>{}}/></I18nProvider>);fixture.ready=true;`)
 const result=await build({configFile:false,plugins:[{name:'forbid-host-crypto',enforce:'pre',resolveId(id){if(id==='node:crypto')return '\0forbid-host-crypto'},load(id){if(id==='\0forbid-host-crypto')return "function blocked(){throw Error('浏览器验收不允许执行宿主摘要或签名算法')} export {blocked as createHash,blocked as createPublicKey,blocked as verify}"}}],root,logLevel:'error',define:{'process.env.NODE_ENV':'"development"'},build:{write:false,minify:false,target:'esnext',lib:{entry:join(temp,'entry.tsx'),name:'SkillDerivationTest',formats:['es']}}})
 const bundle=Array.isArray(result)?result[0]:result
 if(!bundle||!('output'in bundle))throw Error('技能派生浏览器验收必须取得静态构建输出。')
 const entry=bundle.output.find(item=>item.type==='chunk')
 if(!entry||entry.type!=='chunk')throw Error('技能派生浏览器验收缺少入口脚本。')
 script=entry.code;styles=bundle.output.flatMap(item=>item.type==='asset'&&item.fileName.endsWith('.css')?[String(item.source)]:[]).join('\n')
 browser=await loadPlaywright().chromium.launch(launchOptions())
})
test.after(async()=>{await browser?.close();if(temp)await rm(temp,{recursive:true,force:true})})
async function open(t:any){
 const page=await browser.newPage({viewport:{width:1440,height:1050}});t.after(()=>page.close());page.setDefaultTimeout(4500)
 const errors:string[]=[];page.on('pageerror',(error:Error)=>errors.push(error.message));await page.route('**/*',(route:any)=>route.abort())
 await page.route('http://127.0.0.1/skill-derivation',((route:any)=>route.fulfill({contentType:'text/html',body:'<!doctype html><html lang="zh-CN"><head><link rel="stylesheet" href="/skill-derivation.css"></head><body style="margin:0"><div id="root"></div><script type="module" src="/skill-derivation.js"></script></body></html>'})))
 await page.route('http://127.0.0.1/skill-derivation.js',(route:any)=>route.fulfill({contentType:'text/javascript',body:script}))
 await page.route('http://127.0.0.1/skill-derivation.css',(route:any)=>route.fulfill({contentType:'text/css',body:styles}))
 await page.goto('http://127.0.0.1/skill-derivation');await page.waitForFunction(()=>(window as any).derivationFixture?.ready)
 await page.getByRole('heading',{name:'evidence-review',exact:true}).waitFor()
 return {page,errors}
}
async function editor(page:any){await page.getByRole('button',{name:'创建我的版本',exact:true}).click();const d=page.getByRole('dialog',{name:'创建我的技能版本',exact:true});await d.getByRole('combobox',{name:'技能文件',exact:true}).or(d.getByText(/我的版本已保存/)).first().waitFor();return d}

test('已安装技能详情提供实际派生入口，关闭重开保留未提交配套正文',{timeout:30000},async t=>{
 const {page,errors}=await open(t);let d=await editor(page)
 await d.getByRole('combobox',{name:'技能文件',exact:true}).selectOption('references/guide.md');await d.getByRole('tab',{name:'编辑',exact:true}).click();await d.locator('textarea').fill('Receiver revised companion.\n')
 await page.keyboard.press('Escape');await d.waitFor({state:'detached'});d=await editor(page);await d.getByRole('combobox',{name:'技能文件',exact:true}).selectOption('references/guide.md');await d.getByRole('tab',{name:'编辑',exact:true}).click();assert.equal(await d.locator('textarea').inputValue(),'Receiver revised companion.\n')
 assert.deepEqual(await page.evaluate(()=>(window as any).derivationFixture.imports),[]);assert.deepEqual(errors,[])
})

test('派生保存保留二进制与许可、新独立名称和原始来源，明确安装前零安装',{timeout:30000},async t=>{
 const {page,errors}=await open(t),d=await editor(page)
 await d.getByText('保留的模型依赖',{exact:true}).click();await d.getByText('teloa.model.sensevoice · 1.0.0 · speech-to-text · 必需',{exact:true}).waitFor()
 const select=d.getByRole('combobox',{name:'技能文件',exact:true});assert.equal(await select.locator('option').count(),4)
 await select.selectOption('LICENSE');assert.equal(await d.locator('textarea').getAttribute('readonly'),'');assert.match(await d.locator('textarea').inputValue(),/Original Apache/)
 await select.selectOption('assets/sample.bin');await d.getByText('此文件不能作为文本编辑，将保留原始字节。',{exact:true}).waitFor();assert.equal(await d.locator('textarea').count(),0)
 await select.selectOption('references/guide.md');await d.getByRole('tab',{name:'编辑',exact:true}).click();await d.locator('textarea').fill('Receiver independent guide.\n')
 if(evidence)await page.screenshot({path:join(evidence,'editable-companion-draft.png'),fullPage:true,animations:'disabled'})
 await d.getByRole('button',{name:'保存我的版本',exact:true}).click();await d.getByText(/我的版本已保存/).waitFor()
 const data=await page.evaluate(()=>{const f=(window as any).derivationFixture;return {imports:f.imports,installs:f.installCalls,originalText:f.original.atomicSkill.text}})
 assert.deepEqual(data.imports[0].content.modelDependencies,[{catalogId:'teloa.model.sensevoice',version:'1.0.0',usage:'speech-to-text',required:true}]);assert.equal(data.imports.length,1);assert.equal(data.installs.length,0);assert.match(data.imports[0].content.id,/^my-evidence-review-/);assert.match(data.imports[0].content.text,/teloa\.skill-derivation\/v1/);assert.match(data.imports[0].content.text,/Apache-2\.0/);assert.match(data.originalText,/name: evidence-review/)
 assert.deepEqual(data.imports[0].content.files.find((f:any)=>f.path==='assets/sample.bin').bytes,[0,255,1,128]);assert.equal(new TextDecoder().decode(Uint8Array.from(data.imports[0].content.files.find((f:any)=>f.path==='LICENSE').bytes)),'Original Apache-2.0 copyright.\n')
 assert.equal(new TextDecoder().decode(Uint8Array.from(data.imports[0].content.files.find((f:any)=>f.path==='references/guide.md').bytes)),'Receiver independent guide.\n')
 if(evidence)await page.screenshot({path:join(evidence,'saved-before-explicit-install.png'),fullPage:true,animations:'disabled'})
 const install=d.getByRole('button',{name:'安装到当前 Teloa',exact:true});await install.waitFor();await install.click();await page.waitForFunction(()=>(window as any).derivationFixture.installCalls.length===1);assert.deepEqual(errors,[])
})

test('丢失保存回包只核对原请求，重开不重新导入或自动安装',{timeout:30000},async t=>{
 const {page,errors}=await open(t);let d=await editor(page);await page.evaluate(()=>{(window as any).derivationFixture.mode='lost'})
 await d.getByRole('button',{name:'保存我的版本',exact:true}).click();await d.getByRole('button',{name:'核对原保存请求',exact:true}).waitFor();await page.keyboard.press('Escape');await d.waitFor({state:'detached'});d=await editor(page);await d.getByRole('button',{name:'核对原保存请求',exact:true}).click();await d.getByText(/我的版本已保存/).waitFor()
 const data=await page.evaluate(()=>{const f=(window as any).derivationFixture;return {imports:f.imports.length,recoveries:f.recoveries,installs:f.installCalls.length}});assert.deepEqual(data,{imports:1,recoveries:1,installs:0});assert.deepEqual(errors,[])
})

test('真实刷新后恢复同一原来源的未提交文本草稿与独立名称',{timeout:30000},async t=>{
 const {page,errors}=await open(t);let d=await editor(page)
 await d.getByRole('tab',{name:'编辑',exact:true}).click();const originalEntry=await d.locator('textarea').inputValue()
 await d.getByRole('combobox',{name:'技能文件',exact:true}).selectOption('references/guide.md');await d.getByRole('tab',{name:'编辑',exact:true}).click();await d.locator('textarea').fill('Preserved across a real browser reload.\n');await d.getByText('草稿已保留在本机',{exact:true}).waitFor()
 await page.reload();await page.waitForFunction(()=>(window as any).derivationFixture?.ready);d=await editor(page);await d.getByRole('tab',{name:'编辑',exact:true}).click();assert.equal(await d.locator('textarea').inputValue(),originalEntry)
 await d.getByRole('combobox',{name:'技能文件',exact:true}).selectOption('references/guide.md');await d.getByRole('tab',{name:'编辑',exact:true}).click();assert.equal(await d.locator('textarea').inputValue(),'Preserved across a real browser reload.\n');assert.equal(await page.evaluate(()=>(window as any).derivationFixture.totalImports),0);assert.deepEqual(errors,[])
})

test('保存丢回包后的真实刷新按原绑定恢复，完成后再刷新仍读回原保存版本',{timeout:30000},async t=>{
 const {page,errors}=await open(t);let d=await editor(page);await d.getByRole('combobox',{name:'技能文件',exact:true}).selectOption('references/guide.md');await d.getByRole('tab',{name:'编辑',exact:true}).click();await d.locator('textarea').fill('Original pending request draft.\n');await page.evaluate(()=>{(window as any).derivationFixture.mode='lost'})
 await d.getByRole('button',{name:'保存我的版本',exact:true}).click();await d.getByRole('button',{name:'核对原保存请求',exact:true}).waitFor();const savedId=await page.evaluate(()=>(window as any).derivationFixture.saved.contentStorage.contentId)
 await page.reload();await page.waitForFunction(()=>(window as any).derivationFixture?.ready);d=await editor(page);await d.getByRole('button',{name:'核对原保存请求',exact:true}).click();await d.getByText(/我的版本已保存/).waitFor();assert.equal(await page.evaluate(()=>(window as any).derivationFixture.totalImports),1)
 await page.reload();await page.waitForFunction(()=>(window as any).derivationFixture?.ready);d=await editor(page);await d.getByText(/我的版本已保存/).waitFor();assert.equal(await d.getByRole('button',{name:'保存我的版本',exact:true}).count(),0);assert.equal(await page.evaluate(()=>(window as any).derivationFixture.saved.contentStorage.contentId),savedId);assert.equal(await page.evaluate(()=>(window as any).derivationFixture.totalImports),1);assert.equal(await page.evaluate(()=>(window as any).derivationFixture.installCalls.length),0)
 if(evidence)await page.screenshot({path:join(evidence,'real-reload-original-saved-version.png'),fullPage:true,animations:'disabled'});assert.deepEqual(errors,[])
})

test('不同本人或原安装的pending不能在此入口恢复成成功',{timeout:30000},async t=>{
 const {page,errors}=await open(t);await page.evaluate(()=>{const f=(window as any).derivationFixture;f.pending={kind:'atomic-skill',logicalId:'other-copy',version:'1.0.0',hash:'a'.repeat(64),requestId:'33333333-3333-4333-8333-333333333333',derivation:{ownerId:'other-owner',installationId:f.record.id,bundleHash:f.record.bundleHash,sourceIdentity:JSON.stringify(f.record.source)}}})
 const d=await editor(page);await d.getByText('另一个内容保存请求尚待核对，请先在原入口处理。',{exact:true}).waitFor();assert.equal(await d.getByRole('button',{name:'保存我的版本',exact:true}).isDisabled(),true);assert.equal(await d.getByRole('button',{name:'核对原保存请求',exact:true}).count(),0);assert.equal(await d.getByText(/我的版本已保存/).count(),0);assert.equal(await page.evaluate(()=>(window as any).derivationFixture.totalImports),0);assert.deepEqual(errors,[])
})

test('准入前断连后真实刷新，从原草稿继续同一内容而非重建副本',{timeout:30000},async t=>{
 const {page,errors}=await open(t);let d=await editor(page);await d.getByRole('combobox',{name:'技能文件',exact:true}).selectOption('references/guide.md');await d.getByRole('tab',{name:'编辑',exact:true}).click();await d.locator('textarea').fill('Not admitted yet, keep these exact edits.\n');await page.evaluate(()=>{(window as any).derivationFixture.mode='lost-before'})
 await d.getByRole('button',{name:'保存我的版本',exact:true}).click();await d.getByRole('button',{name:'核对原保存请求',exact:true}).waitFor();const original=await page.evaluate(()=>(window as any).derivationFixture.pending);assert.equal(await page.evaluate(()=>(window as any).derivationFixture.saved),undefined)
 await page.reload();await page.waitForFunction(()=>(window as any).derivationFixture?.ready);d=await editor(page);await d.getByRole('button',{name:'核对原保存请求',exact:true}).click();await d.getByText(/我的版本已保存/).waitFor();const actual=await page.evaluate(()=>{const f=(window as any).derivationFixture;return {hash:f.saved.atomicSkill.hash,id:f.saved.atomicSkill.id,imports:f.totalImports,recoveries:f.recoveries,installs:f.installCalls.length}})
 assert.equal(actual.hash,original.hash);assert.equal(actual.id,original.logicalId);assert.equal(actual.imports,2);assert.equal(actual.recoveries,1);assert.equal(actual.installs,0);assert.deepEqual(errors,[])
})

test('缓存草稿重开仍重新核本人安装，失去访问后不显示旧正文',{timeout:30000},async t=>{
 const {page,errors}=await open(t);let d=await editor(page);await d.getByRole('combobox',{name:'技能文件',exact:true}).selectOption('references/guide.md');await d.getByRole('tab',{name:'编辑',exact:true}).click();await d.locator('textarea').fill('Private old actor draft must stay hidden.\n');await d.getByText('草稿已保留在本机',{exact:true}).waitFor();await page.keyboard.press('Escape');await d.waitFor({state:'detached'});await page.evaluate(()=>{(window as any).derivationFixture.denyGet=true})
 await page.getByRole('button',{name:'创建我的版本',exact:true}).click();d=page.getByRole('dialog',{name:'创建我的技能版本',exact:true});await d.getByRole('alert').waitFor();assert.equal(await d.locator('textarea').count(),0);assert.equal(await d.getByRole('combobox').count(),0);assert.doesNotMatch(await d.innerText(),/Private old actor/);assert.equal(await d.getByRole('button',{name:'保存我的版本',exact:true}).isDisabled(),true);assert.equal(await page.evaluate(()=>(window as any).derivationFixture.totalImports),0);assert.deepEqual(errors,[])
})
