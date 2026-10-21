import {WorkError,readTwinDraft,readTwinDraftAdoption,readTwinDraftCommand,readTwinDraftCreate,twinDraftRecord,twinDraftUuid,type TwinDraft,type TwinDraftAdoption,type TwinDraftDirectory,type TwinDraftCreate,type TwinDraftCommand,type TwinDraftRevise,type TwinDraftReturn} from '@teloa/contract'
import {sha256Hex} from './delivery-review-presentation.ts'
type Call=(endpoint:string,input:unknown)=>Promise<unknown>
type Storage=Pick<globalThis.Storage,'getItem'|'setItem'|'removeItem'>
type Edit={roleId:string;revision:number;bodyHash:string;body:string}
export type GroupTwinDraftTarget={roleId:string;roleVersion:number;groupId:string;messageId:string}
type GroupReply=GroupTwinDraftTarget&{body:string;requestId?:string;draft?:TwinDraft}
type Pending=({operation:'adopt';input:TwinDraftCommand}|{operation:'revise';input:TwinDraftRevise}|{operation:'return';input:TwinDraftReturn}|{operation:'create';input:TwinDraftCreate})&{draft?:TwinDraft}
export type TwinDraftApiOptions={ownerId:string;namespace:string;storage?:Storage;generation?:()=>unknown;isCurrent?:()=>boolean}
export type TwinDraftApi=ReturnType<typeof createTwinDraftApi>
const bad=()=>new WorkError('teloa/invalid-host-response','代拟稿回执与本人原请求不一致；请核对上次结果。')
function readPending(value:unknown):Pending{
 const r=twinDraftRecord(value,['operation','input'],['draft'])
 if(r.operation==='create')return {operation:r.operation,input:readTwinDraftCreate(r.input)}
 if(!['adopt','revise','return'].includes(String(r.operation)))throw bad()
 const extra=r.operation==='revise'?'body':r.operation==='return'?'reason':null
 return {operation:r.operation,input:readTwinDraftCommand(r.input,extra),draft:readTwinDraft(r.draft)} as Pending
}
/** 服务端是稿件真源。浏览器只保留本空间未提交编辑和冻结请求，不保存采用授权。 */
export function createTwinDraftApi(call:Call,options:TwinDraftApiOptions){
 if(!options.ownerId.trim()||!options.namespace.trim())throw bad()
 const key='teloa.twin-drafts/v1/'+encodeURIComponent(options.namespace)+'/'+encodeURIComponent(options.ownerId),listeners=new Set<()=>void>()
 let pending:Pending|undefined,edits:Record<string,Edit>={},groupReplies:Record<string,GroupReply>={},error:unknown,busy=false,revision=0,unsaved=false
 const replyKey=(source:GroupTwinDraftTarget)=>JSON.stringify([source.roleId,source.groupId,source.messageId])
 const publish=()=>{revision++;for(const listener of listeners)listener()}
 const sync=()=>{
  if(unsaved)return
  try{
   const raw=options.storage?.getItem(key);if(!raw)return
   const r=twinDraftRecord(JSON.parse(raw),['ownerId','namespace','pending','edits'],['groupReplies'])
   if(r.ownerId!==options.ownerId||r.namespace!==options.namespace)throw bad()
   pending=r.pending===null?undefined:readPending(r.pending)
   const rows=twinDraftRecord(r.edits,[],Object.keys(r.edits as object)),next:Record<string,Edit>={}
   for(const [id,v]of Object.entries(rows)){const e=twinDraftRecord(v,['roleId','revision','bodyHash','body']);if(!twinDraftUuid(id)||!twinDraftUuid(e.roleId)||!Number.isSafeInteger(e.revision)||Number(e.revision)<1||typeof e.bodyHash!=='string'||!/^[a-f0-9]{64}$/.test(e.bodyHash)||typeof e.body!=='string'||e.body.length>8000)throw bad();next[id]={roleId:e.roleId,revision:Number(e.revision),bodyHash:e.bodyHash,body:e.body}}
   edits=next
   const replies=r.groupReplies===undefined?{}:twinDraftRecord(r.groupReplies,[],Object.keys(r.groupReplies as object)),kept:Record<string,GroupReply>={}
   for(const [key,v]of Object.entries(replies)){
    const row=twinDraftRecord(v,['roleId','roleVersion','groupId','messageId','body'],['requestId','draft'])
    if(!twinDraftUuid(row.roleId)||!twinDraftUuid(row.groupId)||!twinDraftUuid(row.messageId)||!Number.isSafeInteger(row.roleVersion)||Number(row.roleVersion)<1||typeof row.body!=='string'||row.body.length>8000||row.requestId!==undefined&&!twinDraftUuid(row.requestId))throw bad()
    const source={roleId:row.roleId,roleVersion:Number(row.roleVersion),groupId:row.groupId,messageId:row.messageId}
    if(key!==replyKey(source))throw bad()
    const draft=row.draft===undefined?undefined:readTwinDraft(row.draft)
    if(draft&&(draft.ownerId!==options.ownerId||draft.roleId!==source.roleId||draft.source.kind!=='group'||draft.source.groupId!==source.groupId||draft.source.messageId!==source.messageId))throw bad()
    kept[key]={...source,body:row.body,...(row.requestId?{requestId:row.requestId as string}:{}),...(draft?{draft}:{})}
   }
   groupReplies=kept
  }catch(e){error=e}
 }
 const persist=()=>{try{if(!options.storage)throw Error();options.storage.setItem(key,JSON.stringify({ownerId:options.ownerId,namespace:options.namespace,pending:pending??null,edits,groupReplies}));error=undefined;unsaved=false}catch{unsaved=true;error=new WorkError('teloa/recovery-write-failed','浏览器草稿尚未持久保存，请保留当前视图；新输入仍在本页内。');throw error}finally{publish()}}
 const invoke=async(endpoint:string,input:unknown)=>{
  if(options.isCurrent?.()===false)throw new WorkError('teloa/conflict','本人空间已切换，草稿仍保留在原空间。')
  const generation=options.generation?.(),value=await call(endpoint,input)
  if(options.isCurrent?.()===false||options.generation&&options.generation()!==generation)throw new WorkError('teloa/conflict','连接或本人空间已变化，请核对原请求。')
  return value
 }
 const assertCurrent=(generation:unknown)=>{if(options.isCurrent?.()===false||options.generation&&options.generation()!==generation)throw new WorkError('teloa/conflict','连接或本人空间已变化，请核对原请求。')}
 const hash=sha256Hex
 const checked=async(value:unknown)=>{const d=readTwinDraft(value);if(d.ownerId!==options.ownerId||d.bodyHash!==await hash(d.body)||d.source.bodyHash!==await hash(d.source.text))throw bad();return d}
 const verify=async(value:unknown,request:Pending):Promise<TwinDraft|TwinDraftAdoption>=>{
  const adoption=request.operation==='adopt'?readTwinDraftAdoption(value):undefined,d=await checked(adoption?adoption.draft:value),i=request.input
  if('draftId'in i&&(d.id!==i.draftId||d.revision!==i.expectedRevision+1||d.roleVersion!==i.expectedRoleVersion)||'roleId'in i&&(d.roleId!==i.roleId||d.roleVersion!==i.expectedRoleVersion||d.revision!==1||d.body!==i.body||d.title!==i.title))throw bad()
  if(request.operation==='adopt'&&(adoption!.receipt.requestId!==i.requestId||d.bodyHash!==(i as TwinDraftCommand).expectedBodyHash))throw bad()
  if(request.operation==='revise'&&(d.body!==request.input.body||d.state!=='draft'))throw bad()
  if(request.operation==='return'&&(d.returnReason!==request.input.reason||d.state!=='returned'||d.bodyHash!==request.input.expectedBodyHash))throw bad()
  if(request.operation!=='create'){
   const original=request.draft
   if(!original||original.ownerId!==options.ownerId||d.roleId!==original.roleId||d.source.kind!==original.source.kind||d.source.bodyHash!==original.source.bodyHash||JSON.stringify(d.basis.map(({id,version,contentHash})=>({id,version,contentHash})))!==JSON.stringify(original.basis.map(({id,version,contentHash})=>({id,version,contentHash}))))throw bad()
   if(d.source.kind==='group'&&(original.source.kind!=='group'||d.source.groupId!==original.source.groupId||d.source.messageId!==original.source.messageId||d.source.rootId!==original.source.rootId))throw bad()
   if(d.source.kind==='conversation'&&(original.source.kind!=='conversation'||d.source.sessionId!==original.source.sessionId||d.source.messageId!==original.source.messageId||d.source.messageSeq!==original.source.messageSeq))throw bad()
   if(request.operation!=='revise'&&d.body!==original.body)throw bad()
  }
  if(request.operation==='create'){
   if(d.state!=='draft'||d.returnReason!==undefined)throw bad()
   const source=request.input.source,returned=d.source
   const identity=returned.kind==='group'?{kind:returned.kind,groupId:returned.groupId,messageId:returned.messageId}:returned.kind==='conversation'?{kind:returned.kind,sessionId:returned.sessionId,messageId:returned.messageId,messageSeq:returned.messageSeq}:{kind:returned.kind,label:returned.label,text:returned.text}
   if(JSON.stringify(source)!==JSON.stringify(identity)||JSON.stringify(request.input.basis)!==JSON.stringify(d.basis.map(({id,version,contentHash})=>({id,version,contentHash}))))throw bad()
  }
  return adoption??d
 }
 const send=async():Promise<TwinDraft|TwinDraftAdoption>=>{
  sync();if(error)throw error;if(!pending)throw new WorkError('teloa/conflict','没有需要核对的代拟稿请求。');if(busy)throw new WorkError('teloa/conflict','正在核对上次结果。')
  const request=structuredClone(pending),generation=options.generation?.();busy=true;publish()
  try{
   persist()
   let value:unknown
   if(request.operation==='adopt')value=await invoke('twin-drafts/receipt',{requestId:request.input.requestId})
   if(value===undefined||value===null)value=await invoke('twin-drafts/'+request.operation,request.input)
   const result=await verify(value,request);assertCurrent(generation)
   sync();if(pending?.input.requestId===request.input.requestId)pending=undefined
   if(request.operation==='revise'){const edit=edits[request.input.draftId];if(edit?.revision===request.input.expectedRevision&&edit.body.trim()===request.input.body)delete edits[request.input.draftId]}
   if(request.operation==='create'&&request.input.source.kind==='group'){
    const slot=groupReplies[replyKey({roleId:request.input.roleId,roleVersion:request.input.expectedRoleVersion,groupId:request.input.source.groupId,messageId:request.input.source.messageId})]
    if(slot?.requestId===request.input.requestId&&slot.body.trim()===request.input.body)slot.draft=result as TwinDraft
   }
   persist();return result
  }catch(e){
   if(e&&typeof e==='object'&&'rejected'in e&&e.rejected===true&&'code'in e&&['teloa/invalid-input','teloa/forbidden','teloa/version-conflict','teloa/conflict','teloa/source-unavailable'].includes(String(e.code))){sync();if(pending?.input.requestId===request.input.requestId)pending=undefined;persist()}
   throw e
  }finally{busy=false;publish()}
 }
 const start=(request:Pending)=>{
  sync();if(error)throw error
  if(pending&&JSON.stringify(pending)!==JSON.stringify(request))throw new WorkError('teloa/conflict','请先核对上次代拟稿请求。')
  pending??=structuredClone(request);persist();return send()
 }
 const command=(d:TwinDraft):TwinDraftCommand=>({requestId:crypto.randomUUID(),draftId:d.id,expectedRevision:d.revision,expectedRoleVersion:d.roleVersion,expectedBodyHash:d.bodyHash})
 sync()
 return {
  ownerId:options.ownerId,namespace:options.namespace,
  subscribe:(listener:()=>void)=>{listeners.add(listener);return()=>{listeners.delete(listener)}},getSnapshot:()=>revision,
  pending:()=>{sync();return pending?structuredClone(pending):undefined},recoveryError:()=>error,hasUnsavedDraft:()=>unsaved,isBusy:()=>busy,
  editing:(id:string)=>{sync();return edits[id]?{...edits[id]}:undefined},
  groupReply:(source:GroupTwinDraftTarget)=>{sync();const slot=groupReplies[replyKey(source)];return slot?structuredClone(slot):undefined},
  editGroupReply(source:GroupTwinDraftTarget,body:string){
   sync();if(error&&!unsaved)throw error;if(body.length>8000)throw bad()
   const id=replyKey(source),slot=groupReplies[id]
   if(pending?.operation==='create'&&pending.input.roleId===source.roleId&&pending.input.source.kind==='group'&&pending.input.source.groupId===source.groupId&&pending.input.source.messageId===source.messageId)throw new WorkError('teloa/conflict','请先核对原保存请求。')
   groupReplies[id]={...source,roleVersion:slot?.roleVersion??source.roleVersion,body};persist()
  },
  rebaseGroupReply(source:GroupTwinDraftTarget){sync();if(error)throw error;const slot=groupReplies[replyKey(source)];if(slot){groupReplies[replyKey(source)]={...source,body:slot.body};persist()}},
  async saveGroupReply(source:GroupTwinDraftTarget,title:string){
   const generation=options.generation?.();assertCurrent(generation)
   sync();if(error)throw error;const id=replyKey(source),slot=groupReplies[id]
   if(!slot?.body.trim())throw new WorkError('teloa/invalid-input','请先准备回复正文。')
   if(slot.roleVersion!==source.roleVersion)throw new WorkError('teloa/version-conflict','分身版本已变化，请复核保留的回复。')
   if(slot.draft&&slot.draft.body===slot.body.trim()){const draft=await checked(slot.draft);assertCurrent(generation);return draft}
   slot.requestId??=crypto.randomUUID();persist()
   return start({operation:'create',input:readTwinDraftCreate({requestId:slot.requestId,roleId:source.roleId,expectedRoleVersion:source.roleVersion,title,body:slot.body,basis:[],source:{kind:'group',groupId:source.groupId,messageId:source.messageId}})}) as Promise<TwinDraft>
  },
  edit(draft:TwinDraft,body:string){if(draft.ownerId!==options.ownerId||body.length>8000)throw bad();sync();if(error&&!unsaved)throw error;edits[draft.id]={...(edits[draft.id]??{roleId:draft.roleId,revision:draft.revision,bodyHash:draft.bodyHash}),body};persist()},
  rebase(draft:TwinDraft){sync();if(error)throw error;const edit=edits[draft.id];if(edit){edits[draft.id]={roleId:draft.roleId,revision:draft.revision,bodyHash:draft.bodyHash,body:edit.body};persist()}},
  async list(roleId:string):Promise<TwinDraftDirectory>{
   const generation=options.generation?.()
   if(!twinDraftUuid(roleId))throw bad()
   const r=twinDraftRecord(await invoke('twin-drafts/list',{roleId}),['ownerId','roleId','roleVersion','drafts'])
   if(r.ownerId!==options.ownerId||r.roleId!==roleId||!Number.isSafeInteger(r.roleVersion)||Number(r.roleVersion)<1||!Array.isArray(r.drafts))throw bad()
   const drafts=await Promise.all(r.drafts.map(checked));if(drafts.some(d=>d.roleId!==roleId||d.roleVersion>Number(r.roleVersion))||new Set(drafts.map(d=>d.id)).size!==drafts.length)throw bad()
   assertCurrent(generation);return {ownerId:options.ownerId,roleId,roleVersion:Number(r.roleVersion),drafts}
  },
  async get(draftId:string){const generation=options.generation?.(),d=await checked(await invoke('twin-drafts/get',{draftId}));assertCurrent(generation);if(d.id!==draftId)throw bad();return d},
  create:(input:TwinDraftCreate)=>start({operation:'create',input:readTwinDraftCreate(input)}) as Promise<TwinDraft>,
  revise:(draft:TwinDraft,body:string)=>{sync();const edit=edits[draft.id];if(edit&&(edit.revision!==draft.revision||edit.bodyHash!==draft.bodyHash))throw new WorkError('teloa/version-conflict','稿件已变化，请先复核保留的修改。');return start({operation:'revise',input:readTwinDraftCommand({...command(draft),body},'body') as TwinDraftRevise,draft}) as Promise<TwinDraft>},
  return:(draft:TwinDraft,reason:string)=>start({operation:'return',input:readTwinDraftCommand({...command(draft),reason},'reason') as TwinDraftReturn,draft}) as Promise<TwinDraft>,
  adopt:(draft:TwinDraft)=>start({operation:'adopt',input:command(draft),draft}) as Promise<TwinDraftAdoption>,
  recover:send,
 }
}
