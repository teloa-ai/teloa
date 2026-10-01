import {WorkError,promptSecretMessage,secretKindsIn,type SecretKind} from '@teloa/contract'
import {knownSecretValues} from './credentials/known-values.ts'

/** 提交前密钥闸（等价 UserPromptSubmit）：只拒不改；检测本身出错按拒收，kinds 为空。 */
export type SecretGateVerdict={ok:true}|{ok:false;kinds:SecretKind[]}
export function checkPromptSecrets(texts:readonly string[],known:()=>readonly string[]):SecretGateVerdict{
 try{const kinds=secretKindsIn(texts,known());return kinds.length?{ok:false,kinds}:{ok:true}}
 catch{return {ok:false,kinds:[]}}
}

/**
 * 闸用的已存值来源。没有 Teloa 凭据提供方时只跳过已存值比对（形态检测照常），整个来源只警告一次；
 * 提供方在但读取出错（如锁定）照常抛出，由闸按拒收处理。
 */
export function storedSecretSource(provider:()=>unknown,warn:(message:string)=>void):()=>readonly string[]{
 let warned=false
 return ()=>{
  const current=provider()
  if(typeof (current as {secretValues?:unknown}|null|undefined)?.secretValues!=='function'){
   if(!warned){warned=true;warn('凭据提供方不可用，贴密钥检查只按形态，跳过已存值比对')}
   return []
  }
  return knownSecretValues(current)
 }
}

/** 群聊闸（规格 §6）：命中抛 teloa/invalid-input，details 只带原因与形态类别，不带值或片段。 */
export function groupMessageSecretGate(known:()=>readonly string[]):(text:string)=>void{
 return text=>{
  const verdict=checkPromptSecrets([text],known)
  if(!verdict.ok)throw new WorkError('teloa/invalid-input',promptSecretMessage(verdict.kinds),{reason:'secret-in-message',kinds:verdict.kinds})
 }
}
