import test from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID,createHash} from 'node:crypto'
const hash=(text:string)=>createHash('sha256').update(text).digest('hex')
test('未知采用保留原请求，刷新核对原回执且不重发，切换空间拒收迟答',async()=>{
 let api:Record<string,any>={}
 try{api=await import('../src/client/twin-drafts-api.ts')}catch(e){if((e as NodeJS.ErrnoException).code!=='ERR_MODULE_NOT_FOUND')throw e}
 assert.equal(typeof api.createTwinDraftApi,'function','需要真实API的恢复与身份隔离')
 const map=new Map<string,string>(),storage={getItem:(k:string)=>map.get(k)??null,setItem:(k:string,v:string)=>{map.set(k,v)},removeItem:(k:string)=>{map.delete(k)}}
 const owner='owner-a',roleId=randomUUID(),id=randomUUID(),groupId=randomUUID()
 const draft={schema:'teloa.twin-draft/v1',ownerId:owner,id,roleId,roleVersion:1,revision:1,state:'draft',title:'回复',body:'收到',bodyHash:hash('收到'),source:{kind:'group',groupId,messageId:randomUUID(),groupVersion:1,rootId:null,label:'研发',text:'进度？',bodyHash:hash('进度？')},basis:[],createdAt:'2026-10-21T00:00:00Z',updatedAt:'2026-10-21T00:00:00Z'}
 let sends=0,receipt:unknown
 const call=async(endpoint:string,input:any)=>{if(endpoint==='twin-drafts/adopt'){sends++;receipt={draft:{...draft,state:'sent',revision:2},receipt:{requestId:input.requestId,draftId:id,revision:2,bodyHash:draft.bodyHash,decidedAt:draft.updatedAt,result:{kind:'group-message',groupId,messageId:randomUUID(),authorId:'self'}}};throw Error('lost response')}if(endpoint==='twin-drafts/receipt')return receipt;throw Error(endpoint)}
 const options={ownerId:owner,namespace:'space-a',storage}
 const a=api.createTwinDraftApi(call,options);a.edit(draft,'保留修改')
 await assert.rejects(a.adopt(draft));const pending=a.pending();assert.ok(pending)
 const b=api.createTwinDraftApi(call,options);assert.equal(b.editing(id).body,'保留修改')
 const saved=await b.recover();assert.equal(saved.receipt.requestId,pending.input.requestId);assert.equal(sends,1);assert.equal(b.pending(),undefined)
 const isolated=api.createTwinDraftApi(call,{...options,ownerId:'owner-b',namespace:'space-b'});assert.equal(isolated.editing(id),undefined)
 let generation=1,resolve!:(v:unknown)=>void
 const c=api.createTwinDraftApi(()=>new Promise(r=>resolve=r),{...options,generation:()=>generation})
 const read=c.list(roleId);generation++;resolve({ownerId:owner,roleId,roleVersion:1,drafts:[draft]})
 await assert.rejects(read)
 let full=false
 const quota={...storage,setItem:(k:string,v:string)=>{if(full)throw Object.assign(Error('full'),{name:'QuotaExceededError'});storage.setItem(k,v)}}
 const d=api.createTwinDraftApi(call,{...options,storage:quota})
 d.edit(draft,'已存版本');full=true
 assert.throws(()=>d.edit(draft,'不能丢的新修改'))
 assert.equal(d.editing(id).body,'不能丢的新修改','旧持久值不能覆盖当前未持久输入')
 assert.ok(d.recoveryError())
 full=false;d.edit(draft,'不能丢的新修改')
 assert.equal(api.createTwinDraftApi(call,options).editing(id).body,'不能丢的新修改')
 const corrupt=api.createTwinDraftApi(async()=>({...draft,body:'篡改内容'}),options)
 await assert.rejects(corrupt.get(id),{code:'teloa/invalid-host-response'})
 const longText='原文'.repeat(64001),longSource=api.createTwinDraftApi(async()=>({...draft,source:{...draft.source,text:longText,bodyHash:hash(longText)}}),options)
 assert.equal((await longSource.get(id)).source.text,longText,'可信来源全文不受发送正文8000字上限截断或拒收')
 const mismatch=api.createTwinDraftApi(async()=>({...draft,source:{...draft.source,messageId:randomUUID()}}),options)
 await assert.rejects(mismatch.create({requestId:randomUUID(),roleId,expectedRoleVersion:1,title:draft.title,body:draft.body,basis:[],source:{kind:'group',groupId,messageId:draft.source.messageId}}),{code:'teloa/invalid-host-response'})
 assert.ok(mismatch.pending(),'来源回执不符不能清除冻结请求')
})

