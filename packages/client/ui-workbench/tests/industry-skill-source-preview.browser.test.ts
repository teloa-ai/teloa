import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,writeFile,rm} from 'node:fs/promises'
import {fileURLToPath} from 'node:url'
import {join} from 'node:path'
import {build} from 'vite'
// @ts-expect-error 复用仓库无头浏览器加载器。
import {launchOptions,loadPlaywright} from './fixtures/load-playwright.mjs'

test('行业包技能原文预览不冒充安装状态，本地与公共引用都计入预览总数',{timeout:60000},async t=>{
 const root=fileURLToPath(new URL('../../../../',import.meta.url)),client=fileURLToPath(new URL('../src/client/',import.meta.url)),temp=await mkdtemp(join(root,'.runtime-industry-skill-source-'))
 t.after(()=>rm(temp,{recursive:true,force:true}))
 await writeFile(join(temp,'fixture.tsx'),`import React from 'react';import {createRoot} from 'react-dom/client';import {IndustryContents} from '${client}IndustryContents.tsx';import {inspectIndustryContent} from '${client}industry-content.ts';import {I18nProvider} from '${client}i18n/provider.tsx';import {translateMessage} from '${client}i18n/messages.ts';
 const skillText='---\\nname: investigation\\ndescription: 固定调查方法\\n---\\n只读调查原文。';
 const skill=(id,source={kind:'local',path:'skills/'+id+'/SKILL.md'})=>({id,kind:'skill',title:id,version:'1.0.0',required:true,source});
 const knowledge=id=>({id,kind:'knowledge',title:id,version:'1.0.0',required:true,source:{kind:'local',path:'knowledge/'+id+'.md'}});
 const file=(path,text)=>({path,hash:'a'.repeat(64),bytes:new TextEncoder().encode(text)});
 const base={format:'teloa.business-package/v2',id:'source-preview',title:'来源预览',version:'1.0.0',domain:'general',scope:'general',description:'内容预览',relations:[],entrypoints:[]};
 const local=Array.from({length:9},(_,i)=>skill('local-'+i)),publicSkill=skill('public-skill',{kind:'public',id:'shared-skill',version:'1.0.0'}),knowledgeRows=Array.from({length:18},(_,i)=>knowledge('guide-'+i));
 const manifest={...base,resources:[...local,publicSkill,...knowledgeRows]},content={manifestPath:'teloa.json',hash:'a'.repeat(64),resources:[],files:[...local.map(row=>file(row.source.path,skillText)),...knowledgeRows.map(row=>file(row.source.path,'# 固定资料'))]};
 const sourceInspection=inspectIndustryContent({...base,resources:[skill('shared-skill')]},{...content,files:[file('skills/shared-skill/SKILL.md',skillText)]})[0];
 content.resolved=[{resourceId:'public-skill',sourceResourceId:'shared-skill',kind:'skill',version:'1.0.0',inspection:sourceInspection}];
 const otherManifest={...base,resources:[knowledge('readable'),skill('missing'),skill('invalid'),{id:'tool',kind:'execution-tool',title:'tool',version:'1.0.0',required:false,source:{kind:'local',path:'tool.json'}},skill('unresolved',{kind:'public',id:'missing-public',version:'1.0.0'})]},otherContent={...content,resolved:[],files:[file('knowledge/readable.md','# 可读资料'),file('skills/invalid/SKILL.md','   '),file('tool.json','{}')]};
 const f=window.skillSourceFixture={inspections:inspectIndustryContent(manifest,content),otherInspections:inspectIndustryContent(otherManifest,otherContent)};
 function App(){const [locale,setLocale]=React.useState('zh-CN'),[other,setOther]=React.useState(false);f.setLocale=setLocale;f.setOther=setOther;const runtime=React.useMemo(()=>{const snapshot={locale,dshLocale:locale,revision:1};return {t:(key,params)=>translateMessage(locale,key,params),subscribe:()=>()=>{},getSnapshot:()=>snapshot}},[locale]);return <I18nProvider runtime={runtime}><IndustryContents manifest={other?otherManifest:manifest} content={other?otherContent:content} persisted/></I18nProvider>};createRoot(document.getElementById('root')).render(<App/>);`)
 await writeFile(join(temp,'crypto.ts'),'export function createHash(){throw Error("不应调用服务器摘要")};export function randomUUID(){return crypto.randomUUID()};export function createPublicKey(){throw Error("不应验证服务签名")};export function verify(){throw Error("不应验证服务签名")}')
 const built=await build({configFile:false,root,resolve:{alias:{'node:crypto':join(temp,'crypto.ts'),'@teloa/contract':join(root,'packages/contract/src/index.ts')}},logLevel:'error',define:{'process.env.NODE_ENV':'"development"'},build:{write:false,minify:false,lib:{entry:join(temp,'fixture.tsx'),name:'SkillSourcePreviewTest',formats:['iife']}}})
 const bundle=Array.isArray(built)?built[0]:built;assert.ok(bundle&&'output'in bundle)
 const browser=await loadPlaywright().chromium.launch(launchOptions());t.after(()=>browser.close())
 const page=await browser.newPage({viewport:{width:1440,height:1000}});t.after(()=>page.close());page.setDefaultTimeout(3000)
 const errors:string[]=[];page.on('pageerror',(e:Error)=>errors.push(e.message));await page.route('**/*',(route:any)=>route.abort())
 await page.setContent('<html><body><div id="root"></div></body></html>')
 await page.addStyleTag({content:bundle.output.flatMap(x=>x.type==='asset'&&x.fileName.endsWith('.css')?[String(x.source)]:[]).join('\n')})
 await page.addScriptTag({content:bundle.output.find(x=>x.type==='chunk')!.code})
 await page.getByRole('status').getByText(/已读取：28 项可预览，0 项需修正，0 项引用待核对，0 项待专用核验/).waitFor()
 assert.equal(await page.getByRole('option').count(),28)
 assert.equal(await page.getByRole('option').filter({hasText:'原文可预览'}).count(),10)
 assert.equal(await page.getByRole('option').filter({hasText:'等待适配'}).count(),0)
 for(const id of ['local-0','public-skill']){
  await page.getByRole('option',{name:new RegExp('^'+id+' ')}).click()
  assert.equal(await page.locator('pre').textContent(),'---\nname: investigation\ndescription: 固定调查方法\n---\n只读调查原文。')
  await page.getByText('技能原文已读取。本页展示包内内容；当前安装与可用状态请到“市场 > 我的应用与技能”核对，绑定情况请到“员工 > 能力”查看。',{exact:true}).waitFor()
  assert.equal(await page.getByText(/尚未安装|格式、依赖和运行条件还没检查/).count(),0)
 }
 assert.deepEqual(await page.evaluate(()=>(window as any).skillSourceFixture.inspections.filter((row:any)=>row.definition?.kind==='skill').map((row:any)=>row.state)),Array(10).fill('pending'),'预览不能跳过宿主核验或升级为运行就绪')
 await page.evaluate(()=>(window as any).skillSourceFixture.setLocale('en'))
 await page.getByRole('option').filter({hasText:'Source preview available'}).first().waitFor()
 assert.equal(await page.getByRole('option').filter({hasText:'Source preview available'}).count(),10)
 await page.getByText(/Check Market > My apps and skills/).waitFor()
 await page.evaluate(()=>{(window as any).skillSourceFixture.setLocale('zh-CN');(window as any).skillSourceFixture.setOther(true)})
 await page.getByRole('status').getByText(/已读取：1 项可预览，2 项需修正，1 项引用待核对，1 项待专用核验/).waitFor()
 assert.equal(await page.getByRole('option').filter({hasText:'原文可预览'}).count(),0)
 for(const [name,label] of [['missing','缺少内容'],['invalid','内容有问题'],['tool','等待适配'],['unresolved','引用待核对']])assert.ok((await page.getByRole('option',{name:new RegExp('^'+name+' ')}).textContent())?.includes(label))
 assert.deepEqual(errors,[])
})
