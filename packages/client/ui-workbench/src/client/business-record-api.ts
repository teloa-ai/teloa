import {readBusinessRecordCreate,readBusinessRecordEdit,readBusinessRecordArchive,readBusinessRecordList,readBusinessRecordGet,readBusinessRecordReceipt,readBusinessRecordSnapshot,readBusinessRecordPage,type BusinessRecordCreate,type BusinessRecordEdit,type BusinessRecordArchive,type BusinessRecordList,type BusinessRecordGet,type BusinessObjectSnapshot} from '@teloa/contract'
type Call=(method:string,input:unknown,signal?:AbortSignal)=>Promise<unknown>
const invalid=()=>Object.assign(Error('记录回包与请求不一致。'),{code:'teloa/invalid-host-response'})
function target(value:unknown,input:{scope:string;type:string;id?:string;version?:number}):BusinessObjectSnapshot{
 const result=readBusinessRecordSnapshot(value,input.scope)
 if(result.type!==input.type||(input.id!==undefined&&result.id!==input.id)||(input.version!==undefined&&result.version!==input.version))throw invalid()
 return result
}
export function createBusinessRecordApi(call:Call){
 return {
  async create(input:BusinessRecordCreate,signal?:AbortSignal){
   const data=readBusinessRecordCreate(input),result=target(await call('business-records/create',data,signal),{...data,version:1})
   if(result.deletedAt||result.title!==data.title||result.summary!==data.summary)throw invalid();return result
  },
  async edit(input:BusinessRecordEdit,signal?:AbortSignal){
   const data=readBusinessRecordEdit(input),result=target(await call('business-records/edit',data,signal),{...data,version:data.expectedVersion+1})
   if(result.deletedAt||(data.title!==undefined&&result.title!==data.title)||(data.summary!==undefined&&result.summary!==data.summary))throw invalid();return result
  },
  async archive(input:BusinessRecordArchive,signal?:AbortSignal){
   const data=readBusinessRecordArchive(input),result=target(await call('business-records/archive',data,signal),{...data,version:data.expectedVersion+1})
   if(!result.deletedAt)throw invalid();return result
  },
  async get(input:BusinessRecordGet,signal?:AbortSignal){
   const data=readBusinessRecordGet(input);return target(await call('business-records/get',data,signal),data)
  },
  async list(input:BusinessRecordList,signal?:AbortSignal){
   const data=readBusinessRecordList(input),page=readBusinessRecordPage(await call('business-records/list',data,signal),data.scope)
   if(page.items.some(item=>item.type!==data.type||item.deletedAt))throw invalid();return page
  },
  async receipt(input:{requestId:string},signal?:AbortSignal){
   const data=readBusinessRecordReceipt(input),result=await call('business-records/receipt',data,signal)
   return result===null?null:readBusinessRecordSnapshot(result)
  },
 }
}
export type BusinessRecordApi=ReturnType<typeof createBusinessRecordApi>
