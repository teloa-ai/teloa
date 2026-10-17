import {test,before,after} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,writeFile,rm} from 'node:fs/promises'
import {fileURLToPath} from 'node:url'
import {join} from 'node:path'
import {build} from 'vite'
// @ts-expect-error 既有无头浏览器加载器。
import {launchOptions,loadPlaywright} from './fixtures/load-playwright.mjs'

const root=fileURLToPath(new URL('../../../../',import.meta.url)),client=fileURLToPath(new URL('../src/client/',import.meta.url))
let browser:any,script:string,temp:string
before(async()=>{
 temp=await mkdtemp(join(root,'.runtime-minimax-settings-'))
 await writeFile(join(temp,'fixture.tsx'),`import React from 'react';import {createRoot} from 'react-dom/client';import {MiniMaxVoiceSettings} from '${client}MiniMaxVoiceSettings.tsx';import {publishSettingsPanelVisible} from '${client}AutoDreamSettingsPage.tsx';import {I18nProvider} from '${client}i18n/provider.tsx';import {translateMessage} from '${client}i18n/messages.ts';
 const locale=window.voiceOptions?.locale??'zh-CN',snapshot={locale,dshLocale:'zh',revision:1},runtime={t:(key,params)=>translateMessage(locale,key,params),subscribe:()=>()=>{},getSnapshot:()=>snapshot};
 let status={providerId:'minimax',configured:false,writable:true,secure:true,model:'speech-2.8-turbo',voiceId:'male-qn-qingse',providers:[{id:'minimax',name:'MiniMax',configured:false,model:'speech-2.8-turbo',voiceId:'male-qn-qingse'},{id:'openai',name:'OpenAI',configured:true,model:'gpt-4o-mini-tts',voiceId:'alloy'},{id:'elevenlabs',name:'ElevenLabs',configured:true,model:'eleven_multilingual_v2',voiceId:'JBFqnCBsd6RMkjVDRZzb'}],asr:{providerId:'minimax',configured:false}};window.voiceFixture={saves:0,tests:0,aborted:0,failSave:false,holdStatus:false,requests:[]};
 const options=window.voiceOptions??{};if(options.minimaxReady){status.configured=true;status.providers[0].configured=true;status.asr.configured=true}if(options.ttsProvider){const p=status.providers.find(p=>p.id===options.ttsProvider);status={...status,...p,providerId:p.id};delete status.id;delete status.name}if(options.asrProvider)status.asr={providerId:options.asrProvider,configured:options.localReady??false};
 window.voiceFixture.replaceSpeech=voiceId=>{status={...status,voiceId,providers:status.providers.map(p=>p.id===status.providerId?{...p,voiceId}:p)}};window.voiceFixture.readStatus=()=>structuredClone(status);
 const api={status:()=>{const snapshot=structuredClone(status);return window.voiceFixture.holdStatus?new Promise(resolve=>{window.voiceFixture.releaseStatus=()=>resolve(snapshot)}):Promise.resolve(snapshot)},save:async input=>{window.voiceFixture.saves++;window.voiceFixture.requests.push(input);if(window.voiceFixture.failSave)throw Error('failure');const providers=status.providers.map(p=>p.id===input.providerId?{...p,...(input.model?{model:input.model}:{}),voiceId:input.voiceId,configured:p.configured||!!input.apiKey}:p),selected=providers.find(p=>p.id===(!('providerId'in input)||input.setDefault===false?status.providerId:input.providerId)),asrProviderId=input.asrProviderId??status.asr.providerId;status={...status,...selected,providerId:selected.id,providers,asr:{providerId:asrProviderId,configured:asrProviderId==='minimax'?providers[0].configured:options.localReady??false}};delete status.id;delete status.name;return structuredClone(status)},test:(providerId,signal,voice)=>{window.voiceFixture.tests++;window.voiceFixture.previewVoice=voice;window.voiceFixture.previewProvider=providerId;if(window.voiceFixture.failPreview)return Promise.reject(Error('preview failed'));signal.addEventListener('abort',()=>{window.voiceFixture.aborted++});return new Promise(resolve=>{window.voiceFixture.releasePreview=()=>resolve({providerId,tts:true,mime:'audio/mpeg',audio:'SUQzAA=='})})}};
 window.voiceFixture.visibility=publishSettingsPanelVisible;createRoot(document.getElementById('root')).render(<I18nProvider runtime={runtime}><MiniMaxVoiceSettings api={api}/></I18nProvider>);`)
 const result=await build({configFile:false,root,logLevel:'error',define:{'process.env.NODE_ENV':'"development"'},build:{write:false,minify:false,rollupOptions:{external:(id:string)=>id.startsWith('node:')},lib:{entry:join(temp,'fixture.tsx'),name:'VoiceSettingsFixture',formats:['iife']}}})
 const bundle=Array.isArray(result)?result[0]:result;assert.ok(bundle&&'output'in bundle);script=bundle.output.find(item=>item.type==='chunk')!.code
 browser=await loadPlaywright().chromium.launch(launchOptions())
})
after(async()=>{await browser?.close();if(temp)await rm(temp,{recursive:true,force:true})})
async function mount(t:any,options:Record<string,unknown>={}){
 const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors:string[]=[];page.setDefaultTimeout(3000);page.on('pageerror',(e:Error)=>errors.push(e.message))
 t.after(async()=>{await page.close();assert.deepEqual(errors,[])})
 await page.route('**/*',(route:any)=>route.abort());await page.setContent('<!doctype html><html lang="zh-CN"><body><div id="root"></div></body></html>');await page.evaluate((value:Record<string,unknown>)=>{(window as any).voiceOptions=value},options);await page.addScriptTag({content:script})
 await page.getByLabel('API Key',{exact:true}).waitFor({state:'attached'});await page.waitForFunction(()=>!document.querySelector('input')!.disabled)
 return page
}
test('设置不自动测试；保存失败保留输入、取消不写入、成功清空密钥',async t=>{
 const page=await mount(t),input=page.getByLabel('API Key',{exact:true})
 assert.equal(await page.evaluate(()=>(window as any).voiceFixture.tests),0)
 await input.fill('fixture-key');await page.evaluate(()=>(window as any).voiceFixture.failSave=true);await page.getByRole('button',{name:'保存',exact:true}).click();await page.getByRole('alert').waitFor()
 assert.equal(await input.inputValue(),'fixture-key');await page.getByRole('button',{name:'取消',exact:true}).click();assert.equal(await input.inputValue(),'');assert.equal(await page.evaluate(()=>(window as any).voiceFixture.saves),1)
 await page.evaluate(()=>(window as any).voiceFixture.failSave=false);await input.fill('fixture-key');await page.getByRole('button',{name:'保存',exact:true}).click();await page.getByText('已保存凭据',{exact:true}).waitFor();assert.equal(await input.inputValue(),'')
})

