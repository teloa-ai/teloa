import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,writeFile,rm} from 'node:fs/promises'
import {fileURLToPath} from 'node:url'
import {join} from 'node:path'
import {build} from 'vite'
// @ts-expect-error 复用正式无头浏览器加载器。
import {loadPlaywright,launchOptions} from './fixtures/load-playwright.mjs'

test('两个真实标签页共享原请求，网络不占存储锁，迟到回执只清自身，刷新仍核对原nonce',async t=>{
 const root=fileURLToPath(new URL('../../../../',import.meta.url)),client=fileURLToPath(new URL('../src/client/',import.meta.url)),dir=await mkdtemp(join(root,'.runtime-artifact-journal-tabs-'))
 t.after(()=>rm(dir,{recursive:true,force:true}))
 const a='11111111-1111-4111-8111-111111111111',b='33333333-3333-4333-8333-333333333333'
 await writeFile(join(dir,'fixture.ts'),`import {createArtifactApi} from ${JSON.stringify(join(client,'artifact-api.ts'))};import {createArtifactSaveJournal} from ${JSON.stringify(join(client,'artifact-save-journal.ts'))};const source={kind:'session',id:'22222222-2222-4222-8222-222222222222',scope:'general',version:'v1',title:'本轮合成来源'},f={writes:[],mode:'hold',state:'idle'};window.fixture=f;f.api=createArtifactApi(async(method,payload)=>{if(method==='artifacts/versions')return [{artifactId:payload.artifactId,ownerId:'owner',number:1,source,content:{title:'合成成果',sections:[{id:'body',title:'说明',text:'合成原件'}],snapshotIds:[],note:'原件'},createdAt:'2026-10-29T00:00:00.000Z'}];if(method==='artifacts/withdraw'){f.writes.push(structuredClone(payload));if(f.mode==='hold')return new Promise(resolve=>f.release=()=>resolve({...payload,withdrawnAt:'2026-10-29T01:00:00.000Z'}));if(f.mode==='unknown')throw Error('测试丢回包');return {...payload,withdrawnAt:'2026-10-29T01:00:00.000Z'}}throw Error(method)},createArtifactSaveJournal(localStorage,navigator.locks));f.start=id=>{f.state='pending';f.api.withdraw(id).then(()=>f.state='done',e=>{f.state='unknown';f.error=e.code||e.message})};f.record=()=>JSON.parse(localStorage.getItem('teloa.artifact-save/v1')||'null');`)
 const built=await build({root,configFile:false,logLevel:'error',build:{write:false,minify:false,lib:{entry:join(dir,'fixture.ts'),formats:['iife'],name:'ArtifactJournalTabs'},rollupOptions:{external:(id:string)=>id.startsWith('node:'),treeshake:{moduleSideEffects:false}}}}),bundle=Array.isArray(built)?built[0]:built
 assert.ok(bundle&&'output'in bundle);const script=bundle.output.find(x=>x.type==='chunk')!.code
 const browser=await loadPlaywright().chromium.launch({...launchOptions(),headless:true});t.after(()=>browser.close())
 const context=await browser.newContext({serviceWorkers:'block'});t.after(()=>context.close())
 const external:string[]=[]
 await context.route('**/*',(route:any)=>route.request().url()==='http://127.0.0.1:41839/__artifact_journal__'?route.fulfill({contentType:'text/html',body:'<!doctype html><title>Owned artifact journal test</title>'}):(external.push(route.request().url()),route.abort()))
 const left=await context.newPage(),right=await context.newPage(),errors:string[]=[]
 for(const page of [left,right]){page.setDefaultTimeout(5000);page.on('pageerror',(error:Error)=>errors.push(error.message));await page.goto('http://127.0.0.1:41839/__artifact_journal__');await page.addScriptTag({content:script})}
 assert.equal(await left.evaluate(()=>!!navigator.locks),true)
 await left.evaluate((id:string)=>(window as any).fixture.start(id),a)
 await left.waitForFunction(()=>(window as any).fixture.writes.length===1||(window as any).fixture.state!=='pending')
 assert.deepEqual(await left.evaluate(()=>{const f=(window as any).fixture;return {state:f.state,error:f.error,writes:f.writes.length}}),{state:'pending',error:undefined,writes:1})
 assert.equal(await right.evaluate(async()=>(await navigator.locks.query()).held?.length),0,'网络回包等待不持存储锁')
 await right.evaluate((id:string)=>{const f=(window as any).fixture;f.mode='unknown';f.start(id)},b)
 await right.waitForFunction(()=>(window as any).fixture.state==='unknown')
 const writes=await right.evaluate(()=>(window as any).fixture.writes)
 assert.equal(await right.evaluate(()=>(window as any).fixture.record().requests.length),2)
 await left.evaluate(()=>(window as any).fixture.release());await left.waitForFunction(()=>(window as any).fixture.state==='done')
 const remaining=await right.evaluate(()=>(window as any).fixture.record().requests)
 assert.equal(remaining.length,1);assert.equal(remaining[0].key,'withdraw:'+b);assert.deepEqual(remaining[0].payload,writes[0])
 await right.reload();await right.addScriptTag({content:script})
 assert.equal(await right.evaluate((id:string)=>(window as any).fixture.api.withdrawalPending(id),b),true)
 await right.evaluate(async(id:string)=>{const f=(window as any).fixture;f.mode='known';await f.api.recoverWithdrawal(id)},b)
 assert.deepEqual(await right.evaluate(()=>(window as any).fixture.writes[0]),writes[0])
 assert.equal(await left.evaluate(()=>(window as any).fixture.record()),null)
 assert.equal(await left.evaluate(async()=>(await navigator.locks.query()).held?.length),0)
 assert.deepEqual(errors,[]);assert.deepEqual(external,[])
})