test('群来源回复输入按来源隔离，关闭后的未知创建可恢复且已保存后不重复新建',async()=>{
 const {createTwinDraftApi}=await import('../src/client/twin-drafts-api.ts')
 assert.equal(typeof (createTwinDraftApi(async()=>null,{ownerId:'owner',namespace:'space'}) as any).groupReply,'function','需要来源隔离的未提交回复输入')
 const map=new Map<string,string>(),storage={getItem:(k:string)=>map.get(k)??null,setItem:(k:string,v:string)=>{map.set(k,v)},removeItem:(k:string)=>{map.delete(k)}},options={ownerId:'owner',namespace:'space',storage}
 const source={roleId:randomUUID(),roleVersion:1,groupId:randomUUID(),messageId:randomUUID()},saved=new Map<string,unknown>()
 let lose=true,creates=0
 const call=async(endpoint:string,input:any)=>{
  assert.equal(endpoint,'twin-drafts/create')
  if(!saved.has(input.requestId)){creates++;saved.set(input.requestId,{schema:'teloa.twin-draft/v1',id:randomUUID(),ownerId:'owner',roleId:input.roleId,roleVersion:1,revision:1,state:'draft',title:input.title,body:input.body,bodyHash:hash(input.body),source:{kind:'group',groupId:input.source.groupId,messageId:input.source.messageId,groupVersion:1,rootId:null,label:'研发',text:'进度？',bodyHash:hash('进度？')},basis:[],createdAt:'2026-10-21T00:00:00Z',updatedAt:'2026-10-21T00:00:00Z'})}
  if(lose){lose=false;throw Error('lost create response')}return saved.get(input.requestId)
 }
 const a=createTwinDraftApi(call,options) as any
 assert.equal(a.groupReply(source),undefined)
 a.editGroupReply(source,'本人准备的回复')
 const b=createTwinDraftApi(call,options) as any;assert.equal(b.groupReply(source).body,'本人准备的回复')
 assert.equal(b.groupReply({...source,messageId:randomUUID()}),undefined)
 await assert.rejects(b.saveGroupReply(source,'回复研发'))
 const c=createTwinDraftApi(call,options) as any;await c.recover()
 assert.equal(c.groupReply(source).draft.state,'draft');assert.equal(creates,1)
 await c.saveGroupReply(source,'回复研发');assert.equal(creates,1,'关闭后迟到的成功回执必须保留，重开不能重复新建')
 const outdated=createTwinDraftApi(call,{...options,isCurrent:()=>false})
 await assert.rejects(outdated.saveGroupReply(source,'回复研发'),{code:'teloa/conflict'},'缓存的已保存稿也不能跨本人空间继续打开')
 const invalidState=createTwinDraftApi(async(_endpoint,input:any)=>({...await call('twin-drafts/create',input) as object,state:'sent'}),{...options,namespace:'invalid-state'})
 invalidState.editGroupReply(source,'本人新回复')
 await assert.rejects(invalidState.saveGroupReply(source,'回复研发'),{code:'teloa/invalid-host-response'},'保存候选的回执不能冒称已发送')
})
