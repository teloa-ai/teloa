import assert from 'node:assert/strict'
import test from 'node:test'
import {fileURLToPath} from 'node:url'
import {build} from 'vite'
// @ts-expect-error 复用已固定的无头浏览器加载器。
import {launchOptions,loadPlaywright} from './fixtures/load-playwright.mjs'

test('真实React StrictMode：显式刷新、API/本人隔离、卸载中断及迟答不写回',{timeout:30000},async t=>{
 const root=fileURLToPath(new URL('../../../../',import.meta.url)),client=fileURLToPath(new URL('../src/client/',import.meta.url)),virtual=root+'__work_attention_hook.tsx'
 const entry=`import React,{useEffect,useState} from 'react';import {createRoot} from 'react-dom/client';import {useWorkAttention} from '${client}use-work-attention.ts';import {createWorkAttentionApi} from '${client}work-attention-api.ts';
 const f=window.attentionHookFixture={calls:[],renders:0,state:null,origin:()=>{},show:()=>{},rerender:()=>{}};
 const stamp='2026-10-17T00:00:00.000Z',taskId='12345678-1234-4234-8234-123456789012';
 const page=title=>({schema:'teloa.work-attention/v1',items:title?[{id:'task:'+taskId,kind:'review',reason:'task-waiting',title,occurredAt:stamp,source:{kind:'task',taskId,version:1},target:{kind:'task',taskId},basisHash:'a'.repeat(64)}]:[],incomplete:[]});
 const apis=['a','b'].map(name=>createWorkAttentionApi((endpoint,payload,signal)=>new Promise((resolve,reject)=>f.calls.push({name,endpoint,payload,signal,finish:title=>resolve(page(title)),fail:()=>reject({code:'old-error'})}))));
 function Probe({api,owner,auto}){const state=useWorkAttention(apis[api],owner);f.renders++;f.state=state;useEffect(()=>{if(auto)void state.reload()},[state.reload,auto]);return <section><output aria-label="state">{JSON.stringify({items:state.items.map(item=>item.title),loaded:state.loaded,loading:state.loading,known:state.known,error:state.error})}</output><button onClick={()=>void state.reload()}>刷新</button><button onClick={()=>void state.more()}>更多</button></section>}
 function App(){const [origin,setOrigin]=useState({api:0,owner:'owner-a',auto:false}),[show,setShow]=useState(true),[revision,setRevision]=useState(0);f.origin=setOrigin;f.show=setShow;f.rerender=()=>setRevision(value=>value+1);return <main data-revision={revision}>{show&&<Probe {...origin}/>}</main>}
 createRoot(document.getElementById('root')).render(<React.StrictMode><App/></React.StrictMode>);`
 const result=await build({configFile:false,root,logLevel:'error',plugins:[{name:'work-attention-hook',resolveId:id=>id.endsWith('work-attention-hook')?virtual:null,load:id=>id===virtual?entry:null}],define:{'process.env.NODE_ENV':'"development"'},build:{write:false,minify:false,rollupOptions:{external:(id:string)=>id.startsWith('node:')},lib:{entry:'work-attention-hook',name:'WorkAttentionHook',formats:['iife']}}})
 const bundle=Array.isArray(result)?result[0]:result;assert.ok(bundle&&'output'in bundle)
 const chunk=bundle.output.find(item=>item.type==='chunk');assert.ok(chunk&&chunk.type==='chunk')
 const browser=await loadPlaywright().chromium.launch(launchOptions());t.after(()=>browser.close())
 const page=await browser.newPage();t.after(()=>page.close());page.setDefaultTimeout(2500)
 const errors:string[]=[];page.on('pageerror',(error:Error)=>errors.push(error.message));await page.route('**/*',(route:any)=>route.abort())
 await page.setContent('<html><body><div id="root"></div></body></html>');await page.addScriptTag({content:chunk.code})
 const state=async()=>JSON.parse(await page.getByRole('status',{name:'state'}).innerText()),calls=()=>page.evaluate(()=>(window as any).attentionHookFixture.calls.length)
 const settled=()=>page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))))
 await page.getByRole('button',{name:'刷新',exact:true}).waitFor();await settled()
 assert.deepEqual(await state(),{items:[],loaded:false,loading:false,known:false});assert.equal(await calls(),0,'hook自身不自动读取')
 await page.getByRole('button',{name:'刷新',exact:true}).click();assert.equal(await calls(),1);assert.deepEqual(await state(),{items:[],loaded:false,loading:true,known:false})
 await page.evaluate(()=>(window as any).attentionHookFixture.calls[0].finish('本人A待办'))
 await page.waitForFunction(()=>(window as any).attentionHookFixture.state.known)
 assert.deepEqual(await state(),{items:['本人A待办'],loaded:true,loading:false,known:true})
 await page.evaluate(()=>(window as any).attentionHookFixture.rerender());await settled();assert.equal(await calls(),1);assert.equal((await state()).items[0],'本人A待办')
 // 同API换本人：立即隐藏旧事实并abort在途；服务即便忽略signal也不能把旧结果写回。
 await page.getByRole('button',{name:'刷新',exact:true}).click()
 await page.evaluate(()=>(window as any).attentionHookFixture.origin({api:0,owner:'owner-b',auto:true}))
 await page.waitForFunction(()=>(window as any).attentionHookFixture.calls.length===3)
 assert.equal(await page.evaluate(()=>(window as any).attentionHookFixture.calls[1].signal.aborted),true)
 assert.deepEqual(await state(),{items:[],loaded:false,loading:true,known:false})
 await page.evaluate(()=>{const f=(window as any).attentionHookFixture;f.calls[1].finish('迟到本人A');f.calls[2].finish('本人B待办')})
 await page.waitForFunction(()=>(window as any).attentionHookFixture.state.known);assert.deepEqual((await state()).items,['本人B待办'])
 // 同本人换API：Frame式effect只发一次新读取，不因订阅更新自循环。
 await page.getByRole('button',{name:'刷新',exact:true}).click()
 await page.evaluate(()=>(window as any).attentionHookFixture.origin({api:1,owner:'owner-b',auto:true}))
 await page.waitForFunction(()=>(window as any).attentionHookFixture.calls.length===5)
 assert.equal(await page.evaluate(()=>(window as any).attentionHookFixture.calls[3].signal.aborted),true)
 await page.evaluate(()=>{const f=(window as any).attentionHookFixture;f.calls[3].fail();f.calls[4].finish('新连接待办')})
 await page.waitForFunction(()=>(window as any).attentionHookFixture.state.known);await settled()
 assert.deepEqual((await state()).items,['新连接待办']);assert.equal(await calls(),5)
 await page.getByRole('button',{name:'刷新',exact:true}).click()
 await page.evaluate(()=>(window as any).attentionHookFixture.show(false));await page.getByRole('button',{name:'刷新',exact:true}).waitFor({state:'hidden'})
 assert.equal(await page.evaluate(()=>(window as any).attentionHookFixture.calls[5].signal.aborted),true)
 const before=await page.evaluate(()=>(window as any).attentionHookFixture.renders)
 await page.evaluate(()=>(window as any).attentionHookFixture.calls[5].finish('卸载迟答'));await settled()
 assert.equal(await page.evaluate(()=>(window as any).attentionHookFixture.renders),before);assert.equal(await calls(),6)
 assert.deepEqual(await page.evaluate(()=>(window as any).attentionHookFixture.calls.map((call:any)=>({endpoint:call.endpoint,payload:call.payload}))),Array.from({length:6},()=>({endpoint:'work-attention',payload:{}})))
 assert.deepEqual(errors,[])
})
