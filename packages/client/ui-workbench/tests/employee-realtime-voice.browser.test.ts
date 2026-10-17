import {test,before,after} from 'node:test'
import assert from 'node:assert/strict'
import {createServer,type Server} from 'node:http'
import {createRequire} from 'node:module'
import {mkdtemp,writeFile,rm} from 'node:fs/promises'
import {fileURLToPath} from 'node:url'
import {join} from 'node:path'
import {build} from 'vite'
import {encodeVoiceWav} from '../src/client/voice-microphone.ts'
// @ts-expect-error 既有无头浏览器加载器。
import {loadPlaywright,launchOptions} from './fixtures/load-playwright.mjs'
const {WebSocketServer}=createRequire(new URL('../../../realtime-voice/package.json',import.meta.url))('ws')
const root=fileURLToPath(new URL('../../../../',import.meta.url)),client=fileURLToPath(new URL('../src/client/',import.meta.url))
type Connection={socket:any;ready:boolean;binary:number;commands:Record<string,unknown>[];protocol:string}
let browser:any,temp:string,server:Server,origin:string,script:string,stylesheet:string,wss:any
const connections:Connection[]=[]
before(async()=>{
 temp=await mkdtemp(join(root,'.runtime-realtime-voice-ui-'))
 const samples=new Float32Array(48000*3);for(let n=0;n<samples.length;n++)samples[n]=.2*Math.sin(2*Math.PI*440*n/48000)
 const wav=join(temp,'mic.wav');await writeFile(wav,encodeVoiceWav([samples],48000))
 await writeFile(join(temp,'fixture.tsx'),`import React from 'react';import {createRoot} from 'react-dom/client';import {EmployeeVoiceCall} from '${client}EmployeeVoiceCall.tsx';import {I18nProvider} from '${client}i18n/provider.tsx';import {translateMessage} from '${client}i18n/messages.ts';
 const snapshot={locale:'zh-CN',dshLocale:'zh',revision:1},runtime={t:(key,params)=>translateMessage('zh-CN',key,params),subscribe:()=>()=>{},getSnapshot:()=>snapshot};
 const f=window.voiceFixture={starts:0,ends:0,closes:0,audios:0,legacyReady:0,interrupts:0,mutes:0,microphones:0,muted:false};
 if(window.voiceCloseFailure){const NativeContext=window.AudioContext;window.AudioContext=class extends NativeContext{close(){if(this.sampleRate===48000&&!f.failedClose){f.failedClose=true;return Promise.reject(Error('private close diagnostic'))}return super.close()}}}
 const original=navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);navigator.mediaDevices.getUserMedia=async input=>{f.microphones++;if(window.voiceDelayedMic)await new Promise(resolve=>{f.releaseMic=resolve});if(window.voiceDenied)throw new DOMException('private mic diagnostic','NotAllowedError');f.stream=await original(input);return f.stream};
 const identity={id:'30000000-0000-4000-8000-000000000001',callGeneration:'40000000-0000-4000-8000-000000000001'},token='50000000-0000-4000-8000-000000000001';let call=null;
 const api={readiness:async()=>({status:'ready',providerId:'minimax'}),start:async input=>{f.starts++;call={...input,...identity,state:'connecting',failure:null,playbackGeneration:0};return call},read:async()=>{if(call){const state=await(await fetch('/state')).json();if(state.ready&&call.state==='connecting')call.state='connected'}return call},media:async()=>({token,closing:false,muted:f.muted,playbackGeneration:0,speech:null,realtime:{path:'/teloa-voice/stream',protocol:'teloa.voice.pcm.v1'}}),ready:async()=>{f.legacyReady++;call.state='connected'},closed:async()=>{f.closes++},end:async()=>{f.ends++;if(call)call.state='ended';return {call}},muted:async input=>{f.mutes++;f.muted=input.muted;return input},interrupt:async()=>{f.interrupts++;return call},audio:async()=>{f.audios++;return {text:null,receipt:null}},turn:async()=>({state:'unknown',speech:'not-ready',replyExpected:false,reason:null})};
 const view=createRoot(document.getElementById('root'));f.render=sessionId=>view.render(<I18nProvider runtime={runtime}><EmployeeVoiceCall api={api} target={{kind:'assistant',name:'Teloa 小松鼠助手',contextVersion:3}} sessionId={sessionId} openConversation={()=>{}} dismiss={()=>view.unmount()}/></I18nProvider>);f.render('original-session');`)
 const result=await build({configFile:false,root,logLevel:'error',define:{'process.env.NODE_ENV':'"development"'},build:{write:false,minify:false,lib:{entry:join(temp,'fixture.tsx'),name:'RealtimeVoiceUIFixture',formats:['iife']}}})
 const bundle=Array.isArray(result)?result[0]:result;assert.ok(bundle&&'output'in bundle);script=bundle.output.find(item=>item.type==='chunk')!.code
 const cssAsset=bundle.output.find(item=>item.type==='asset'&&item.fileName.endsWith('.css'))
 stylesheet=cssAsset?.type==='asset'?String(cssAsset.source):''
 server=createServer((req,res)=>{if(req.url==='/state'){res.setHeader('content-type','application/json');res.end(JSON.stringify({ready:connections.at(-1)?.ready??false}));return}res.setHeader('content-type',req.url==='/fixture.js'?'text/javascript; charset=utf-8':req.url==='/fixture.css'?'text/css; charset=utf-8':'text/html; charset=utf-8');res.end(req.url==='/fixture.js'?script:req.url==='/fixture.css'?stylesheet:'<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/fixture.css"></head><body><div id="root"></div></body></html>')})
 wss=new WebSocketServer({server,path:'/teloa-voice/stream'})
 wss.on('connection',(socket:any,request:any)=>{
  const entry:Connection={socket,ready:false,binary:0,commands:[],protocol:String(request.headers['sec-websocket-protocol'])};connections.push(entry)
  socket.on('message',(data:Buffer,binary:boolean)=>{if(binary){entry.binary++;return}const event=JSON.parse(data.toString()) as Record<string,unknown>;entry.commands.push(event);if(event.type==='hello'){entry.ready=true;socket.send(JSON.stringify({type:'ready'}))}})
  socket.on('close',()=>{entry.ready=false})
 })
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));origin='http://127.0.0.1:'+(server.address() as {port:number}).port
 browser=await loadPlaywright().chromium.launch({...launchOptions(),args:['--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream','--use-file-for-fake-audio-capture='+wav]})
})
after(async()=>{await browser?.close();for(const entry of connections)entry.socket.terminate();await new Promise<void>(resolve=>wss?.close(()=>resolve()));await new Promise<void>(resolve=>server?.close(()=>resolve()));if(temp)await rm(temp,{recursive:true,force:true})})
async function mount(t:any,mode?:'denied'|'delayed'|'close-failure'){
 const context=await browser.newContext({permissions:['microphone']}),page=await context.newPage(),errors:string[]=[];page.setDefaultTimeout(6000);page.on('pageerror',(error:Error)=>errors.push(error.message));t.after(async()=>{await context.close();assert.deepEqual(errors,[])})
 await page.route('**/*',(route:any)=>new URL(route.request().url()).origin===origin?route.continue():route.abort());await page.goto(origin)
 if(mode==='denied')await page.evaluate(()=>{(window as any).voiceDenied=true});if(mode==='delayed')await page.evaluate(()=>{(window as any).voiceDelayedMic=true})
 if(mode==='close-failure')await page.evaluate(()=>{(window as any).voiceCloseFailure=true})
 await page.addScriptTag({url:origin+'/fixture.js'});return page
}
async function waitFor(check:()=>boolean){const until=Date.now()+5000;while(!check()){if(Date.now()>until)throw Error('本机媒体事件等待超时。');await new Promise(resolve=>setTimeout(resolve,20))}}
test('实时媒体只开一个麦克风并沿原会话持续采集，通话条静音、打断和提交使用插件协议',{timeout:20000},async t=>{
 const beforeCount=connections.length,page=await mount(t)
 await page.waitForFunction(()=>(window as any).voiceFixture.stream?.getAudioTracks()[0].readyState==='live')
 await page.getByText('正在听，请说话',{exact:true}).waitFor()
 assert.equal(connections.length,beforeCount+1);const entry=connections.at(-1)!
 assert.equal(entry.protocol,'teloa.voice.pcm.v1');assert.equal(entry.commands[0]?.type,'hello')
 assert.equal(await page.evaluate(()=>(window as any).voiceFixture.microphones),1);assert.equal(await page.evaluate(()=>(window as any).voiceFixture.legacyReady),0)
 await waitFor(()=>entry.binary>0)
 const binaryBefore=entry.binary;entry.socket.send(JSON.stringify({type:'phase',phase:'speaking'}));await page.getByText('正在回答',{exact:true}).waitFor()
 const pcm=Buffer.alloc(4+8400*2);pcm.writeUInt32LE(1,0);for(let n=0;n<8400;n++)pcm.writeInt16LE(Math.round(8000*Math.sin(2*Math.PI*440*n/24000)),4+n*2)
 entry.socket.send(JSON.stringify({type:'speech-start',generation:1}));entry.socket.send(pcm);entry.socket.send(JSON.stringify({type:'speech-end',generation:1}))
 await waitFor(()=>entry.commands.some(event=>event.type==='playback'&&event.state==='playing')&&entry.commands.some(event=>event.type==='playback'&&event.state==='idle'))
 assert.ok(entry.binary>binaryBefore,'真实播放期间必须持续采集')
 entry.socket.send(JSON.stringify({type:'transcript',text:'核对原会话报告'}));await page.getByText('核对原会话报告',{exact:true}).waitFor()
 await page.getByRole('button',{name:'静音',exact:true}).click();await page.waitForFunction(()=>!(window as any).voiceFixture.stream.getAudioTracks()[0].enabled)
 await page.getByRole('button',{name:'取消静音',exact:true}).click();await page.waitForFunction(()=>(window as any).voiceFixture.stream.getAudioTracks()[0].enabled)
 await page.getByRole('button',{name:'打断回答',exact:true}).click();assert.equal(await page.evaluate(()=>(window as any).voiceFixture.interrupts),0)
 entry.socket.send(JSON.stringify({type:'phase',phase:'recording'}));await page.getByRole('button',{name:'结束这句话',exact:true}).click()
 await page.evaluate(()=>(window as any).voiceFixture.render('other-session'))
 assert.equal(await page.evaluate(()=>(window as any).voiceFixture.starts),1);assert.equal(await page.evaluate(()=>(window as any).voiceFixture.microphones),1)
 await page.getByRole('button',{name:'挂断',exact:true}).click();await page.getByText('通话已结束',{exact:true}).waitFor()
 assert.equal(await page.evaluate(()=>(window as any).voiceFixture.stream.getAudioTracks()[0].readyState),'ended')
 assert.equal(await page.evaluate(()=>(window as any).voiceFixture.audios),0);assert.equal(await page.evaluate(()=>(window as any).voiceFixture.mutes),2)
 assert.ok(entry.commands.some(event=>event.type==='interrupt'));assert.ok(entry.commands.some(event=>event.type==='commit'));assert.equal(entry.commands.filter(event=>event.type==='closed').length,1)
})
test('等待麦克风授权时挂断会结束原预约，迟到授权不得建连或复活',{timeout:15000},async t=>{
 const count=connections.length,page=await mount(t,'delayed');await page.waitForFunction(()=>typeof (window as any).voiceFixture.releaseMic==='function')
 await page.getByRole('button',{name:'挂断',exact:true}).click();await page.getByText('通话已结束',{exact:true}).waitFor()
 await page.evaluate(()=>(window as any).voiceFixture.releaseMic());await page.waitForFunction(()=>(window as any).voiceFixture.stream?.getAudioTracks()[0].readyState==='ended')
 assert.equal(connections.length,count);assert.equal(await page.evaluate(()=>(window as any).voiceFixture.ends),1)
})
test('服务端结束和网络断线都关闭唯一麦克风，只结束通话且不触发原任务打断',{timeout:15000},async t=>{
 for(const disconnect of [false,true]){
  const count=connections.length,page=await mount(t);await page.getByText('正在听，请说话',{exact:true}).waitFor();assert.equal(connections.length,count+1)
  const entry=connections.at(-1)!
  if(disconnect)entry.socket.terminate();else entry.socket.send(JSON.stringify({type:'close'}))
  await page.getByText('通话已结束',{exact:true}).waitFor()
  assert.equal(await page.evaluate(()=>(window as any).voiceFixture.stream.getAudioTracks()[0].readyState),'ended')
  assert.equal(await page.evaluate(()=>(window as any).voiceFixture.ends),1);assert.equal(await page.evaluate(()=>(window as any).voiceFixture.interrupts),0)
  if(disconnect)await page.getByText('通话暂不可用，可在原会话中继续。',{exact:true}).waitFor()
 }
})
test('本地关闭失败仍结束宿主预约，保留真实失败并在重试成功后结束通话',{timeout:15000},async t=>{
 const page=await mount(t,'close-failure');await page.getByText('正在听，请说话',{exact:true}).waitFor()
 const entry=connections.at(-1)!
 await page.getByRole('button',{name:'挂断',exact:true}).click()
 await page.getByText('尚未确认媒体关闭，请重试挂断。',{exact:true}).first().waitFor()
 assert.equal(await page.evaluate(()=>(window as any).voiceFixture.ends),1)
 assert.equal(await page.evaluate(()=>(window as any).voiceFixture.closes),0)
 assert.equal(entry.commands.filter(event=>event.type==='closed').length,0)
 assert.equal(await page.getByText('通话已结束',{exact:true}).count(),0)
 assert.equal(await page.evaluate(()=>(window as any).voiceFixture.stream.getAudioTracks()[0].readyState),'ended')
 await page.getByRole('button',{name:'挂断',exact:true}).click();await page.getByText('通话已结束',{exact:true}).waitFor()
 assert.equal(await page.evaluate(()=>(window as any).voiceFixture.ends),2)
 assert.equal(await page.evaluate(()=>(window as any).voiceFixture.closes),1)
})