test('本机识别需显式保存且无需密钥，仅提交来源补丁并保留未提交播报草稿',async t=>{
 const page=await mount(t,{ttsProvider:'openai',localReady:true}),recognition=page.getByRole('region',{name:'语音识别',exact:true}),select=recognition.getByRole('combobox',{name:'识别来源',exact:true})
 assert.deepEqual(await select.locator('option').allTextContents(),['MiniMax 云端','SenseVoice 本机'])
 await page.getByLabel('音色 ID',{exact:true}).fill('coral');await page.getByRole('combobox',{name:'播报厂商',exact:true}).selectOption('elevenlabs')
 await select.selectOption('sensevoice-local')
 assert.equal(await recognition.locator('input[type=password]').count(),0)
 assert.equal(await page.evaluate(()=>(window as any).voiceFixture.saves),0)
 assert.equal(await page.evaluate(()=>(window as any).voiceFixture.tests),0)
 await recognition.getByText('复用本机语音输入的 SenseVoice 模型；无需 API Key。尚未就绪时，请到语音输入设置准备模型。',{exact:true}).waitFor()
 await recognition.getByRole('button',{name:'保存识别设置',exact:true}).click();await recognition.getByRole('status').waitFor()
 assert.deepEqual(await page.evaluate(()=>(window as any).voiceFixture.requests),[{asrProviderId:'sensevoice-local'}])
 await recognition.getByText('SenseVoice 本机 · 已就绪',{exact:true}).waitFor()
 assert.equal(await page.getByRole('combobox',{name:'播报厂商',exact:true}).inputValue(),'elevenlabs')
 await page.getByRole('combobox',{name:'播报厂商',exact:true}).selectOption('openai');assert.equal(await page.getByLabel('音色 ID',{exact:true}).inputValue(),'coral')
 assert.equal(await page.evaluate(()=>(window as any).voiceFixture.tests),0)
})

