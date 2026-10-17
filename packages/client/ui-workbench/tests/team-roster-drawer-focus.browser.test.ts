import {test,before,after} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,writeFile,rm} from 'node:fs/promises'
import {fileURLToPath} from 'node:url'
import {join} from 'node:path'
import {build} from 'vite'
// @ts-expect-error 既有无头浏览器加载器。
import {launchOptions,loadPlaywright} from './fixtures/load-playwright.mjs'

// D-14 回归：员工名录点开档案抽屉，Escape 关闭后焦点必须回到打开它的那一行员工按钮，
// 不落到 BODY、不落到页面容器。二级面板（更多操作里的抽屉）先关自己并回到它的入口，
// 再按一次才关档案抽屉。真实 TeamPage + 真实 ContextDrawer，不在测试里替换焦点行为。

const root=fileURLToPath(new URL('../../../../',import.meta.url)),client=fileURLToPath(new URL('../src/client/',import.meta.url))
let browser:any,script:string,styles:string,temp:string
const entry=`
import tokens from '${client}theme-tokens.module.css';import React,{useState} from 'react';import {createRoot} from 'react-dom/client';import {TeamPage} from '${client}TeamPage.tsx';import {I18nProvider} from '${client}i18n/provider.tsx';import {translateMessage} from '${client}i18n/messages.ts';import {emptyTaskPreview} from '${client}task-preview.ts';import {emptyCollaboration} from '${client}collaboration-preview.ts';import {prototypeThemes} from '${client}../brand/prototype-theme.ts';
for(const [key,value] of Object.entries(prototypeThemes.light))document.body.style.setProperty(key,value);
document.body.className=tokens.tokens;
const locale='zh-CN',snapshot={locale,dshLocale:'zh',revision:1},runtime={t:(key,params)=>translateMessage(locale,key,params),subscribe:()=>()=>{},getSnapshot:()=>snapshot};
const roles=[
 {id:'role-1',name:'原员工甲',kind:'employee',avatarKey:'general',scopes:['general'],state:'active',version:1,duty:'核对合成告警证据。',dataScope:'仅限只读日志',executionScope:'只读与代拟',skills:[],knowledge:[],memories:[],history:[]},
 {id:'role-2',name:'原员工乙',kind:'employee',avatarKey:'general',scopes:['general'],state:'active',version:1,duty:'整理合成资料摘要。',dataScope:'仅限只读日志',executionScope:'只读与代拟',skills:[],knowledge:[],memories:[],history:[]},
];
const labels=[{scope:'general',title:'通用工作',kind:'builtin',loads:0,activeLoads:0,tasks:0,groups:0}];
const noop=()=>{},noopNode=()=>null;
function App(){
 const [selected,setSelected]=useState(null);
 return <main id="teloa-main" tabIndex={-1}><TeamPage visible work={{}} resourceApi={{directory:async()=>({resources:[]}),sources:async()=>[]}} conversations={noopNode}
  state={{...emptyTaskPreview(),roles}} collaboration={emptyCollaboration()} scopeLabels={labels}
  selected={selected} select={setSelected} change={noop} openTask={noop} openGroup={noop} resources={noop} nativeSettings={noop}
  capabilities={noopNode} plans={noopNode}/></main>
}
createRoot(document.getElementById('root')).render(<I18nProvider runtime={runtime}><App/></I18nProvider>);
`
before(async()=>{
 temp=await mkdtemp(join(root,'.runtime-roster-drawer-'));await writeFile(join(temp,'fixture.tsx'),entry)
 const result=await build({configFile:false,root,logLevel:'error',define:{'process.env.NODE_ENV':'"development"'},build:{write:false,minify:false,rollupOptions:{external:(id:string)=>id.startsWith('node:'),treeshake:{moduleSideEffects:false}},lib:{entry:join(temp,'fixture.tsx'),name:'RosterDrawerFixture',formats:['iife']}}})
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
 const entryButton=(name:string)=>page.locator('[data-teloa-pane="directory"] [data-teloa-entry]').filter({hasText:name})
 const activeDescription=()=>page.evaluate(()=>{
  const active=document.activeElement as HTMLElement|null
  if(!active)return 'none'
  return active.tagName+'|'+(active.dataset?.teloaEntry??'')+'|'+(active.textContent??'').slice(0,20)
 })
 return {page,entryButton,activeDescription}
}

test('名录打开档案抽屉后 Escape：抽屉关闭，焦点回到同一行员工入口，不落 BODY',async t=>{
 const {page,entryButton,activeDescription}=await open(t)
 const first=entryButton('原员工甲')
 await first.click()
 await page.getByRole('dialog',{name:'原员工甲',exact:true}).waitFor()
 await page.keyboard.press('Escape')
 assert.equal(await page.locator('dialog[open]').count(),0,'Escape 必须真的关闭档案抽屉')
 assert.equal(await first.evaluate((element:HTMLElement)=>element===document.activeElement),true,'焦点必须回到打开它的员工行按钮，实际='+await activeDescription())
 // 回到入口后按 Enter 能再次打开，证明焦点落在可用入口上而不是容器。
 await page.keyboard.press('Enter')
 await page.getByRole('dialog',{name:'原员工甲',exact:true}).waitFor()
})

test('档案抽屉里打开二级面板：第一次 Escape 只关二级并回到面板入口，第二次关档案并回到名录行',async t=>{
 const {page,entryButton,activeDescription}=await open(t)
 const first=entryButton('原员工甲')
 await first.click()
 const profile=page.getByRole('dialog',{name:'原员工甲',exact:true})
 await profile.waitFor()
 const menuEntry=profile.getByRole('button',{name:'更多员工操作',exact:true})
 await menuEntry.click()
 const panelEntry=profile.getByRole('button',{name:'它记得的事',exact:true})
 await panelEntry.waitFor()
 await panelEntry.click()
 await page.getByRole('dialog',{name:'它记得的事',exact:true}).waitFor()
 assert.equal(await page.locator('dialog[open]').count(),2)
 await page.keyboard.press('Escape')
 assert.equal(await page.getByRole('dialog',{name:'它记得的事',exact:true}).count(),0,'第一次 Escape 只关二级面板')
 assert.equal(await page.locator('dialog[open]').count(),1,'档案抽屉不接收二级面板的 cancel')
 assert.equal(await menuEntry.evaluate((element:HTMLElement)=>element===document.activeElement),true,'二级面板关闭必须回到可见的原操作菜单入口')
 await page.keyboard.press('Escape')
 assert.equal(await page.locator('dialog[open]').count(),0)
 assert.equal(await first.evaluate((element:HTMLElement)=>element===document.activeElement),true,'焦点必须回到名录行，实际='+await activeDescription())
})

test('先打开甲再打开乙：关闭后焦点回到最后打开它的那一行，不回到上一行',async t=>{
 const {page,entryButton,activeDescription}=await open(t)
 await entryButton('原员工甲').click()
 await page.getByRole('dialog',{name:'原员工甲',exact:true}).waitFor()
 await page.keyboard.press('Escape')
 const second=entryButton('原员工乙')
 await second.click()
 await page.getByRole('dialog',{name:'原员工乙',exact:true}).waitFor()
 await page.keyboard.press('Escape')
 assert.equal(await page.locator('dialog[open]').count(),0)
 assert.equal(await second.evaluate((element:HTMLElement)=>element===document.activeElement),true,'焦点必须回到乙，实际='+await activeDescription())
})

test('派活表单继续使用原生约束校验，不继承员工配置的产品校验开关',async t=>{
 const {page,entryButton}=await open(t)
 await entryButton('原员工甲').click()
 const profile=page.getByRole('dialog',{name:'原员工甲',exact:true})
 await profile.getByRole('button',{name:'交给它一件事',exact:true}).click()
 const assignment=page.locator('dialog[open]').last()
 assert.equal(await page.locator('dialog[open]').count(),2)
 assert.equal(await assignment.locator('form').evaluate((form:HTMLFormElement)=>form.noValidate),false)
 assert.equal(await assignment.locator('input[required]').count(),1)
 assert.equal(await assignment.locator('textarea[required]').count(),1)
})