test('浮窗标题可拖动，转写、状态和导航保留位置，按钮及文本滚动不误拖',{timeout:15000},async t=>{
 const page=await mount(t);await page.getByText('正在听，请说话',{exact:true}).waitFor()
 const panel=page.getByRole('region',{name:'语音通话',exact:true}),handle=panel.locator('header'),before=await panel.boundingBox(),grip=await handle.boundingBox();assert.ok(before&&grip)
 await page.mouse.move(grip.x+35,grip.y+grip.height/2);await page.mouse.down();await page.mouse.move(grip.x-145,grip.y-110,{steps:5});await page.mouse.up()
 const moved=await panel.boundingBox();assert.ok(moved);assert.ok(moved.x<before.x-100&&moved.y<before.y-60,'标题拖动应移动整个浮窗')
 const entry=connections.at(-1)!,transcript='可选择和滚动的原会话转写。'.repeat(40)
 entry.socket.send(JSON.stringify({type:'phase',phase:'thinking'}));entry.socket.send(JSON.stringify({type:'transcript',text:transcript}));await page.getByText(transcript,{exact:true}).waitFor()
 await page.evaluate(()=>(window as any).voiceFixture.render('other-session'))
 const retained=await panel.boundingBox();assert.ok(retained);assert.ok(Math.abs(retained.x-moved.x)<1&&Math.abs(retained.y-moved.y)<1)
 const mic=await page.getByRole('button',{name:'静音',exact:true}).boundingBox();assert.ok(mic)
 await page.mouse.move(mic.x+mic.width/2,mic.y+mic.height/2);await page.mouse.down();await page.mouse.move(mic.x+mic.width+55,mic.y+40);await page.mouse.up()
 const text=page.getByText(transcript,{exact:true}),textBox=await text.boundingBox();assert.ok(textBox)
 await page.mouse.move(textBox.x+5,textBox.y+10);await page.mouse.down();await page.mouse.move(textBox.x+textBox.width-10,textBox.y+35,{steps:4});await page.mouse.up()
 await page.mouse.wheel(0,100);await page.waitForFunction((node:HTMLElement)=>node.scrollTop>0,await text.elementHandle())
 assert.ok(await text.evaluate((node:HTMLElement)=>node.scrollHeight>node.clientHeight&&node.scrollTop>0))
 const after=await panel.boundingBox();assert.ok(after);assert.ok(Math.abs(after.x-moved.x)<1&&Math.abs(after.y-moved.y)<1)
 assert.deepEqual(await page.evaluate(()=>{const f=(window as any).voiceFixture;return [f.starts,f.microphones,f.ends,f.mutes,f.interrupts,f.audios]}),[1,1,0,0,0,0])
 assert.ok(entry.commands.every(event=>event.type==='hello'),'拖动不能发送任务、控制或扩大权限')
})

