import {test,before,after} from 'node:test'
import assert from 'node:assert/strict'
import {createServer,type Server} from 'node:http'
import {mkdtemp,writeFile,rm} from 'node:fs/promises'
import {fileURLToPath} from 'node:url'
import {join} from 'node:path'
import {build} from 'vite'
import {encodeVoiceWav} from '../src/client/voice-microphone.ts'
// @ts-expect-error 既有无头浏览器加载器。
import {loadPlaywright,launchOptions} from './fixtures/load-playwright.mjs'
const root=fileURLToPath(new URL('../../../../',import.meta.url)),client=fileURLToPath(new URL('../src/client/',import.meta.url))
let browser:any,temp:string,server:Server,origin:string,script:string
before(async()=>{
 temp=await mkdtemp(join(root,'.runtime-employee-voice-'))
 const samples=new Float32Array(48000*5);for(let n=0;n<48000*1.2;n++)samples[n]=.2*Math.sin(2*Math.PI*440*n/48000)
 const wav=join(temp,'mic.wav');await writeFile(wav,encodeVoiceWav([samples],48000))
 await writeFile(join(temp,'fixture.tsx'),`import React from 'react';import {createRoot} from 'react-dom/client';import {EmployeeVoiceCall} from '${client}EmployeeVoiceCall.tsx';import {AssistantVoiceMessage} from '${client}AssistantVoiceMessage.tsx';import {I18nProvider} from '${client}i18n/provider.tsx';import {translateMessage} from '${client}i18n/messages.ts';
 const snapshot={locale:'zh-CN',dshLocale:'zh',revision:1},runtime={t:(key,params)=>translateMessage('zh-CN',key,params),subscribe:()=>()=>{},getSnapshot:()=>snapshot};
 const f=window.voiceFixture={starts:0,ends:0,closes:0,audios:0,interrupts:0,muted:false,denied:window.voiceDenied===true};const getUserMedia=navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);navigator.mediaDevices.getUserMedia=async input=>{if(f.denied)throw new DOMException('denied','NotAllowedError');f.stream=await getUserMedia(input);return f.stream};
 const role={id:'20000000-0000-4000-8000-000000000001',version:1,name:'小研'},identity={callId:'30000000-0000-4000-8000-000000000001',callGeneration:'40000000-0000-4000-8000-000000000001'},token='50000000-0000-4000-8000-000000000001';let call=null;
 const mediaSnapshot=()=>({token,closing:false,muted:f.muted,playbackGeneration:call.playbackGeneration,speech:null});const api={transcribe:async(input,signal)=>{f.transcribeInput=input;f.transcribeSignal=signal;return new Promise(resolve=>{f.releaseTranscribe=()=>resolve({requestId:input.requestId,sessionId:input.sessionId,contextVersion:3,text:'留言草稿'})})},readiness:async()=>window.voiceTtsUnavailable?{status:'unavailable',providerId:'openai',reason:'provider-unconfigured'}:{status:'ready',providerId:'minimax'},recognitionReadiness:async()=>{f.recognitionChecks=(f.recognitionChecks||0)+1;return {status:'ready',providerId:'minimax'}},start:async input=>{f.starts++;f.startInput=input;call={...input,id:identity.callId,callGeneration:identity.callGeneration,state:'connecting',failure:null,playbackGeneration:0}},read:async()=>call,media:async()=>{f.mediaReads=(f.mediaReads||0)+1;if(window.voiceDelayMedia&&f.mediaReads===1)return new Promise(resolve=>{f.releaseMedia=()=>resolve(mediaSnapshot())});return mediaSnapshot()},ready:async()=>{call.state='connected'},turn:async()=>({state:'ended',speech:'not-ready',replyExpected:false,reason:'completed'}),closed:async()=>{f.closes++},end:async()=>{f.ends++;if(call){call.state='ended';call.failure=f.failClose?'media-close-failed':null}return {call}},muted:async input=>{f.muted=input.muted;return input},interrupt:async()=>{f.interrupts++;call.playbackGeneration++;return call},audio:async input=>{f.audios++;f.bytes=atob(input.audio).length;f.input=input;return new Promise(resolve=>{f.release=()=>resolve({text:'测试转写',receipt:{state:'unknown',commitId:'test-commit'}})})}};
 const view=createRoot(document.getElementById('root'));f.render=sessionId=>view.render(<I18nProvider runtime={runtime}>{window.voiceMessageEnabled?<AssistantVoiceMessage api={api} prepare={async()=>({sessionId:'original-session',contextVersion:3,isCurrent:()=>f.current!==false,subscribe:listener=>{f.navigation=listener;return()=>{f.navigation=null}}})} insert={async draft=>{f.inserted=draft}}/>:<EmployeeVoiceCall api={api} {...(window.voiceAssistant?{target:{kind:'assistant',name:'Teloa 小松鼠助手',contextVersion:3}}:window.voiceTwin?{target:{...role,kind:'role',roleKind:'twin',initials:'ML',name:'Max Luo 的分身'}}:{role})} sessionId={sessionId} openConversation={()=>{}} dismiss={()=>{view.unmount()}}/>}</I18nProvider>);f.render('original-session');`)
 const result=await build({configFile:false,root,logLevel:'error',define:{'process.env.NODE_ENV':'"development"'},build:{write:false,minify:false,lib:{entry:join(temp,'fixture.tsx'),name:'EmployeeVoiceFixture',formats:['iife']}}})
 const bundle=Array.isArray(result)?result[0]:result;assert.ok(bundle&&'output'in bundle);script=bundle.output.find(item=>item.type==='chunk')!.code
 server=createServer((req,res)=>{res.setHeader('content-type',req.url==='/fixture.js'?'text/javascript; charset=utf-8':'text/html; charset=utf-8');res.end(req.url==='/fixture.js'?script:'<!doctype html><html><head><meta charset="utf-8"></head><body><div id="root"></div></body></html>')});await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));origin='http://127.0.0.1:'+(server.address() as {port:number}).port
 browser=await loadPlaywright().chromium.launch({...launchOptions(),args:['--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream','--use-file-for-fake-audio-capture='+wav]})
})
after(async()=>{await browser?.close();await new Promise<void>(resolve=>server?.close(()=>resolve()));if(temp)await rm(temp,{recursive:true,force:true})})
async function mount(t:any,denied=false,delayMedia=false,assistant=false,message=false,twin=false){
 const context=await browser.newContext({permissions:['microphone']}),page=await context.newPage(),errors:string[]=[];page.setDefaultTimeout(5000);page.on('pageerror',(e:Error)=>errors.push(e.message));t.after(async()=>{await context.close();assert.deepEqual(errors,[])})
 await page.route('**/*',(route:any)=>new URL(route.request().url()).origin===origin?route.continue():route.abort());await page.goto(origin);if(denied)await page.evaluate(()=>{(window as any).voiceDenied=true})
 if(twin)await page.evaluate(()=>{(window as any).voiceTwin=true});if(message)await page.evaluate(()=>{(window as any).voiceMessageEnabled=true});if(assistant)await page.evaluate(()=>{(window as any).voiceAssistant=true});if(delayMedia)await page.evaluate(()=>{(window as any).voiceDelayMedia=true});await page.addScriptTag({url:origin+'/fixture.js'});return page
}
test('真实 AudioWorklet 采集 WAV，静音实际停上行；导航不挂断，挂断停止麦克风不取消已提交输入',{timeout:20000},async t=>{
 const page=await mount(t)
 await page.waitForFunction(()=>(window as any).voiceFixture.audios===1)
 assert.ok(await page.evaluate(()=>(window as any).voiceFixture.bytes>44))
 await page.evaluate(()=>{const f=(window as any).voiceFixture;f.render('other-session')});assert.equal(await page.evaluate(()=>(window as any).voiceFixture.ends),0)
 await page.getByRole('button',{name:'静音',exact:true}).click();await page.waitForFunction(()=>!(window as any).voiceFixture.stream.getAudioTracks()[0].enabled)
 await page.getByRole('button',{name:'取消静音',exact:true}).click();await page.waitForFunction(()=>(window as any).voiceFixture.stream.getAudioTracks()[0].enabled)
 await page.getByRole('button',{name:'挂断',exact:true}).click();await page.getByText('通话已结束',{exact:true}).waitFor();assert.equal(await page.evaluate(()=>(window as any).voiceFixture.stream.getAudioTracks()[0].readyState),'ended')
 await page.evaluate(()=>(window as any).voiceFixture.release());assert.equal(await page.getByText('测试转写',{exact:true}).count(),0)
 assert.equal(await page.evaluate(()=>(window as any).voiceFixture.ends),1)
})
test('拒绝麦克风会结束已预约通话，不生成模拟 connected',{timeout:15000},async t=>{
 const page=await mount(t,true);await page.getByText('未取得麦克风权限，请允许后重试。',{exact:true}).waitFor();assert.equal(await page.evaluate(()=>(window as any).voiceFixture.starts),1)
 await page.getByText('通话已结束',{exact:true}).waitFor()
 assert.equal(await page.evaluate(()=>(window as any).voiceFixture.ends),1)
 assert.equal(await page.getByText('正在听，请说话',{exact:true}).count(),0)
})

