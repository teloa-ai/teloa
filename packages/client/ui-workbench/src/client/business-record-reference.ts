import {readBusinessRecordGet,readBusinessRecordSnapshot,readBusinessRecordPage,readBusinessRichFieldValue,encodeBusinessRichFieldValue,type BusinessObjectSnapshot,type BusinessObjectFieldDefinition,type BusinessRichMultiReferenceFieldDefinition} from '@teloa/contract'
import type {BusinessRecordApi} from './business-record-api.js'
export type BusinessReferenceField=BusinessObjectFieldDefinition|BusinessRichMultiReferenceFieldDefinition
/** 原稿只经契约解码，非法值不作为目标、标题或可替换的空值。 */
export function businessReferenceSelection(field:BusinessReferenceField,raw:string):string[]|undefined{
 if(field.type!=='multi-reference')return raw?[raw]:[]
 try{const parsed=readBusinessRichFieldValue({...field,required:false},raw);return parsed?.type==='multi-reference'?parsed.ids:[]}catch{return undefined}
}
/** 用户操作才编码；任何容量或必填失败都由调用方保留原选择。 */
export function businessMultiReferenceChange(field:BusinessRichMultiReferenceFieldDefinition,raw:string,id:string,action:'add'|'remove'|'clear'):string{
 const selected=businessReferenceSelection(field,raw)
 if(!selected)throw Error('关联原值不可用，请保留原稿。')
 const next=action==='clear'?[]:action==='remove'?selected.filter(value=>value!==id):[...selected,id]
 if(!next.length){readBusinessRichFieldValue(field,'');return ''}
 return encodeBusinessRichFieldValue(field,next)
}
export type BusinessReferenceTarget={scope:string;type:string;id:string}
export type BusinessReferenceRecord=Pick<BusinessObjectSnapshot,'scope'|'type'|'id'|'version'|'snapshotHash'|'title'>
export type BusinessReferenceState={status:'empty'|'loading'|'archived'|'forbidden'|'unavailable'|'failed'}|{status:'ready';record:BusinessReferenceRecord}
const invalid=()=>Object.assign(Error('关联记录回包身份不一致。'),{code:'teloa/invalid-host-response'})
export function businessReferenceTargetValid(target:BusinessReferenceTarget){try{readBusinessRecordGet(target);return true}catch{return false}}
export function businessReferenceFailure(error:unknown):BusinessReferenceState{
 const code=error&&typeof error==='object'&&'code'in error?error.code:undefined
 return {status:code==='teloa/forbidden'?'forbidden':['teloa/not-found','teloa/invalid-input','teloa/invalid-host-response'].includes(String(code))?'unavailable':'failed'}
}
export async function readBusinessReference(api:Pick<BusinessRecordApi,'get'>,target:BusinessReferenceTarget,signal:AbortSignal):Promise<BusinessReferenceState>{
 if(!target.id)return {status:'empty'}
 if(!businessReferenceTargetValid(target))return {status:'unavailable'}
 try{
  const record=readBusinessRecordSnapshot(await api.get(target,signal),target.scope)
  if(record.type!==target.type||record.id!==target.id)throw invalid()
  if(record.deletedAt)return {status:'archived'}
  return {status:'ready',record:{scope:record.scope,type:record.type,id:record.id,version:record.version,snapshotHash:record.snapshotHash,title:record.title}}
 }catch(error){return businessReferenceFailure(error)}
}
/** 实例按本人API与目标隔离；只读结果不持有正文，也不写表单。 */
export class BusinessReferenceReader{
 private state:BusinessReferenceState
 private pending:AbortController|undefined
 private readonly listeners=new Set<()=>void>()
 private readonly api:Pick<BusinessRecordApi,'get'>
 private readonly target:BusinessReferenceTarget
 constructor(api:Pick<BusinessRecordApi,'get'>,target:BusinessReferenceTarget){this.api=api;this.target=target;this.state={status:!target.id?'empty':businessReferenceTargetValid(target)?'loading':'unavailable'}}
 getSnapshot=()=>this.state
 subscribe=(listener:()=>void)=>{this.listeners.add(listener);return()=>{this.listeners.delete(listener)}}
 private publish(state:BusinessReferenceState){this.state=state;for(const listener of this.listeners)listener()}
 dispose(){this.pending?.abort()}
 async read():Promise<BusinessReferenceRecord|undefined>{
  this.pending?.abort();const request=new AbortController();this.pending=request
  if(this.target.id&&businessReferenceTargetValid(this.target))this.publish({status:'loading'})
  const state=await readBusinessReference(this.api,this.target,request.signal)
  if(request.signal.aborted)return
  this.publish(state);return state.status==='ready'?state.record:undefined
 }
}
/** 固定源业务与字段声明类型；不接受第一页缺失即目标不存在的推断。 */
export async function readBusinessReferencePage(api:Pick<BusinessRecordApi,'list'>,scope:string,type:string,signal:AbortSignal,cursor?:string){
 const page=readBusinessRecordPage(await api.list({scope,type,limit:20,...(cursor?{cursor}:{})},signal),scope)
 if(page.items.some(record=>record.type!==type)||page.items.length>20||page.nextCursor!==undefined&&page.nextCursor===cursor)throw invalid()
 return {...page,items:page.items.map(record=>({scope:record.scope,type:record.type,id:record.id,version:record.version,snapshotHash:record.snapshotHash,title:record.title}))}
}
