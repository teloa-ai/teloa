import {readFile,writeFile,lstat} from 'node:fs/promises'
import {randomUUID} from 'node:crypto'
import {isIP} from 'node:net'
import {dirname,join} from 'node:path'
import {setTimeout as delay} from 'node:timers/promises'
import WebSocket from 'ws'
import OpusScript from 'opusscript'
import {deviceProtocol,encodeAudioFrame,createAudioReceiver} from '../src/protocol.ts'

// 仅模拟设备协议与 DAC 消费，不访问 USB、不安装或修改固件。
const [configPath,mode='hello',inputPath]=process.argv.slice(2)
if(!configPath||!['hello','speak','status','repeat'].includes(mode))throw Error('用法：node tools/software-device.mjs 私有配置 hello|speak|status|repeat [16k-mono-s16le文件或captureId]')
const info=await lstat(configPath)
if(!info.isFile()||info.isSymbolicLink()||info.nlink!==1||info.mode&0o077||info.uid!==process.getuid())throw Error('软件设备配置权限必须为本人 0600。')
const config=JSON.parse(await readFile(configPath,'utf8')),host=config.host
if(isIP(host)!==4||!(/^(10\.|192\.168\.|127\.0\.0\.1$)/.test(host)||/^172\.(1[6-9]|2\d|3[01])\./.test(host))||!Number.isInteger(config.port)||config.port<1024||[3100,3101].includes(config.port)||!/^[A-Za-z0-9_-]{43}$/.test(config.credential))throw Error('仅允许显式私网设备网关。')
const captureId=['status','repeat'].includes(mode)?inputPath:randomUUID(),events=[],audio=[]
const ws=new WebSocket(`wss://${host}:${config.port}/devices/v1/connect`,{headers:{Authorization:'Bearer '+config.credential},ca:await readFile(join(dirname(configPath),'server.crt')),servername:config.serverName,handshakeTimeout:10000,maxPayload:16384,perMessageDeflate:false})
let generation,stream,sealed=false,sequence=0,receiver,downstream,last=-1,ended,playing=false,settled=false,replyDone
let resolveDone,rejectDone
const done=new Promise((resolve,reject)=>{resolveDone=resolve;rejectDone=reject}),timeout=setTimeout(()=>finish(Error('设备联调等待超时。')),180000)
const encoder=new OpusScript(16000,1,OpusScript.Application.VOIP),decoder=new OpusScript(24000,1,OpusScript.Application.AUDIO)
const send=value=>{if(ws.readyState===WebSocket.OPEN)ws.send(JSON.stringify(value))}
function finish(error){if(settled)return;settled=true;clearTimeout(timeout);clearTimeout(replyDone);ws.close();error?rejectDone(error):resolveDone()}
function played(){if(ended!==undefined&&last===ended&&!playing){send({type:'playback.played',streamId:downstream,lastSequence:last});replyDone=setTimeout(()=>finish(),500)}}
const queue=[]
async function drain(){
 if(playing)return;playing=true
 try{while(queue.length){const packet=queue.shift(),pcm=decoder.decode(Buffer.from(packet));if(pcm.length!==2880)throw Error('下行不是24k单声道60ms');audio.push(pcm);await delay(60);last++;send({type:'playback.progress',streamId:downstream,sequence:last})}}catch(error){finish(error)}
 finally{playing=false;played()}
}
async function upload(){
 const pcm=await readFile(inputPath),padded=Buffer.concat([pcm,Buffer.alloc(16000*2*2)])
 if(pcm.length>16000*2*60||pcm.length%2)throw Error('上行夹具必须为不超过60秒的16k mono s16le。')
 for(let offset=0;offset<padded.length&&!sealed&&!settled;offset+=1920){
  const frame=Buffer.alloc(1920);padded.copy(frame,0,offset,offset+1920)
  ws.send(encodeAudioFrame({kind:1,connectionGeneration:generation,streamId:stream,sequence:sequence++,payload:encoder.encode(frame,960)}))
  await delay(60)
 }
 if(!sealed&&!settled)send({type:'listen.stop',captureId})
}
ws.on('open',()=>send({type:'hello',protocol:deviceProtocol,audio:{uplink:{format:'opus',sampleRate:16000,channels:1,frameDurationMs:60},downlink:{format:'opus',sampleRate:24000,channels:1,frameDurationMs:60}}}))
ws.on('message',(bytes,binary)=>{
 try{
  if(binary){if(!receiver)throw Error('没有下行流');queue.push(receiver.accept(bytes));if(queue.length>33)throw Error('软件 DAC 缓冲超出窗口');void drain();return}
  const event=JSON.parse(bytes.toString('utf8'));events.push(event)
  if(event.type==='hello'){generation=event.connectionGeneration;if(mode==='hello')finish();else send({type:mode==='speak'?'listen.start':mode==='status'?'request.status':'playback.repeat',captureId})}
  else if(event.type==='listen.ready'){stream=event.streamId;void upload().catch(finish)}
  else if(event.type==='listen.sealed')sealed=true
  else if(event.type==='request.receipt'&&mode==='status')finish()
  else if(event.type==='playback.start'){clearTimeout(replyDone);ended=undefined;last=-1;downstream=event.streamId;receiver=createAudioReceiver({kind:2,connectionGeneration:generation,streamId:downstream});send({type:'playback.ready',streamId:downstream})}
  else if(event.type==='playback.end'){ended=event.lastSequence;played()}
  else if(event.type==='error')finish(Error('设备宿主返回：'+event.code))
 }catch(error){finish(error)}
})
ws.on('error',()=>finish(Error('WSS 连接或私有 CA 校验失败。')))
ws.on('close',()=>{if(!settled)finish(Error('设备连接已关闭。'))})
let failure
try{await done}catch(error){failure=error.message}
finally{encoder.delete();decoder.delete();ws.terminate()}
const result={mode,captureId,ok:!failure,...failure?{failure}:{},events,decodedFrames:audio.length,audioBytes:audio.reduce((sum,part)=>sum+part.length,0)}
await writeFile(join(dirname(configPath),'last-result.json'),JSON.stringify(result,null,2)+'\n',{mode:0o600})
if(audio.length)await writeFile(join(dirname(configPath),'reply-24k.pcm'),Buffer.concat(audio),{mode:0o600})
console.log(JSON.stringify(result,null,2));if(failure)process.exitCode=1
