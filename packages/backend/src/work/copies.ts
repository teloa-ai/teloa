import { randomUUID } from 'node:crypto'
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises'
import { dirname } from 'node:path'
import { WorkError } from '@teloa/contract'

export type CopyState='pending'|'ready'|'rejected'

export type CopyRecord={
  ownerId:string
  requestId:string
  sourceSessionId:string
  state:CopyState
  childSessionId?:string
  createdAt:string
  releasedAt?:string
}

export interface CopyRepository {read():Promise<CopyRecord[]>;write(rows:CopyRecord[]):Promise<void>}
export interface CopyHost {
  fork(sourceSessionId:string):Promise<string>
  inspect(childSessionId:string):Promise<{parentSession?:string;origin?:string}>
}

/** 仅表示宿主明确确认未创建副本；其他异常的结果都必须视为未知。 */
export class CopyRejectedError extends Error {
  constructor(message:string) {super(message);this.name='CopyRejectedError'}
}

/** 宿主已返回副本身份，但副本尚未达到可确认的 ready 状态。 */
export class CopyPendingError extends Error {
  readonly childSessionId:string
  constructor(childSessionId:string,message:string) {super(message);this.name='CopyPendingError';this.childSessionId=childSessionId}
}

const fields=['ownerId','requestId','sourceSessionId','state','childSessionId','createdAt','releasedAt']
const validId=(value:unknown):value is string=>typeof value==='string'&&/^[a-zA-Z0-9_-]{1,128}$/.test(value)
const validRequestId=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value)
const validOwner=(value:unknown):value is string=>typeof value==='string'&&value.trim().length>0&&value.length<=200
const object=(value:unknown):value is Record<string,unknown>=>typeof value==='object'&&value!==null&&!Array.isArray(value)

function corrupt():never {throw new WorkError('teloa/storage-corrupt','副本操作记录损坏，已停止读取，请核对原文件。')}

function validateRows(value:unknown):CopyRecord[] {
  if(!object(value)||value.schema!=='teloa.copies/v1'||Object.keys(value).some(key=>!['schema','rows'].includes(key))||!Array.isArray(value.rows))return corrupt()
  const requests=new Set<string>(),children=new Set<string>(),pendingSources=new Set<string>()
  for(const row of value.rows) {
    if(!object(row)||Object.keys(row).some(key=>!fields.includes(key))||!validOwner(row.ownerId)||!validRequestId(row.requestId)||!validId(row.sourceSessionId)||!['pending','ready','rejected'].includes(String(row.state))||typeof row.createdAt!=='string'||!Number.isFinite(Date.parse(row.createdAt)))return corrupt()
    if(row.releasedAt!==undefined&&(typeof row.releasedAt!=='string'||!Number.isFinite(Date.parse(row.releasedAt))||row.state==='rejected'))return corrupt()
    if(row.state==='ready'&&!validId(row.childSessionId))return corrupt()
    if(row.state==='pending'&&row.childSessionId!==undefined&&!validId(row.childSessionId))return corrupt()
    if(row.state==='rejected'&&row.childSessionId!==undefined)return corrupt()
    const requestKey=JSON.stringify([row.ownerId,row.requestId])
    if(requests.has(requestKey))return corrupt()
    requests.add(requestKey)
    if(row.childSessionId!==undefined) {
      if(children.has(row.childSessionId as string))return corrupt()
      children.add(row.childSessionId as string)
    }
    if(row.state==='pending'&&row.releasedAt===undefined) {
      const sourceKey=JSON.stringify([row.ownerId,row.sourceSessionId])
      if(pendingSources.has(sourceKey))return corrupt()
      pendingSources.add(sourceKey)
    }
  }
  return value.rows as CopyRecord[]
}

function inputObject(input:unknown,keys:string[]):Record<string,unknown> {
  if(!object(input)||Object.keys(input).some(key=>!keys.includes(key)))throw new WorkError('teloa/invalid-input','请求包含未知字段或格式不正确。')
  return input
}

export class FileCopyRepository implements CopyRepository {
  readonly path:string
  constructor(path:string) {this.path=path}
  async read():Promise<CopyRecord[]> {
    let content:string
    try {content=await readFile(this.path,'utf8')}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return [];throw error}
    let value:unknown
    try {value=JSON.parse(content)}catch{return corrupt()}
    return validateRows(value)
  }
  async write(rows:CopyRecord[]):Promise<void> {
    const value={schema:'teloa.copies/v1',rows}
    validateRows(value)
    await mkdir(dirname(this.path),{recursive:true})
    const temporary=this.path+'.'+randomUUID()+'.tmp'
    const handle=await open(temporary,'wx',0o600)
    try {
      try {await handle.writeFile(JSON.stringify(value,null,2)+'\n');await handle.sync()}finally{await handle.close()}
      await rename(temporary,this.path)
      const directory=await open(dirname(this.path),'r')
      try {await directory.sync()}finally{await directory.close()}
    }catch(error){await unlink(temporary).catch(()=>{});throw error}
  }
}