test('识别来源保存不覆盖其他标签页已更新的播报音色',async t=>{
 const page=await mount(t,{ttsProvider:'openai',localReady:true}),recognition=page.getByRole('region',{name:'语音识别',exact:true})
 assert.equal(await page.getByLabel('音色 ID',{exact:true}).inputValue(),'alloy')
 await page.evaluate(()=>(window as any).voiceFixture.replaceSpeech('nova'))
 await recognition.getByRole('combobox',{name:'识别来源',exact:true}).selectOption('sensevoice-local')
 await recognition.getByRole('button',{name:'保存识别设置',exact:true}).click();await recognition.getByRole('status').waitFor()
 assert.equal(await page.evaluate(()=>(window as any).voiceFixture.readStatus().voiceId),'nova')
 assert.equal(await page.getByLabel('音色 ID',{exact:true}).inputValue(),'nova')
 assert.deepEqual(await page.evaluate(()=>(window as any).voiceFixture.requests),[{asrProviderId:'sensevoice-local'}])
})

test('本机识别回显真实就绪状态，选择云端失败保留选择且不会隐式保存或切换播报',async t=>{
 const page=await mount(t,{asrProvider:'sensevoice-local',localReady:false}),recognition=page.getByRole('region',{name:'语音识别',exact:true}),select=recognition.getByRole('combobox',{name:'识别来源',exact:true})
 await recognition.getByText('SenseVoice 本机 · 尚未就绪',{exact:true}).waitFor()
 assert.equal(await select.inputValue(),'sensevoice-local');assert.equal(await recognition.locator('input[type=password]').count(),0)
 assert.equal(await recognition.getByRole('button',{name:'保存识别设置',exact:true}).count(),0)
 await select.selectOption('minimax');assert.equal(await page.evaluate(()=>(window as any).voiceFixture.saves),0)
 await page.evaluate(()=>(window as any).voiceFixture.failSave=true);await recognition.getByRole('button',{name:'保存识别设置',exact:true}).click();await page.getByRole('alert').waitFor()
 assert.equal(await select.inputValue(),'minimax');await recognition.getByText('SenseVoice 本机 · 尚未就绪',{exact:true}).waitFor()
 await page.evaluate(()=>(window as any).voiceFixture.failSave=false);await recognition.getByRole('button',{name:'保存识别设置',exact:true}).click();await recognition.getByRole('status').waitFor()
 await recognition.getByText('MiniMax 云端 · 尚未配置',{exact:true}).waitFor()
 assert.equal(await page.getByRole('combobox',{name:'播报厂商',exact:true}).inputValue(),'minimax')
 assert.equal(await page.evaluate(()=>(window as any).voiceFixture.tests),0)
})
test('保存废弃旧状态回包；离开设置取消试听，迟到结果不自动播放',async t=>{
 const page=await mount(t)
 await page.evaluate(()=>{const f=(window as any).voiceFixture;f.holdStatus=true;f.visibility(true)})
 await page.getByLabel('API Key',{exact:true}).fill('fixture-key');await page.getByRole('button',{name:'保存',exact:true}).click();await page.getByText('已保存凭据',{exact:true}).waitFor()
 await page.evaluate(()=>(window as any).voiceFixture.releaseStatus());await page.waitForTimeout(50)
 assert.equal(await page.getByRole('button',{name:'试听 · 青涩青年',exact:true}).isEnabled(),true)
 await page.getByRole('button',{name:'试听 · 青涩青年',exact:true}).click();await page.getByText('正在生成试听… · 青涩青年',{exact:true}).waitFor()
 await page.evaluate(()=>{const f=(window as any).voiceFixture;f.visibility(false);f.releasePreview()});await page.waitForTimeout(50)
 assert.equal(await page.locator('audio').count(),0);assert.equal(await page.evaluate(()=>(window as any).voiceFixture.aborted),1)
 assert.equal(await page.getByText('播报验证通过',{exact:true}).count(),0)
})

