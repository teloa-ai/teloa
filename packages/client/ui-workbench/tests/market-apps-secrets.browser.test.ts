import assert from 'node:assert/strict'
import test from 'node:test'
import {mkdtemp,rm,writeFile} from 'node:fs/promises'
import {fileURLToPath} from 'node:url'
import {join} from 'node:path'
import {build} from 'vite'
// @ts-expect-error 复用固定无头浏览器运行器。
import {loadPlaywright,launchOptions} from './fixtures/load-playwright.mjs'

test('应用目录中有声明的已添加技能能用配置图标打开原密钥表单，无声明不增加入口',{timeout:60000},async t=>{
 const root=fileURLToPath(new URL('../../../../',import.meta.url)),client=fileURLToPath(new URL('../src/client/',import.meta.url)),temp=await mkdtemp(join(root,'.runtime-app-secrets-'))
 t.after(()=>rm(temp,{recursive:true,force:true}))
 await writeFile(join(temp,'fixture.tsx'),`import React,{useState} from 'react';import {createRoot} from 'react-dom/client';import {MarketAppsDirectoryView} from ${JSON.stringify(join(client,'MarketAppsDirectory.tsx'))};import {SkillSecretsView} from ${JSON.stringify(join(client,'SkillSecretsView.tsx'))};import {ContextDrawer} from ${JSON.stringify(join(client,'ContextDrawer.tsx'))};import {I18nProvider} from ${JSON.stringify(join(client,'i18n/provider.tsx'))};import {translateMessage} from ${JSON.stringify(join(client,'i18n/messages.ts'))};
 const f=window.appSecrets={described:[],opened:[],writes:[]};
 const secret={envVarName:'SERVICE_API_KEY',label:{'zh-CN':'服务密钥',en:'Service key'},required:true,configured:false,target:'bearer',endpoints:[{origin:'https://api.example.test',pathPrefixes:['/v1/']}]};
 const skill=(name,title,declared)=>({title,summary:'密钥入口核对',entryId:name,added:true,installed:true,builtin:false,item:{addedContentId:name,entry:{id:name,kind:'skill',delivery:'upstream',compatibility:{status:'compatible'},skill:{name,title:{'zh-CN':title,en:title}},...(declared?{secrets:[secret]}:{})}}});
 const secretSkill=skill('declared-method','需密钥技能',true),plainSkill=skill('plain-method','无密钥技能',false);
 const row=(key,title,skills,kind='skill')=>({key,title,kind,summary:'密钥入口核对',categories:[],entryIds:skills.map(skill=>skill.entryId),connectors:[],skills,mine:true});
 const rows=[row('secret','需密钥技能',[secretSkill]),row('plain','无密钥技能',[plainSkill]),row('library','组合技能库',[secretSkill,plainSkill],'library')];
 const api={describe:async skill=>{f.described.push(skill);return {skill,binding:'a'.repeat(64),writable:true,reconfirm:false,vars:[secret]}},save:async()=>{f.writes.push('save');throw Error('No secret may be saved')},remove:async()=>{f.writes.push('delete');throw Error('No secret may be deleted')}};
 const snapshot={locale:'zh-CN',dshLocale:'zh',revision:1},runtime={getSnapshot:()=>snapshot,subscribe:()=>()=>{},t:(key,params)=>translateMessage('zh-CN',key,params)};
 function App(){const [view,setView]=useState({query:'密钥',category:'all',mine:false}),[target,setTarget]=useState(null);return <I18nProvider runtime={runtime}><MarketAppsDirectoryView rows={rows} ranking={new Map()} catalog={{status:'ready'}} connections={{status:'ready',records:[]}} view={view} onViewChange={setView} runAction={()=>{}} busy={undefined} errors={{}} skillSecrets={{describe:api.describe,open:(skill,title)=>{f.opened.push({skill,title});setTarget({skill,title})}}}/>{target&&<ContextDrawer title="技能配置" close={()=>setTarget(null)}><SkillSecretsView embedded skill={target.skill} title={target.title} api={api} onBack={()=>setTarget(null)}/></ContextDrawer>}</I18nProvider>};createRoot(document.getElementById('root')).render(<App/>);`)
 const result=await build({configFile:false,root,logLevel:'error',define:{'process.env.NODE_ENV':'"development"'},build:{write:false,minify:false,rollupOptions:{external:(id:string)=>id.startsWith('node:'),treeshake:{moduleSideEffects:false}},lib:{entry:join(temp,'fixture.tsx'),name:'AppSecrets',formats:['iife']}}})
 const bundle=Array.isArray(result)?result[0]:result;assert.ok(bundle&&'output'in bundle)
 const browser=await loadPlaywright().chromium.launch(launchOptions());t.after(()=>browser.close());const page=await browser.newPage({viewport:{width:1280,height:900}});page.setDefaultTimeout(5000)
 const errors:string[]=[];page.on('pageerror',(error:Error)=>errors.push(error.message));await page.route('**/*',(route:any)=>route.abort());await page.setContent('<!doctype html><div id="root"></div>')
 await page.addStyleTag({content:bundle.output.flatMap(row=>row.type==='asset'&&row.fileName.endsWith('.css')?[String(row.source)]:[]).join('\n')});await page.addScriptTag({content:bundle.output.find(row=>row.type==='chunk')!.code})
 await page.getByRole('button',{name:/^需密钥技能\s*密钥入口核对$/}).click()
 const detail=page.getByRole('dialog',{name:'技能',exact:true}),button=detail.getByRole('button',{name:'需密钥技能 · 密钥：未填写',exact:true})
 await button.waitFor();assert.equal(await button.textContent(),'');assert.equal(await button.getAttribute('title'),'需密钥技能 · 密钥：未填写')
 await button.click();const config=page.getByRole('dialog',{name:'技能配置',exact:true});await config.getByLabel(/服务密钥/).waitFor();assert.equal(await config.locator('input[type=password]').inputValue(),'')
 await config.getByText('https://api.example.test/v1/',{exact:false}).waitFor();await config.getByRole('button',{name:'关闭',exact:true}).click()
 assert.equal(await page.getByRole('searchbox').inputValue(),'密钥');assert.equal(await detail.isVisible(),true)
 await detail.getByRole('button',{name:'关闭',exact:true}).click();await page.getByRole('button',{name:/^无密钥技能\s*密钥入口核对$/}).click()
 assert.equal(await page.getByRole('button',{name:/^无密钥技能 · 密钥/}).count(),0)
 await page.getByRole('dialog',{name:'技能',exact:true}).getByRole('button',{name:'关闭',exact:true}).click();await page.getByRole('searchbox').fill('组合技能库');await page.getByRole('button',{name:/^组合技能库/}).click()
 await page.getByRole('dialog',{name:'技能库',exact:true}).getByRole('button',{name:'需密钥技能 · 密钥：未填写',exact:true}).waitFor()
 const facts=await page.evaluate(()=>(window as any).appSecrets);assert.deepEqual(facts.opened,[{skill:'declared-method',title:'需密钥技能'}]);assert.deepEqual(facts.writes,[]);assert.ok(facts.described.every((skill:string)=>skill==='declared-method'));assert.deepEqual(errors,[])
})