export class CopyService {
  readonly repository:CopyRepository
  readonly host:CopyHost
  readonly identity:{now:()=>string}
  readonly authorizeSource:(sourceSessionId:string)=>Promise<void>
  private pending:Promise<unknown>=Promise.resolve()
  private readonly inFlight=new Map<string,{requestId:string;result:Promise<CopyRecord>}>()
  constructor(repository:CopyRepository,host:CopyHost,identity:{now:()=>string},authorizeSource:(sourceSessionId:string)=>Promise<void>) {
    this.repository=repository;this.host=host;this.identity=identity;this.authorizeSource=authorizeSource
  }
  private serial<T>(operation:()=>Promise<T>):Promise<T> {
    const result=this.pending.then(operation);this.pending=result.catch(()=>{});return result
  }
  private async inspectChild(sourceSessionId:string,childSessionId:string):Promise<void> {
    const meta=await this.host.inspect(childSessionId)
    if(!object(meta)||meta.parentSession!==sourceSessionId||meta.origin!==undefined)throw new WorkError('teloa/copy-lineage-mismatch','所选会话不是该来源的普通副本。')
  }
  create(owner:string,input:unknown):Promise<CopyRecord> {
    let data:Record<string,unknown>
    try {data=inputObject(input,['sourceSessionId','requestId'])}catch(error){return Promise.reject(error)}
    if(!validOwner(owner)||!validId(data.sourceSessionId)||!validRequestId(data.requestId))return Promise.reject(new WorkError('teloa/invalid-input','创建副本需要合法主体、来源会话与请求 ID。'))
    const sourceSessionId=data.sourceSessionId,requestId=data.requestId
    const flightKey=JSON.stringify([owner,sourceSessionId])
    const running=this.inFlight.get(flightKey)
    if(running)return this.authorizeSource(sourceSessionId).then(()=>{
      if(running.requestId!==requestId)throw new WorkError('teloa/copy-result-unknown','该来源已有正在执行的副本请求，请等待结果后再操作。')
      return running.result
    })
    const result=this.serial(async()=>{
      await this.authorizeSource(sourceSessionId)
      const rows=await this.repository.read()
      const existing=rows.find(row=>row.ownerId===owner&&row.requestId===requestId)
      if(existing&&existing.sourceSessionId!==sourceSessionId)throw new WorkError('teloa/conflict','同一请求 ID 不能改为另一来源会话。')
      if(existing?.state==='pending')throw new WorkError('teloa/copy-result-unknown','此前副本请求结果未知，请显式选择已有副本恢复。')
      if(existing)return existing
      if(rows.some(row=>row.ownerId===owner&&row.sourceSessionId===sourceSessionId&&row.state==='pending'&&row.releasedAt===undefined))throw new WorkError('teloa/copy-result-unknown','该来源已有结果未知的副本请求，请先显式恢复。')
      const record:CopyRecord={ownerId:owner,requestId,sourceSessionId,state:'pending',createdAt:this.identity.now()}
      await this.repository.write([...rows,record])
      let childSessionId:string
      try {childSessionId=await this.host.fork(sourceSessionId)}catch(error){
        if(error instanceof CopyPendingError) {
          if(!validId(error.childSessionId))throw new WorkError('teloa/invalid-host-response','宿主未返回合法副本会话身份。')
          if(rows.some(row=>row.childSessionId===error.childSessionId))throw new WorkError('teloa/conflict','宿主返回的副本已经关联另一条操作记录。')
          await this.repository.write(rows.concat({...record,childSessionId:error.childSessionId}))
        }
        if(error instanceof CopyRejectedError) {
          const rejected:CopyRecord={...record,state:'rejected'}
          await this.repository.write(rows.concat(rejected))
        }
        throw error
      }
      if(!validId(childSessionId))throw new WorkError('teloa/invalid-host-response','宿主未返回合法副本会话身份。')
      if(rows.some(row=>row.childSessionId===childSessionId))throw new WorkError('teloa/conflict','宿主返回的副本已经关联另一条操作记录。')
      const known:CopyRecord={...record,childSessionId}
      await this.repository.write(rows.concat(known))
      try {await this.inspectChild(sourceSessionId,childSessionId)}catch(error){
        if(error instanceof CopyPendingError&&error.childSessionId!==childSessionId)throw new WorkError('teloa/conflict','宿主对待确认副本返回了另一会话身份。')
        throw error
      }
      const ready:CopyRecord={...record,state:'ready',childSessionId}
      await this.repository.write(rows.concat(ready))
      return ready
    })
    const flight={requestId,result}
    this.inFlight.set(flightKey,flight)
    const clear=()=>{if(this.inFlight.get(flightKey)===flight)this.inFlight.delete(flightKey)}
    result.then(clear,clear)
    return result
  }
  list(owner:string,input:unknown):Promise<CopyRecord[]> {
    return this.serial(async()=>{
      inputObject(input,[])
      if(!validOwner(owner))throw new WorkError('teloa/invalid-input','缺少合法主体。')
      return (await this.repository.read()).filter(row=>row.ownerId===owner)
    })
  }
  /** 只记录本人允许另建的决定，不宣称原操作已取消或未创建。 */
  release(owner:string,input:unknown):Promise<CopyRecord> {
    let data:Record<string,unknown>
    try{data=inputObject(input,['requestId','acceptPossibleDuplicate'])}catch(error){return Promise.reject(error)}
    if(!validOwner(owner)||!validRequestId(data.requestId)||data.acceptPossibleDuplicate!==true)return Promise.reject(new WorkError('teloa/invalid-input','需要明确接受原请求可能已创建副本，才能另建独立副本。'))
    const requestId=data.requestId
    for(const [key,flight] of this.inFlight)if(JSON.parse(key)[0]===owner&&flight.requestId===requestId)return Promise.reject(new WorkError('teloa/copy-in-progress','副本仍在创建，请等待本次请求结束。'))
    return this.serial(async()=>{
      const rows=await this.repository.read(),record=rows.find(row=>row.ownerId===owner&&row.requestId===requestId)
      if(!record)throw new WorkError('teloa/not-found','没有可核对的副本记录。')
      await this.authorizeSource(record.sourceSessionId)
      if(record.state!=='pending')throw new WorkError('teloa/conflict','副本结果已变化，请刷新后核对。')
      if(record.releasedAt)return record
      const released:CopyRecord={...record,releasedAt:this.identity.now()}
      await this.repository.write(rows.map(row=>row===record?released:row))
      return released
    })
  }
  resolve(owner:string,input:unknown):Promise<CopyRecord> {
    return this.serial(async()=>{
      const data=inputObject(input,['requestId','childSessionId'])
      if(!validOwner(owner)||!validRequestId(data.requestId)||!validId(data.childSessionId))throw new WorkError('teloa/invalid-input','恢复副本需要合法主体、请求 ID 与副本会话。')
      const requestId=data.requestId,childSessionId=data.childSessionId
      const rows=await this.repository.read()
      const record=rows.find(row=>row.ownerId===owner&&row.requestId===requestId)
      if(!record)throw new WorkError('teloa/not-found','没有可恢复的副本操作记录。')
      await this.authorizeSource(record.sourceSessionId)
      if(record.state==='ready') {
        if(record.childSessionId!==childSessionId)throw new WorkError('teloa/conflict','此请求已确认另一副本会话。')
        return record
      }
      if(record.state==='rejected')throw new WorkError('teloa/conflict','宿主已确认此请求没有创建副本。')
      if(record.childSessionId!==undefined&&record.childSessionId!==childSessionId)throw new WorkError('teloa/conflict','此请求已有待确认的副本会话，不能改绑。')
      try {await this.inspectChild(record.sourceSessionId,childSessionId)}catch(error){
        if(error instanceof CopyPendingError) {
          if(!validId(error.childSessionId))throw new WorkError('teloa/invalid-host-response','宿主未返回合法副本会话身份。')
          if(error.childSessionId!==childSessionId)throw new WorkError('teloa/conflict','宿主对待确认副本返回了另一会话身份。')
          if(record.childSessionId===undefined) {
            if(rows.some(row=>row!==record&&row.childSessionId===childSessionId))throw new WorkError('teloa/conflict','所选副本已关联另一条操作记录。')
            const known:CopyRecord={...record,childSessionId}
            await this.repository.write(rows.map(row=>row===record?known:row))
          }
        }
        throw error
      }
      if(rows.some(row=>row!==record&&row.childSessionId===childSessionId))throw new WorkError('teloa/conflict','所选副本已关联另一条操作记录。')
      const ready:CopyRecord={...record,state:'ready',childSessionId}
      await this.repository.write(rows.map(row=>row===record?ready:row))
      return ready
    })
  }
}