test('原生模态详情打开后仍可静音与挂断，关闭详情不重新拨号',{timeout:15000},async t=>{
 const page=await mount(t);await page.waitForFunction(()=>(window as any).voiceFixture.starts===1&&(window as any).voiceFixture.mediaReads>0)
 await page.evaluate(()=>{const dialog=document.createElement('dialog');dialog.innerHTML='<button aria-label="关闭详情">关闭详情</button>';dialog.querySelector('button')!.addEventListener('click',()=>dialog.close());document.body.append(dialog);dialog.showModal()})
 await page.getByRole('button',{name:'静音',exact:true}).click({timeout:1500})
 await page.waitForFunction(()=>!(window as any).voiceFixture.stream.getAudioTracks()[0].enabled)
 await page.getByRole('button',{name:'关闭详情',exact:true}).click()
 await page.getByRole('button',{name:'取消静音',exact:true}).click()
 assert.equal(await page.evaluate(()=>(window as any).voiceFixture.starts),1)
 await page.evaluate(()=>document.querySelector('dialog')!.showModal())
 await page.getByRole('button',{name:'挂断',exact:true}).click({timeout:1500})
 await page.getByText('通话已结束',{exact:true}).waitFor()
 assert.equal(await page.evaluate(()=>(window as any).voiceFixture.stream.getAudioTracks()[0].readyState),'ended')
})

