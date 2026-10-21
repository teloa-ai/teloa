import test from 'node:test'
import assert from 'node:assert/strict'
import {buildSharePlan,sharePackageDigest} from '../src/client/share-package-plan.ts'
import {createWebTemplateShareBridge,readWebTemplateShareLink,templateShareApiOrigin,templateShareSiteOrigin} from '../src/client/web-template-share.ts'

const shareId='11111111-1111-4111-a111-111111111111',requestId='22222222-2222-4222-a222-222222222222'
const pkg=()=>buildSharePlan({subject:'skill',title:'Review',description:'Review supplied material.',publisher:'Test author',roles:[],skills:[{name:'review',license:'MIT',text:'---\nname: review\ndescription: Review provided material.\n---\n\nReview the supplied material.'}]})
function fixture(fetcher:typeof fetch=async()=>{throw Error('Unexpected network')},storage?:{getItem:(key:string)=>string|null;setItem:(key:string,value:string)=>void}){
 let listener:((event:MessageEvent)=>void)|undefined,openCount=0,focused=0
 const sent:Record<string,unknown>[]=[],accepted:Record<string,unknown>[]=[],popup={closed:false,focus:()=>{focused++},postMessage:(message:Record<string,unknown>,origin:string)=>{assert.equal(origin,templateShareSiteOrigin);if(message.type==='request')sent.push(message);else if(message.type==='identity-accepted')accepted.push(message)}}
 let opened=''
 const host={location:{href:'http://127.0.0.1:43210/',origin:'http://127.0.0.1:43210'},crypto:globalThis.crypto,setTimeout,clearTimeout,setInterval,clearInterval,addEventListener:(name:string,fn:typeof listener)=>{assert.equal(name,'message');listener=fn},removeEventListener:()=>{listener=undefined},open:(url:string)=>{opened=url;openCount++;return popup}} as unknown as Window
 const bridge=createWebTemplateShareBridge(host,fetcher,storage)
 const envelope=()=>({format:'teloa.template-share-channel/v1',nonce:new URLSearchParams(new URL(opened).hash.slice(1)).get('nonce')})
 const emit=(data:unknown,origin=templateShareSiteOrigin,source:unknown=popup)=>listener?.({data,origin,source} as MessageEvent)
 const ready=()=>emit({...envelope(),type:'ready'})
 const authorize=(account='33333333-3333-4333-a333-333333333333')=>{const message=sent.at(-1)!;emit({...envelope(),type:'identity',id:message.id,method:message.method,account})}
 const answer=(value:unknown,index=sent.length-1)=>{const message=sent[index]!;emit({...envelope(),type:'result',id:message.id,method:message.method,value})}
 return {bridge,popup,sent,accepted,ready,authorize,emit,answer,envelope,opened:()=>opened,openCount:()=>openCount,focused:()=>focused}
}
const response=(value:unknown,status=200)=>new Response(JSON.stringify(value),{status})
const flush=async()=>{await new Promise(resolve=>setImmediate(resolve))}
const waitFor=async(check:()=>boolean)=>{const until=Date.now()+1000;while(!check()){if(Date.now()>until)throw Error('Expected sharing operation did not start.');await new Promise(resolve=>setTimeout(resolve,5))}}
async function receipt(pack= pkg()){
 return {shareId,version:pack.version,sha256:await sharePackageDigest(pack),shareUrl:templateShareSiteOrigin+'/share/?id='+shareId,downloadUrl:templateShareApiOrigin+'/v1/shares/'+shareId+'/package',publishedAt:'2026-10-21T12:00:00.000Z',revoked:false}
}