test('多厂商选择、模型音色与凭据隔离；选择不自动保存，识别配置不改当前播报厂商',async t=>{
 const page=await mount(t),select=page.getByRole('combobox',{name:'播报厂商',exact:true})
 assert.deepEqual(await select.locator('option').allTextContents(),['MiniMax','OpenAI','ElevenLabs'])
 await select.selectOption('openai');assert.equal(await page.getByLabel('模型',{exact:true}).inputValue(),'gpt-4o-mini-tts');assert.equal(await page.getByLabel('音色 ID',{exact:true}).inputValue(),'alloy')
 await page.getByLabel('模型',{exact:true}).fill('tts-1');await page.getByLabel('音色 ID',{exact:true}).fill('nova');await page.getByLabel('API Key',{exact:true}).fill('openai-fixture')
 await select.selectOption('elevenlabs');assert.equal(await page.getByLabel('API Key',{exact:true}).inputValue(),'');assert.equal(await page.getByLabel('模型',{exact:true}).inputValue(),'eleven_multilingual_v2')
 await select.selectOption('openai');assert.equal(await page.getByLabel('API Key',{exact:true}).inputValue(),'openai-fixture');assert.equal(await page.evaluate(()=>(window as any).voiceFixture.saves),0)
 await page.getByRole('button',{name:'保存',exact:true}).click();await page.getByText('已保存',{exact:true}).waitFor();assert.equal(await page.getByLabel('API Key',{exact:true}).inputValue(),'')
 assert.deepEqual(await page.evaluate(()=>(window as any).voiceFixture.requests[0]),{providerId:'openai',model:'tts-1',voiceId:'nova',apiKey:'openai-fixture'})
 await page.getByLabel('音色 ID',{exact:true}).fill('coral')
 await page.getByLabel('MiniMax 识别 API Key',{exact:true}).fill('asr-fixture');await page.getByRole('button',{name:'保存识别凭据',exact:true}).click();await page.getByLabel('MiniMax 识别 API Key',{exact:true}).waitFor();await page.waitForFunction(()=>(window as any).voiceFixture.saves===2)
 assert.equal(await select.inputValue(),'openai');assert.deepEqual(await page.evaluate(()=>(window as any).voiceFixture.requests[1]),{providerId:'minimax',model:'speech-2.8-turbo',voiceId:'male-qn-qingse',apiKey:'asr-fixture',setDefault:false})
 assert.equal(await page.locator('details form').first().getByRole('status').count(),0,'保存识别凭据不能把未保存的播报音色标为已保存')
 await page.getByRole('region',{name:'语音识别',exact:true}).getByRole('status').waitFor();await page.getByRole('button',{name:'取消',exact:true}).click()
 await page.evaluate(()=>(window as any).voiceFixture.visibility(true));await page.getByRole('button',{name:'测试并试听',exact:true}).click();assert.equal(await page.evaluate(()=>(window as any).voiceFixture.previewProvider),'openai')
 await select.selectOption('elevenlabs');await page.evaluate(()=>(window as any).voiceFixture.releasePreview());await page.waitForTimeout(50);assert.equal(await page.locator('audio').count(),0);assert.equal(await page.evaluate(()=>(window as any).voiceFixture.aborted),1)
})

test('紧凑音色选择按中英文分组，双语名称只在一个下拉框中选择，平时只有一个试听动作',async t=>{
 const page=await mount(t,{minimaxReady:true}),select=page.getByRole('combobox',{name:'音色',exact:true})
 assert.equal(await select.locator('option').count(),18)
 assert.deepEqual(await select.locator('optgroup').evaluateAll(nodes=>nodes.map(node=>node.label)),['普通话','English'])
 assert.ok((await select.locator('option').allTextContents()).includes('温润男声 · Gentleman'))
 assert.equal(await select.inputValue(),'male-qn-qingse')
 assert.equal(await page.getByRole('region',{name:'音色',exact:true}).getByRole('button').count(),1)
 await select.selectOption('English_CalmWoman')
 assert.equal(await page.getByRole('region',{name:'音色',exact:true}).getByRole('button').count(),2)
 assert.deepEqual(await page.evaluate(()=>({tests:(window as any).voiceFixture.tests,saves:(window as any).voiceFixture.saves})),{tests:0,saves:0})
 const english=await mount(t,{minimaxReady:true,locale:'en'})
 await english.getByRole('combobox',{name:'Voices',exact:true}).selectOption('English_CalmWoman')
 await english.getByRole('button',{name:'Preview · Calm Woman',exact:true}).waitFor()
 assert.ok((await english.getByRole('combobox',{name:'Voices',exact:true}).locator('option').allTextContents()).includes('Calm Woman · 沉静女声'))
})