test('实际最上层模态优先于 DOM 顺序与并存的非模态窗口',{timeout:15000},async t=>{
 const page=await mount(t);await page.waitForFunction(()=>(window as any).voiceFixture.starts===1&&(window as any).voiceFixture.mediaReads>0)
 await page.evaluate(()=>{for(const name of ['front','back','nonmodal']){const dialog=document.createElement('dialog');dialog.id=name;dialog.innerHTML='<button>'+name+'</button>';dialog.querySelector('button')!.addEventListener('click',()=>dialog.close());document.body.append(dialog)};(document.getElementById('back') as HTMLDialogElement).showModal();(document.getElementById('front') as HTMLDialogElement).showModal();(document.getElementById('nonmodal') as HTMLDialogElement).show()})
 await page.getByRole('button',{name:'静音',exact:true}).click({timeout:1500})
 assert.equal(await page.getByRole('region',{name:'语音通话',exact:true}).evaluate((node:Element)=>node.closest('dialog')?.id),'front')
 await page.getByRole('button',{name:'front',exact:true}).click()
 await page.getByRole('button',{name:'取消静音',exact:true}).click({timeout:1500})
 assert.equal(await page.getByRole('region',{name:'语音通话',exact:true}).evaluate((node:Element)=>node.closest('dialog')?.id),'back')
 await page.getByRole('button',{name:'back',exact:true}).click()
 await page.getByRole('button',{name:'挂断',exact:true}).click()
 await page.getByText('通话已结束',{exact:true}).waitFor()
 assert.equal(await page.evaluate(()=>(window as any).voiceFixture.starts),1)
})

test('首媒体回包在途时挂断仍能回读绑定并关闭，迟到回包不复活',{timeout:15000},async t=>{
 const page=await mount(t,false,true);await page.waitForFunction(()=>typeof (window as any).voiceFixture.releaseMedia==='function')
 await page.getByRole('button',{name:'挂断',exact:true}).click();await page.getByText('通话已结束',{exact:true}).waitFor()
 assert.equal(await page.evaluate(()=>(window as any).voiceFixture.closes),1)
 await page.evaluate(()=>(window as any).voiceFixture.releaseMedia());assert.equal(await page.getByText('通话已结束',{exact:true}).count(),1)
})
test('真实终态无回复恢复聆听；关闭失败保留重试且不误报已结束',{timeout:15000},async t=>{
 const page=await mount(t);await page.waitForFunction(()=>(window as any).voiceFixture.audios===1)
 await page.evaluate(()=>(window as any).voiceFixture.release());await page.getByText('正在听，请说话',{exact:true}).waitFor()
 assert.equal(await page.getByRole('alert').count(),0)
 assert.equal(await page.evaluate(()=>(window as any).voiceFixture.audios),1)
 await page.evaluate(()=>{(window as any).voiceFixture.failClose=true})
 await page.getByRole('button',{name:'挂断',exact:true}).click();await page.getByRole('alert').waitFor()
 assert.equal(await page.getByText('通话已结束',{exact:true}).count(),0)
 await page.evaluate(()=>{(window as any).voiceFixture.failClose=false})
 await page.getByRole('button',{name:'挂断',exact:true}).click();await page.getByText('通话已结束',{exact:true}).waitFor()
})