test('浮窗拖动使用 pointer capture，取消后释放且后续移动不拖动',{timeout:15000},async t=>{
 const page=await mount(t);await page.getByText('正在听，请说话',{exact:true}).waitFor()
 const panel=page.getByRole('region',{name:'语音通话',exact:true}),handle=panel.locator('header'),box=await handle.boundingBox();assert.ok(box)
 await handle.evaluate((node:HTMLElement)=>node.addEventListener('pointerdown',event=>{(window as any).voicePointer=(event as PointerEvent).pointerId},{once:true}))
 await page.mouse.move(box.x+30,box.y+box.height/2);await page.mouse.down();await page.mouse.move(box.x-70,box.y-50,{steps:3})
 assert.equal(await handle.evaluate((node:HTMLElement)=>node.hasPointerCapture((window as any).voicePointer)),true)
 await handle.evaluate((node:HTMLElement)=>node.dispatchEvent(new PointerEvent('pointercancel',{pointerId:(window as any).voicePointer,isPrimary:true,bubbles:true})))
 assert.equal(await handle.evaluate((node:HTMLElement)=>node.hasPointerCapture((window as any).voicePointer)),false)
 const cancelled=await panel.boundingBox();assert.ok(cancelled)
 await page.mouse.move(box.x-150,box.y-120,{steps:3});await page.mouse.up()
 const after=await panel.boundingBox();assert.ok(after);assert.ok(Math.abs(after.x-cancelled.x)<1&&Math.abs(after.y-cancelled.y)<1)
 assert.equal(await page.evaluate(()=>(window as any).voiceFixture.ends),0)
})

test('浮窗拖到边缘后 resize 与窄屏仍保持标题和控制可达',{timeout:15000},async t=>{
 const page=await mount(t);await page.getByText('正在听，请说话',{exact:true}).waitFor()
 const panel=page.getByRole('region',{name:'语音通话',exact:true}),handle=panel.locator('header'),box=await handle.boundingBox();assert.ok(box)
 await page.mouse.move(box.x+20,box.y+box.height/2);await page.mouse.down();await page.mouse.move(1250,700,{steps:5});await page.mouse.up()
 await page.setViewportSize({width:320,height:220})
 await page.waitForFunction(()=>{const box=document.querySelector('section[aria-label="语音通话"]')!.getBoundingClientRect();return box.left>=8&&box.top>=8&&box.right<=innerWidth-8&&box.bottom<=innerHeight-8})
 await page.getByRole('button',{name:'挂断',exact:true}).scrollIntoViewIfNeeded();const end=await page.getByRole('button',{name:'挂断',exact:true}).boundingBox();assert.ok(end&&end.x>=0&&end.y>=0&&end.x+end.width<=320&&end.y+end.height<=220)
 assert.equal(await page.evaluate(()=>(window as any).voiceFixture.ends),0)
})