test('就绪检测不打开窗口、不带身份；服务缺失仍允许本地接收',async t=>{
 const calls:unknown[]=[]
 const f=fixture(async(url,init)=>{calls.push([url,init]);return response({format:'teloa.template-share-service/v1',available:true,apiOrigin:templateShareApiOrigin,siteOrigin:templateShareSiteOrigin})});t.after(()=>f.bridge.dispose())
 assert.deepEqual(await f.bridge.policy(),{receiveMode:'personal-role',canPublish:true});assert.equal(f.openCount(),0)
 assert.equal((calls[0] as [string,RequestInit])[1].credentials,'omit')
 const g=fixture(async()=>response({error:'service_unavailable'},503));t.after(()=>g.bridge.dispose())
 assert.deepEqual(await g.bridge.policy(),{receiveMode:'personal-role',canPublish:false,reason:'service-unavailable'})
})

test('发布只接受原官方窗口+来源+nonce+请求的回执，不发送认证令牌',async t=>{
 const f=fixture();t.after(()=>f.bridge.dispose());const pack=pkg(),expected=await receipt(pack)
 const result=f.bridge.publish({requestId,package:pack});await waitFor(()=>f.openCount()===1)
 assert.equal(f.openCount(),1);assert.equal(f.sent.length,0);assert.equal(new URL(f.opened()).origin,templateShareSiteOrigin)
 assert.match(String(f.envelope().nonce),/^[a-f0-9]{64}$/)
 f.emit({...f.envelope(),type:'ready'},'https://attacker.example');f.emit({...f.envelope(),type:'ready'},templateShareSiteOrigin,{})
 f.emit({...f.envelope(),nonce:'0'.repeat(64),type:'ready'});assert.equal(f.sent.length,0)
 f.ready();assert.equal(f.sent.length,1);assert.deepEqual(Object.keys(f.sent[0]!).sort(),['body','format','id','method','nonce','type'])
 assert.deepEqual(f.sent[0]!.body,{requestId,package:pack,sha256:expected.sha256})
 let completed=false;void result.then(()=>{completed=true})
 f.emit({...f.envelope(),type:'result',id:'old-request',method:'publish',value:expected});await flush();assert.equal(completed,false)
 f.answer(expected);await flush();assert.equal(completed,false,'本人身份握手完成前不接受发布成功')
 f.authorize();assert.equal(f.accepted.length,1);f.answer(expected);assert.deepEqual(await result,expected)
})

test('服务回执固定摘要/版本/官方URL均复验，不能把错误发布对象交付为成功',async t=>{
 for(const change of [{sha256:'0'.repeat(64)},{version:'9.0.0'},{shareUrl:'https://attacker.example/'}]){
  const f=fixture();t.after(()=>f.bridge.dispose());const pack=pkg(),result=f.bridge.publish({requestId,package:pack});await waitFor(()=>f.openCount()===1);f.ready();f.authorize();f.answer({...await receipt(pack),...change});await assert.rejects(result,{code:'invalid-host-response'})
 }
})

test('同一发布请求冷恢复不能借换号另发一份，身份固定值不包含认证令牌',async t=>{
 const values=new Map<string,string>(),storage={getItem:(key:string)=>values.get(key)??null,setItem:(key:string,value:string)=>{values.set(key,value)}}
 const f=fixture(undefined,storage);t.after(()=>f.bridge.dispose());const pack=pkg(),first=f.bridge.publish({requestId,package:pack});await waitFor(()=>f.openCount()===1);f.ready();f.authorize();f.bridge.dispose();await assert.rejects(first,{code:'context-changed'})
 assert.equal(values.get('teloa.template-publisher/v1/'+requestId),'33333333-3333-4333-a333-333333333333')
 const g=fixture(undefined,storage);t.after(()=>g.bridge.dispose());const retry=g.bridge.publish({requestId,package:pack});await waitFor(()=>g.openCount()===1);g.ready();g.authorize('44444444-4444-4444-a444-444444444444');await assert.rejects(retry,{code:'context-changed'});assert.equal(g.accepted.length,0)
})

test('已完成操作之后，新独立请求允许在官方页明确使用新账号',async t=>{
 const f=fixture();t.after(()=>f.bridge.dispose())
 const first=f.bridge.list();f.ready();f.authorize();f.answer({items:[]});assert.deepEqual(await first,[])
 const second=f.bridge.list();f.authorize('44444444-4444-4444-a444-444444444444');f.answer({items:[]});assert.deepEqual(await second,[])
 assert.equal(f.accepted.length,2);assert.equal(f.openCount(),1)
})