test('一键试听使用保存的模型和临时音色，不提交模型密钥草稿；停止丢弃迟到音频',async t=>{
 const page=await mount(t,{minimaxReady:true})
 await page.locator('summary').click();await page.getByLabel('模型',{exact:true}).fill('speech-uncommitted');await page.getByLabel('API Key',{exact:true}).fill('uncommitted-key')
 await page.getByRole('combobox',{name:'音色',exact:true}).selectOption('Chinese (Mandarin)_Gentleman')
 await page.getByRole('button',{name:'试听 · 温润男声',exact:true}).click()
 await page.waitForFunction(()=>(window as any).voiceFixture.tests===1)
 assert.deepEqual(await page.evaluate(()=>(window as any).voiceFixture.previewVoice),{model:'speech-2.8-turbo',voiceId:'Chinese (Mandarin)_Gentleman',sampleLanguage:'zh'})
 assert.equal(await page.evaluate(()=>(window as any).voiceFixture.saves),0)
 await page.getByRole('button',{name:'停止试听 · 温润男声',exact:true}).click();await page.evaluate(()=>(window as any).voiceFixture.releasePreview())
 assert.equal(await page.locator('audio').count(),0);assert.equal(await page.getByLabel('模型',{exact:true}).inputValue(),'speech-uncommitted');assert.equal(await page.getByLabel('API Key',{exact:true}).inputValue(),'uncommitted-key')
 await page.getByRole('combobox',{name:'音色',exact:true}).selectOption('English_CalmWoman');await page.getByRole('button',{name:'试听 · 沉静女声',exact:true}).click();await page.waitForFunction(()=>(window as any).voiceFixture.tests===2)
 assert.equal(await page.evaluate(()=>(window as any).voiceFixture.previewVoice.sampleLanguage),'en')
 await page.evaluate(()=>(window as any).voiceFixture.releasePreview());await page.locator('audio').waitFor()
 assert.equal(await page.evaluate(()=>(window as any).voiceFixture.readStatus().voiceId),'male-qn-qingse')
})

test('选用音色失败不假报成功，成功只保存音色且保留模型密钥草稿和自定义 ID 入口',async t=>{
 const page=await mount(t,{minimaxReady:true})
 await page.locator('summary').click();await page.getByLabel('模型',{exact:true}).fill('speech-uncommitted');await page.getByLabel('API Key',{exact:true}).fill('uncommitted-key')
 await page.getByRole('combobox',{name:'音色',exact:true}).selectOption('Chinese (Mandarin)_Gentleman')
 await page.evaluate(()=>(window as any).voiceFixture.failSave=true)
 await page.getByRole('button',{name:'选用',exact:true}).click();await page.getByRole('alert').waitFor()
 assert.equal(await page.evaluate(()=>(window as any).voiceFixture.readStatus().voiceId),'male-qn-qingse')
 assert.equal(await page.getByText(/音色已选用/).count(),0)
 await page.evaluate(()=>(window as any).voiceFixture.failSave=false)
 await page.getByRole('button',{name:'选用',exact:true}).click();await page.getByText('音色已选用 · 温润男声',{exact:true}).waitFor()
 assert.deepEqual(await page.evaluate(()=>(window as any).voiceFixture.requests.at(-1)),{providerId:'minimax',voiceId:'Chinese (Mandarin)_Gentleman'})
 assert.equal(await page.getByLabel('模型',{exact:true}).inputValue(),'speech-uncommitted');assert.equal(await page.getByLabel('API Key',{exact:true}).inputValue(),'uncommitted-key')
 assert.equal(await page.getByLabel('音色 ID',{exact:true}).inputValue(),'Chinese (Mandarin)_Gentleman')
 assert.equal(await page.evaluate(()=>(window as any).voiceFixture.readStatus().model),'speech-2.8-turbo')
 assert.equal(await page.getByRole('button',{name:'选用',exact:true}).count(),0)
 await page.getByRole('combobox',{name:'音色',exact:true}).selectOption('English_CalmWoman');assert.equal(await page.getByText(/音色已选用/).count(),0)
})

test('试听失败回到可重试状态，不标记正在播放或选用；繁体界面显示地区文案',async t=>{
 const page=await mount(t,{minimaxReady:true,locale:'zh-Hant'})
 const select=page.getByRole('combobox',{name:'聲線',exact:true})
 assert.ok((await select.locator('option').allTextContents()).includes('青澀青年 · Youthful Male'))
 await select.selectOption('Chinese (Mandarin)_Gentleman')
 await page.evaluate(()=>(window as any).voiceFixture.failPreview=true)
 await page.getByRole('button',{name:'試聽 · 溫潤男聲',exact:true}).click();await page.getByRole('alert').waitFor()
 await page.getByRole('button',{name:'試聽 · 溫潤男聲',exact:true}).waitFor()
 assert.equal(await page.locator('audio').count(),0);assert.equal(await page.evaluate(()=>(window as any).voiceFixture.saves),0)
 await page.evaluate(()=>(window as any).voiceFixture.failPreview=false)
 await page.getByRole('button',{name:'試聽 · 溫潤男聲',exact:true}).click();await page.getByRole('button',{name:'停止試聽 · 溫潤男聲',exact:true}).waitFor()
 await page.getByRole('button',{name:'停止試聽 · 溫潤男聲',exact:true}).click();await page.evaluate(()=>(window as any).voiceFixture.releasePreview())
 assert.equal(await page.locator('audio').count(),0)
})
