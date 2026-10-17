import {test,before,after} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,writeFile,rm} from 'node:fs/promises'
import {fileURLToPath} from 'node:url'
import {join} from 'node:path'
import {build} from 'vite'
import {employeeCopy} from '../src/client/employee-copy.ts'
// @ts-expect-error 既有无头浏览器加载器。
import {launchOptions,loadPlaywright} from './fixtures/load-playwright.mjs'

// D-135：入职表单必填为空时必须给出产品词典里的中文错误并聚焦该字段，
// 不能被浏览器原生约束校验抢先拦下（原生提示随系统语言，产品无法本地化也无法记入 aria-invalid）。
// 断言只看产品自己的 role=alert、aria-invalid 与焦点，不读任何浏览器气泡文案。

const root=fileURLToPath(new URL('../../../../',import.meta.url)),client=fileURLToPath(new URL('../src/client/',import.meta.url))
let browser:any,script:string,styles:string,temp:string
const entry=`
import tokens from '${client}theme-tokens.module.css';import React from 'react';import {createRoot} from 'react-dom/client';import {RoleForm} from '${client}TeamPage.tsx';import {I18nProvider} from '${client}i18n/provider.tsx';import {translateMessage} from '${client}i18n/messages.ts';import {prototypeThemes} from '${client}../brand/prototype-theme.ts';
for(const [key,value] of Object.entries(prototypeThemes.light))document.body.style.setProperty(key,value);
const locale='zh-CN',snapshot={locale,dshLocale:'zh',revision:1},runtime={t:(key,params)=>translateMessage(locale,key,params),subscribe:()=>()=>{},getSnapshot:()=>snapshot};
const work={readHomeSkills:async()=>[]},resources={directory:async()=>({resources:[]}),sources:async()=>[]};
document.body.className=tokens.tokens;window.hireFixture={saved:[]};
createRoot(document.getElementById('root')).render(<I18nProvider runtime={runtime}><RoleForm work={work} resourceApi={resources} persistent={false} close={()=>{}} save={value=>window.hireFixture.saved.push(value)}/></I18nProvider>);
`
before(async()=>{
 temp=await mkdtemp(join(root,'.runtime-hire-required-'));await writeFile(join(temp,'fixture.tsx'),entry)
 const result=await build({configFile:false,root,logLevel:'error',define:{'process.env.NODE_ENV':'"development"'},build:{write:false,minify:false,rollupOptions:{external:(id:string)=>id.startsWith('node:'),treeshake:{moduleSideEffects:false}},lib:{entry:join(temp,'fixture.tsx'),name:'HireRequiredFixture',formats:['iife']}}})
 const bundle=Array.isArray(result)?result[0]:result;assert.ok(bundle&&'output'in bundle)
 script=bundle.output.find(item=>item.type==='chunk')!.code
 styles=bundle.output.flatMap(item=>item.type==='asset'&&item.fileName.endsWith('.css')?[String(item.source)]:[]).join('\n')
 browser=await loadPlaywright().chromium.launch(launchOptions())
})
after(async()=>{await browser?.close();if(temp)await rm(temp,{recursive:true,force:true})})

async function open(t:any){
 const page=await browser.newPage({viewport:{width:1440,height:960}}),errors:string[]=[]
 page.setDefaultTimeout(6000);page.on('pageerror',(e:Error)=>errors.push(e.message))
 t.after(async()=>{await page.close();assert.deepEqual(errors,[])})
 await page.route('**/*',(route:any)=>route.abort())
 await page.setContent('<!doctype html><html lang="zh-CN"><body style="font-family:system-ui"><div id="root"></div></body></html>')
 await page.addStyleTag({content:styles});await page.addScriptTag({content:script})
 return {page,d:page.getByRole('dialog',{name:'添加 AI 员工',exact:true})}
}

test('岗位使命留空点下一步：产品中文必填错误可见、字段标记 aria-invalid 并获得焦点，仍停在原步骤',async t=>{
 const {page,d}=await open(t)
 await d.getByRole('textbox',{name:'名字',exact:true}).fill('必填验收')
 await d.getByRole('button',{name:'下一步',exact:true}).click()
 const mission=d.getByRole('textbox',{name:'岗位使命',exact:true})
 await mission.waitFor()
 await d.getByRole('button',{name:'下一步',exact:true}).click()
 // 产品自己的错误条必须出现，文案取自已有员工词典，不新增词条。
 const expected=employeeCopy('zh-CN','dutyRequired')
 const alerts=await d.getByRole('alert').allInnerTexts()
 assert.deepEqual(alerts,[expected],'必填错误必须是产品词典文案，而不是浏览器原生提示')
 assert.equal(await mission.getAttribute('aria-invalid'),'true','空必填字段必须标记 aria-invalid')
 assert.equal(await mission.evaluate((element:HTMLElement)=>element===document.activeElement),true,'焦点落在出错的岗位使命')
 // 必填语义保留：原生 required 仍在，字段仍被浏览器视为未通过校验。
 assert.equal(await mission.evaluate((element:HTMLTextAreaElement)=>element.required),true,'不能靠删 required 换取产品提示')
 assert.equal(await mission.evaluate((element:HTMLTextAreaElement)=>element.validity.valueMissing),true)
 assert.equal(await d.getByRole('heading',{name:'工作约定',exact:true}).count(),0,'校验未过不得进入下一屏')
 assert.equal(await page.evaluate(()=>(window as any).hireFixture.saved.length),0)
 // 补齐后错误消失并可继续。
 await mission.fill('只分析合成资料。')
 assert.equal(await d.getByRole('alert').count(),0)
 await d.getByRole('button',{name:'下一步',exact:true}).click()
 assert.equal(await d.getByRole('heading',{name:'工作约定',exact:true}).count(),1)
})

test('名字为空或仅空格点下一步：给出产品词典的姓名必填错误并聚焦名字',async t=>{
 const {d}=await open(t)
 const name=d.getByRole('textbox',{name:'名字',exact:true})
 for(const value of ['', '   ']){
  await name.fill(value)
  await d.getByRole('button',{name:'下一步',exact:true}).click()
  assert.deepEqual(await d.getByRole('alert').allInnerTexts(),[employeeCopy('zh-CN','nameRequired')])
  assert.equal(await name.getAttribute('aria-invalid'),'true')
  assert.equal(await name.evaluate((element:HTMLElement)=>element===document.activeElement),true)
 }
})
