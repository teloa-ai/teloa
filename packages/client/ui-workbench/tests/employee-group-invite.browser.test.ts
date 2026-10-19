import {test,before,after} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,writeFile,mkdir,rm} from 'node:fs/promises'
import {fileURLToPath} from 'node:url'
import {join} from 'node:path'
import {build} from 'vite'
// @ts-expect-error 既有无头浏览器加载器。
import {launchOptions,loadPlaywright} from './fixtures/load-playwright.mjs'

const root=fileURLToPath(new URL('../../../../',import.meta.url)),client=fileURLToPath(new URL('../src/client/',import.meta.url))
let browser:any,script:string,styles:string,temp:string
const entry=`
import React,{useState} from 'react';import {createRoot} from 'react-dom/client';import {EmployeeGroupInvite} from '${client}EmployeeGroupInvite.tsx';import {BusinessScopeProvider} from '${client}business-scope-context.tsx';import {I18nProvider} from '${client}i18n/provider.tsx';import {translateMessage} from '${client}i18n/messages.ts';import tokens from '${client}theme-tokens.module.css';import {prototypeThemes} from '${client}../brand/prototype-theme.ts';
Object.entries(prototypeThemes.light).forEach(([key,value])=>document.body.style.setProperty(key,value));document.body.classList.add(tokens.tokens);
const locale=window.fixtureLocale||'zh-CN',en=locale==='en',snapshot={locale,dshLocale:'zh',revision:1},runtime={t:(key,params)=>translateMessage(locale,key,params),subscribe:()=>()=>{},getSnapshot:()=>snapshot};
const role={id:'employee-1',name:en?'Product researcher':'产品研究员',avatarKey:'security-analyst',kind:'employee',state:'active',storage:'persistent',version:3,scopes:['general'],skills:[],knowledge:[],duty:'Research supplied sources',dataScope:'Supplied sources only',executionScope:'Draft only'};
const rules={historyVisibleToNewMembers:false,draftsVisibleInGroup:false,mentionAllAllowed:false};
const groups=[{id:'g1',name:en?'Product launch':'新品发布',purpose:en?'Prepare the next launch':'准备下一次产品发布'},{id:'g2',name:en?'Content research':'内容研究',purpose:en?'Compare sources and prepare content':'核对资料，准备内容'},{id:'g3',name:'Archived',archived:true},{id:'g4',name:'Already joined'}].map(item=>({scope:'general',version:4,announcement:'Original announcement',rules,pinned:true,archived:false,...item}));
window.inviteFixture={writes:[],closed:0,invited:[],failLoad:window.fixtureFailLoad};
const api={list:async()=>{if(window.inviteFixture.failLoad)throw Error('Unable to read groups');return {items:groups}},get:async id=>({group:groups.find(item=>item.id===id),members:[{groupId:id,roleId:null},{groupId:id,roleId:id==='g4'?role.id:'another'}]}),change:async(id,version,fields)=>{window.inviteFixture.writes.push({id,version,fields});return {group:{...groups.find(item=>item.id===id),...fields},members:[]}}};
function App(){const[open,setOpen]=useState(true);return <I18nProvider runtime={runtime}><BusinessScopeProvider labels={[{scope:'general',title:'通用工作'}]}><button onClick={()=>setOpen(true)}>Open invite</button>{open&&<EmployeeGroupInvite role={role} api={api} close={()=>{window.inviteFixture.closed++;setOpen(false)}} invited={id=>window.inviteFixture.invited.push(id)}/>}</BusinessScopeProvider></I18nProvider>}createRoot(document.getElementById('root')).render(<App/>);
`
before(async()=>{
 temp=await mkdtemp(join(root,'.runtime-invite-ui-'));await writeFile(join(temp,'fixture.tsx'),entry)
 const result=await build({configFile:false,root,logLevel:'error',define:{'process.env.NODE_ENV':'"development"'},build:{write:false,minify:false,rollupOptions:{external:(id:string)=>id.startsWith('node:'),treeshake:{moduleSideEffects:false}},lib:{entry:join(temp,'fixture.tsx'),name:'InviteFixture',formats:['iife']}}})
 const bundle=Array.isArray(result)?result[0]:result;assert.ok(bundle&&'output'in bundle)
 script=bundle.output.find(item=>item.type==='chunk')!.code
 styles=bundle.output.flatMap(item=>item.type==='asset'&&item.fileName.endsWith('.css')?[String(item.source)]:[]).join('\n')
 browser=await loadPlaywright().chromium.launch(launchOptions())
})
after(async()=>{await browser?.close();if(temp)await rm(temp,{recursive:true,force:true})})
async function mount(t:any,locale='zh-CN',width=1440,failLoad=false){
 const page=await browser.newPage({viewport:{width,height:900}}),errors:string[]=[]
 page.setDefaultTimeout(3000);page.on('pageerror',(error:Error)=>errors.push(error.message));t.after(async()=>{await page.close();assert.deepEqual(errors,[])})
 await page.route('**/*',(route:any)=>route.abort());await page.setContent('<!doctype html><html><body style="margin:0;font-family:system-ui"><div id="root"></div></body></html>')
 await page.evaluate(({locale,failLoad}:{locale:string;failLoad:boolean})=>{(window as any).fixtureLocale=locale;(window as any).fixtureFailLoad=failLoad},{locale,failLoad})
 await page.addStyleTag({content:styles});await page.addScriptTag({content:script});await page.getByRole('dialog').waitFor()
 return page
}
test('邀请抽屉在三语及窄窗口保留正文边距，群列表直接可见且无横向溢出',async t=>{
 for(const locale of ['zh-CN','zh-TW','en'])for(const width of [1440,390]){
  const page=await mount(t,locale,width),dialog=page.getByRole('dialog')
  await dialog.locator('input,select').first().waitFor()
  const box=await dialog.locator('input,select').first().evaluate((node:HTMLElement)=>{const control=node.getBoundingClientRect(),drawer=node.closest('dialog')!.getBoundingClientRect();return{left:control.left-drawer.left,right:drawer.right-control.right,overflow:document.documentElement.scrollWidth>innerWidth}})
  assert.ok(box.left>=19&&box.right>=19,JSON.stringify({locale,width,...box}));assert.equal(box.overflow,false)
  assert.equal(await dialog.getByRole('combobox').count(),0);assert.equal(await dialog.getByRole('radio').count(),2)
  if(process.env.TELOA_INVITE_UI_OUTPUT){await mkdir(process.env.TELOA_INVITE_UI_OUTPUT,{recursive:true});await page.screenshot({path:join(process.env.TELOA_INVITE_UI_OUTPUT,locale+'-'+width+'.png')})}
 }
})
test('搜索及所选群关闭后恢复，仅明确提交时加入一次并保留原群设置',async t=>{
 const page=await mount(t),dialog=page.getByRole('dialog')
 await dialog.getByRole('searchbox').fill('内容');assert.equal(await dialog.getByRole('radio').count(),1);await dialog.getByRole('radio').check()
 await page.keyboard.press('Escape');await page.getByRole('button',{name:'Open invite'}).click()
 assert.equal(await dialog.getByRole('searchbox').inputValue(),'内容');assert.equal(await dialog.getByRole('radio',{checked:true}).inputValue(),'g2')
 assert.deepEqual(await page.evaluate(()=>(window as any).inviteFixture.writes),[])
 await dialog.getByRole('button',{name:'加入群',exact:true}).click();await dialog.waitFor({state:'detached'})
 assert.deepEqual(await page.evaluate(()=>(window as any).inviteFixture.writes),[{id:'g2',version:4,fields:{name:'内容研究',announcement:'Original announcement',rules:{historyVisibleToNewMembers:false,draftsVisibleInGroup:false,mentionAllAllowed:false},memberRoleIds:['another','employee-1'],pinned:true,archived:false}}])
 assert.deepEqual(await page.evaluate(()=>(window as any).inviteFixture.invited),['g2'])
})
test('读取失败可重试，无匹配群时明确提示且不会提交',async t=>{
 const page=await mount(t,'zh-CN',1440,true),dialog=page.getByRole('dialog')
 await dialog.getByRole('alert').waitFor();assert.equal(await dialog.getByRole('button',{name:'加入群',exact:true}).isDisabled(),true)
 await page.evaluate(()=>{(window as any).inviteFixture.failLoad=false});await dialog.getByRole('button',{name:'重试',exact:true}).click();await dialog.getByRole('radio').first().waitFor()
 await dialog.getByRole('searchbox').fill('not-a-group');await dialog.getByRole('status').waitFor();assert.equal(await dialog.getByRole('radio').count(),0)
 assert.deepEqual(await page.evaluate(()=>(window as any).inviteFixture.writes),[])
})
