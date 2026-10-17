import {test,before,after} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,writeFile,rm} from 'node:fs/promises'
import {fileURLToPath} from 'node:url'
import {join} from 'node:path'
import {build} from 'vite'
// @ts-expect-error 既有无头浏览器加载器。
import {launchOptions,loadPlaywright} from './fixtures/load-playwright.mjs'

const root=fileURLToPath(new URL('../../../../',import.meta.url)),client=fileURLToPath(new URL('../src/client/',import.meta.url))
let browser:any,script:string,styles:string,temp:string
const entry=`
import tokens from '${client}theme-tokens.module.css';import React from 'react';import {createRoot} from 'react-dom/client';import {RoleForm} from '${client}TeamPage.tsx';import {I18nProvider} from '${client}i18n/provider.tsx';import {translateMessage} from '${client}i18n/messages.ts';import {prototypeThemes} from '${client}../brand/prototype-theme.ts';
for(const [key,value] of Object.entries(prototypeThemes.light))document.body.style.setProperty(key,value);
const locale='zh-CN',snapshot={locale,dshLocale:'zh',revision:1},runtime={t:(key,params)=>translateMessage(locale,key,params),subscribe:()=>()=>{},getSnapshot:()=>snapshot};
const work={readHomeSkills:async()=>[]},resources={directory:async()=>({resources:[]}),sources:async()=>[]};
document.body.className=tokens.tokens;window.hireFixture={saved:[],sentence:(action,level)=>translateMessage(locale,'team.hire.action.'+action+'.'+level)};
createRoot(document.getElementById('root')).render(<I18nProvider runtime={runtime}><RoleForm work={work} resourceApi={resources} persistent={false} close={()=>{}} save={value=>window.hireFixture.saved.push(value)}/></I18nProvider>);
`
before(async()=>{
 temp=await mkdtemp(join(root,'.runtime-hire-boundary-'));await writeFile(join(temp,'fixture.tsx'),entry)
 const result=await build({configFile:false,root,logLevel:'error',define:{'process.env.NODE_ENV':'"development"'},build:{write:false,minify:false,rollupOptions:{external:(id:string)=>id.startsWith('node:'),treeshake:{moduleSideEffects:false}},lib:{entry:join(temp,'fixture.tsx'),name:'HireBoundaryFixture',formats:['iife']}}})
 const bundle=Array.isArray(result)?result[0]:result;assert.ok(bundle&&'output'in bundle)
 script=bundle.output.find(item=>item.type==='chunk')!.code
 styles=bundle.output.flatMap(item=>item.type==='asset'&&item.fileName.endsWith('.css')?[String(item.source)]:[]).join('\n')
 browser=await loadPlaywright().chromium.launch(launchOptions())
})
after(async()=>{await browser?.close();if(temp)await rm(temp,{recursive:true,force:true})})
async function mount(t:any){
 const page=await browser.newPage({viewport:{width:1440,height:960}}),errors:string[]=[]
 page.setDefaultTimeout(6000);page.on('pageerror',(e:Error)=>errors.push(e.message))
 t.after(async()=>{await page.close();assert.deepEqual(errors,[])})
 await page.route('**/*',(route:any)=>route.abort())
 await page.setContent('<!doctype html><html lang="zh-CN"><body style="font-family:system-ui"><div id="root"></div></body></html>')
 await page.addStyleTag({content:styles});await page.addScriptTag({content:script})
 const d=page.getByRole('dialog',{name:'添加 AI 员工',exact:true})
 await d.getByRole('textbox',{name:'名字',exact:true}).fill('边界验收')
 await d.getByRole('button',{name:'下一步',exact:true}).click()
 await d.getByRole('textbox',{name:'岗位使命',exact:true}).fill('只分析合成资料。')
 await d.getByRole('button',{name:'下一步',exact:true}).click()
  assert.equal(await d.getByRole('heading',{name:'工作约定',exact:true}).count(),1)
  assert.ok((await d.innerText()).includes('执行审批继承平台设置'))
 return {page,d}
}
test('五类工作偏好的每个选项在真实表单中有独立选中反馈，悬停不抹掉选中态',async t=>{
 const {page,d}=await mount(t),groups=d.getByRole('radiogroup');assert.equal(await groups.count(),5)
 for(let row=0;row<5;row++)for(const name of ['自主处理','先征询','不安排']){
  const g=groups.nth(row),chosen=g.getByRole('radio',{name,exact:true})
  await chosen.click();await page.mouse.move(0,0)
  assert.equal(await chosen.getAttribute('aria-checked'),'true');assert.equal(await g.getByRole('radio',{checked:true}).count(),1)
  const style=(e:HTMLElement)=>({background:getComputedStyle(e).backgroundColor,color:getComputedStyle(e).color})
  const checked=await chosen.evaluate(style),unchecked=await g.getByRole('radio',{checked:false}).first().evaluate(style)
  assert.notEqual(checked.background,unchecked.background);assert.notEqual(checked.color,unchecked.color)
  await chosen.hover();assert.deepEqual(await chosen.evaluate(style),checked)
 }
})
test('工作约定单选支持方向键与首尾键，返回步骤保留选择，保存得到对应职责字段',async t=>{
 const {page,d}=await mount(t),groups=d.getByRole('radiogroup'),first=groups.first()
 assert.equal(await first.locator('[tabindex="0"]').count(),1)
 await first.getByRole('radio',{name:'自主处理',exact:true}).focus();await page.keyboard.press('ArrowRight')
 assert.equal(await first.getByRole('radio',{name:'先征询',exact:true}).getAttribute('aria-checked'),'true')
 await page.keyboard.press('End');assert.equal(await first.getByRole('radio',{name:'不安排',exact:true}).getAttribute('aria-checked'),'true')
 await page.keyboard.press('Home');assert.equal(await first.getByRole('radio',{name:'自主处理',exact:true}).getAttribute('aria-checked'),'true')
 await page.keyboard.press('ArrowLeft');assert.equal(await first.getByRole('radio',{name:'不安排',exact:true}).getAttribute('aria-checked'),'true')
 await page.keyboard.press('Tab');assert.equal(await groups.nth(1).getByRole('radio',{checked:true}).evaluate((e:HTMLElement)=>e===document.activeElement),true)
 const final=['不安排','先征询','自主处理','不安排','先征询']
 for(let i=0;i<5;i++)await groups.nth(i).getByRole('radio',{name:final[i],exact:true}).click()
 await d.getByRole('button',{name:'上一步',exact:true}).click();await d.getByRole('button',{name:'下一步',exact:true}).click()
 for(let i=0;i<5;i++)assert.equal(await groups.nth(i).getByRole('radio',{checked:true}).innerText(),final[i])
 await d.getByRole('button',{name:'下一步',exact:true}).click();await d.getByRole('button',{name:'让它上班',exact:true}).click()
 const saved=await page.evaluate(()=>(window as any).hireFixture.saved);assert.equal(saved.length,1)
 const value=saved[0],sentences=await page.evaluate(()=>(['read.never','change.never','think.ask','send.ask','draft.self']).map(key=>(window as any).hireFixture.sentence(...key.split('.')))),sentence=(action:string,level:string)=>sentences[['read.never','change.never','think.ask','send.ask','draft.self'].indexOf(action+'.'+level)]
 assert.ok(value.executionScope.includes(sentence('read','never')));assert.ok(value.executionScope.includes(sentence('change','never')))
 assert.ok(value.responsibility.confirmationPoints.includes(sentence('think','ask')));assert.ok(value.responsibility.confirmationPoints.includes(sentence('send','ask')))
 assert.ok(value.responsibility.autonomousActions.includes(sentence('draft','self')))
})
test('手改边界后重复点当前选项不触发覆盖，改变选项须明确确认且可取消',async t=>{
 const {d}=await mount(t)
 await d.getByRole('button',{name:'下一步',exact:true}).click()
 await d.locator('summary').filter({hasText:'展开逐条改'}).click()
 const execution=d.getByRole('textbox',{name:'执行范围',exact:true}),original=await execution.inputValue()
 await execution.fill(original+'；本轮手动补充，不允许删除原始文件。')
 await d.getByRole('button',{name:'上一步',exact:true}).click()
 const group=d.getByRole('radiogroup').first()
 await group.getByRole('radio',{name:'自主处理',exact:true}).click();assert.equal(await d.getByRole('alert').count(),0)
 await group.getByRole('radio',{name:'先征询',exact:true}).click();assert.equal(await group.getByRole('radio',{checked:true}).innerText(),'自主处理')
 await d.getByRole('button',{name:'先不改',exact:true}).click();assert.equal(await d.getByRole('alert').count(),0)
 await d.getByRole('button',{name:'下一步',exact:true}).click();await d.locator('summary').filter({hasText:'展开逐条改'}).click()
 assert.ok((await execution.inputValue()).includes('本轮手动补充'))
 await d.getByRole('button',{name:'上一步',exact:true}).click();await group.getByRole('radio',{name:'先征询',exact:true}).click()
 await d.getByRole('button',{name:'仍然覆盖',exact:true}).click();assert.equal(await group.getByRole('radio',{checked:true}).innerText(),'先征询')
})