test('关闭或连接销毁拒绝在途请求，重试仍发送原发布requestId',async t=>{
 const f=fixture();t.after(()=>f.bridge.dispose());const pack=pkg(),first=f.bridge.publish({requestId,package:pack});await waitFor(()=>f.openCount()===1);f.ready();f.popup.closed=true
 await assert.rejects(first,{code:'cancelled'});f.popup.closed=false
 const second=f.bridge.publish({requestId,package:pack});await waitFor(()=>f.openCount()===2);f.ready();assert.equal((f.sent.at(-1)!.body as {requestId:string}).requestId,requestId)
 f.bridge.dispose();await assert.rejects(second,{code:'context-changed'})
})

test('分享链接只解析固定官方地址，不跟随任意URL；只预览不自动接收',async t=>{
 assert.deepEqual(readWebTemplateShareLink(templateShareSiteOrigin+'/share/?id='+shareId),{shareId})
 for(const url of ['https://attacker.example/share/?id='+shareId,templateShareSiteOrigin+'/share/?id='+shareId+'&next=https://attacker.example',templateShareSiteOrigin+'/share/?id='+shareId+'#x','javascript:alert(1)'])assert.throws(()=>readWebTemplateShareLink(url))
 const f=fixture();t.after(()=>f.bridge.dispose());const intents:unknown[]=[];f.bridge.subscribe(value=>intents.push(value));f.bridge.receiveLink(templateShareSiteOrigin+'/en/share/?id='+shareId)
 assert.deepEqual(await f.bridge.pending(),{shareId});assert.equal(f.openCount(),0);await f.bridge.dismiss({shareId});assert.deepEqual(intents,[{shareId},null])
})

test('公开包完整摘要核对，撤销或超限立即失败，读取不用Cookie且不跟随重定向',async t=>{
 const pack=pkg(),fixed=await receipt(pack),calls:RequestInit[]=[]
 const f=fixture(async(url,init)=>{calls.push(init!);return response(String(url).endsWith('/package')?pack:{...fixed,downloadUrl:fixed.downloadUrl})});t.after(()=>f.bridge.dispose())
 assert.deepEqual(await f.bridge.read({shareId}),{shareId,package:pack,sha256:fixed.sha256});assert.equal(calls.length,2);assert.ok(calls.every(init=>init.credentials==='omit'&&init.redirect==='error'))
 const g=fixture(async url=>String(url).endsWith('/package')?response({error:'revoked'},410):response(fixed));t.after(()=>g.bridge.dispose());await assert.rejects(g.bridge.read({shareId}),{status:410})
 const h=fixture(async()=>new Response('x'.repeat(1024*1024+1)));t.after(()=>h.bridge.dispose());await assert.rejects(h.bridge.read({shareId}),{code:'invalid-host-response'})
})

test('合法500资源预览可超过128KiB，仍核完整包摘要而非拒收或截断',async t=>{
 const pack=buildSharePlan({subject:'app',title:'Large skill collection',description:'A fixed collection of public methods.',publisher:'Test author',roles:[],skills:Array.from({length:500},(_,index)=>({name:'method-'+index,title:('Method '+index+' ').padEnd(120,'x'),publicId:('method-'+index+'-').padEnd(110,'x')}))})
 const fixed=await receipt(pack),manifest=JSON.parse(pack.files.find(file=>file.path==='teloa.json')!.text)
 const preview={...fixed,resources:manifest.resources.map((resource:{id:string;kind:string;title:string;source:unknown})=>({id:resource.id,kind:resource.kind,title:resource.title,source:resource.source}))}
 assert.ok(new TextEncoder().encode(JSON.stringify(preview)).byteLength>128*1024)
 const f=fixture(async url=>response(String(url).endsWith('/package')?pack:preview));t.after(()=>f.bridge.dispose())
 assert.equal((await f.bridge.read({shareId})).sha256,fixed.sha256)
})
