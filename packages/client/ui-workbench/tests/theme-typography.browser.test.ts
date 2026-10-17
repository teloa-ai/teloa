import assert from 'node:assert/strict'
import test from 'node:test'
import {mkdtemp,rm,writeFile} from 'node:fs/promises'
import {fileURLToPath} from 'node:url'
import {join} from 'node:path'
import {build} from 'vite'
// @ts-expect-error 复用现有无头浏览器加载器。
import {loadPlaywright,launchOptions} from './fixtures/load-playwright.mjs'

test('主题公开快照即时更新三类字体和字号，清空恢复默认且卸载保留外来样式',async t=>{
 const root=fileURLToPath(new URL('../../../../',import.meta.url)),client=fileURLToPath(new URL('../src/client/',import.meta.url)),temp=await mkdtemp(join(root,'.runtime-theme-typography-'))
 t.after(()=>rm(temp,{recursive:true,force:true}))
 await writeFile(join(temp,'fixture.ts'),`import {ThemePresenter} from ${JSON.stringify(join(client,'theme-presenter.ts'))};
 document.body.style.setProperty('--dsh-code-font-size','10px');document.body.style.setProperty('--dsh-font-family-code','InitialCode');
 document.body.style.setProperty('--foreign-theme-value','kept');document.body.style.setProperty('font-family','InitialText');
 const theme=new ThemePresenter();window.themeFixture={apply:(value)=>theme.apply({active:{colorScheme:'light',tokens:{}},preference:'light',fontSizes:{text:14,code:11,terminal:13},fontFamilies:{text:'',code:'',terminal:''},...value}),dispose:()=>theme.dispose()};
 window.themeFixture.apply({});`)
 const built=await build({configFile:false,root,logLevel:'error',build:{write:false,minify:false,lib:{entry:join(temp,'fixture.ts'),name:'ThemeTypography',formats:['iife']}}})
 const bundle=Array.isArray(built)?built[0]:built;assert.ok(bundle&&'output'in bundle)
 const script=bundle.output.find(row=>row.type==='chunk')!.code
 const browser=await loadPlaywright().chromium.launch(launchOptions());t.after(()=>browser.close())
 const page=await browser.newPage();const errors:string[]=[];page.on('pageerror',(error:Error)=>errors.push(error.message))
 await page.route('**/*',(route:any)=>route.abort());await page.setContent('<!doctype html><body><p id="text">Text</p><pre id="code">Code</pre><div id="terminal">Terminal</div></body>')
 await page.addStyleTag({content:'#text{font-family:var(--teloa-design-font);font-size:var(--teloa-design-text-base)}#code{font-family:var(--dsh-font-family-code,monospace);font-size:var(--dsh-code-font-size,11px)}#terminal{font-family:var(--dsh-font-family-terminal,monospace);font-size:var(--dsh-terminal-font-size,13px)}'})
 await page.addScriptTag({content:script})
 const read=()=>page.evaluate(()=>Object.fromEntries(['text','code','terminal'].map(id=>{const style=getComputedStyle(document.getElementById(id)!);return [id,{size:style.fontSize,family:style.fontFamily}]})))
 const original=await read();assert.equal(original.text!.size,'14px');assert.match(original.text!.family,/-apple-system/)
 await page.evaluate(()=>(window as any).themeFixture.apply({fontSizes:{text:18,code:15,terminal:19},fontFamilies:{text:'Georgia',code:'Courier New',terminal:'Menlo'}}))
 const custom=await read();assert.equal(custom.text!.size,'18px');assert.equal(custom.text!.family,'Georgia');assert.equal(custom.code!.size,'15px');assert.match(custom.code!.family,/Courier New/);assert.equal(custom.terminal!.size,'19px');assert.equal(custom.terminal!.family,'Menlo')
 await page.evaluate(()=>(window as any).themeFixture.apply({}));const reset=await read();assert.deepEqual(reset,original,'清空本人设置恢复同一默认字体与字号')
 await page.evaluate(()=>{document.body.style.setProperty('--dsh-terminal-font-size','17px');document.body.style.setProperty('font-family','ForeignText');(window as any).themeFixture.dispose()})
 const disposed=await page.evaluate(()=>Object.fromEntries(['--dsh-code-font-size','--dsh-font-family-code','--dsh-terminal-font-size','--foreign-theme-value','font-family'].map(key=>[key,document.body.style.getPropertyValue(key)])))
 assert.deepEqual(disposed,{'--dsh-code-font-size':'10px','--dsh-font-family-code':'InitialCode','--dsh-terminal-font-size':'17px','--foreign-theme-value':'kept','font-family':'ForeignText'});assert.deepEqual(errors,[])
})
