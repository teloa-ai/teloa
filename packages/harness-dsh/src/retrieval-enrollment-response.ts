import {WorkError,readRetrievalEnrollmentSources,type RetrievalEnrollmentOutcome,type RetrievalEnrollmentReceipt} from '@teloa/contract'

type Ports={
 prepare:()=>Promise<(outcome:(value:RetrievalEnrollmentOutcome)=>void)=>Promise<void>>
 afterCommit:()=>void
 status:()=>Promise<object>
}
/** 正常 enroll handler 使用的结果边界；提交结果与后续状态读取分开，不生成虚假的持久请求身份。 */
export async function retrievalEnrollmentResponse(payload:unknown,ports:Ports):Promise<object>{
 const sourceIds=readRetrievalEnrollmentSources(payload)
 const state:{outcome:RetrievalEnrollmentOutcome}={outcome:'not-committed'}
 const receipt=(error?:unknown):RetrievalEnrollmentReceipt=>({outcome:state.outcome,sourceIds,...(error===undefined?{}:{errorCode:error instanceof WorkError?error.code:'teloa/storage-unavailable'})})
 try{
  const write=await ports.prepare()
  state.outcome='unknown'
  await write(value=>{state.outcome=value})
  state.outcome='committed'
 }catch(error){return {enrollment:receipt(error)}}
 try{
  ports.afterCommit()
  return {...await ports.status(),enrollment:receipt()}
 }catch(error){return {enrollment:receipt(error)}}
}