test('页面退出同步停止真实麦克风并发送已有绑定的关闭回执',{timeout:15000},async t=>{
 const page=await mount(t);await page.waitForFunction(()=>(window as any).voiceFixture.stream?.getAudioTracks()[0].readyState==='live')
 await page.evaluate(()=>window.dispatchEvent(new Event('pagehide')))
 await page.waitForFunction(()=>(window as any).voiceFixture.stream.getAudioTracks()[0].readyState==='ended')
 await page.getByText('通话已结束',{exact:true}).waitFor()
 assert.equal(await page.evaluate(()=>(window as any).voiceFixture.closes),1)
 assert.equal(await page.evaluate(()=>(window as any).voiceFixture.ends),1)
 await page.evaluate(()=>window.dispatchEvent(new PageTransitionEvent('pageshow',{persisted:true})))
 await page.getByText('通话已结束',{exact:true}).waitFor()
 assert.equal(await page.getByRole('button',{name:'静音',exact:true}).count(),0)
 assert.equal(await page.evaluate(()=>(window as any).voiceFixture.starts),1)
})

test('小松鼠共享原通话引擎，使用 general 上下文且导航与隐藏面板不重建通话',{timeout:15000},async t=>{
 const page=await mount(t,false,false,true)
 await page.waitForFunction(()=>(window as any).voiceFixture.starts===1)
 const input=await page.evaluate(()=>(window as any).voiceFixture.startInput)
 assert.deepEqual(Object.keys(input).sort(),['requestId','sessionId','target','expectedContextVersion'].sort())
 assert.equal(input.target,'assistant');assert.equal(input.expectedContextVersion,3);assert.equal(input.sessionId,'original-session')
 await page.getByText('Teloa 小松鼠助手',{exact:true}).waitFor()
 await page.evaluate(()=>(window as any).voiceFixture.render('other-session'))
 assert.equal(await page.evaluate(()=>(window as any).voiceFixture.starts),1)
 assert.equal(await page.evaluate(()=>(window as any).voiceFixture.ends),0)
 await page.getByRole('button',{name:'挂断',exact:true}).click()
 await page.getByText('通话已结束',{exact:true}).waitFor()
})

test('TTS未配置仍可留言采集 WAV，只将转写放入原助手草稿；导航取消迟到转写',{timeout:15000},async t=>{
 const page=await mount(t,false,false,false,true);await page.evaluate(()=>(window as any).voiceTtsUnavailable=true)
 await page.getByRole('button',{name:'开始录音',exact:true}).click()
 await page.waitForFunction(()=>(window as any).voiceFixture.stream?.getAudioTracks()[0].readyState==='live')
 await page.waitForTimeout(400)
 await page.getByRole('button',{name:'完成录音',exact:true}).click()
 await page.waitForFunction(()=>!!(window as any).voiceFixture.releaseTranscribe)
 assert.equal(await page.evaluate(()=>(window as any).voiceFixture.stream.getAudioTracks()[0].readyState),'ended')
 assert.equal(await page.evaluate(()=>(window as any).voiceFixture.starts),0)
 await page.evaluate(()=>(window as any).voiceFixture.releaseTranscribe())
 await page.getByText('已添加到原会话草稿，请核对后发送。',{exact:true}).waitFor()
 assert.equal(await page.evaluate(()=>(window as any).voiceFixture.inserted.text),'留言草稿')
 await page.getByRole('button',{name:'开始录音',exact:true}).click();await page.waitForTimeout(400)
 await page.getByRole('button',{name:'完成录音',exact:true}).click()
 await page.waitForFunction(()=>!!(window as any).voiceFixture.transcribeSignal)
 await page.evaluate(()=>{const f=(window as any).voiceFixture;f.inserted=null;f.current=false;f.navigation();f.releaseTranscribe()})
 await page.getByText('已取消录音，原草稿保留。',{exact:true}).waitFor()
 assert.equal(await page.evaluate(()=>(window as any).voiceFixture.transcribeSignal.aborted),true)
 assert.equal(await page.evaluate(()=>(window as any).voiceFixture.inserted),null)
})


test('分身通话显示本人缩写和分身身份，导航仍保持同一角色与一次拨号',{timeout:15000},async t=>{
 const page=await mount(t,false,false,false,false,true),panel=page.getByRole('region',{name:'语音通话',exact:true})
 await panel.getByText('Max Luo 的分身',{exact:true}).waitFor()
 assert.equal(await panel.locator('[data-teloa-twin-avatar]').innerText(),'ML')
 assert.equal(await panel.locator('img').count(),0,'分身不能使用小松鼠员工头像')
 await page.waitForFunction(()=>(window as any).voiceFixture.starts===1)
 const input=await page.evaluate(()=>(window as any).voiceFixture.startInput)
 assert.equal(input.roleId,'20000000-0000-4000-8000-000000000001');assert.equal(input.expectedRoleVersion,1);assert.equal(input.sessionId,'original-session')
 await page.evaluate(()=>(window as any).voiceFixture.render('other-session'))
 assert.equal(await panel.locator('[data-teloa-twin-avatar]').innerText(),'ML')
 assert.equal(await page.evaluate(()=>(window as any).voiceFixture.starts),1)
 await page.getByRole('button',{name:'挂断',exact:true}).click();await page.getByText('通话已结束',{exact:true}).waitFor()
})
