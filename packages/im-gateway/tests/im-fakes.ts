import {mkdtemp,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import type {CredentialRecord} from '@deepseek-ai/dsh-credentials/types'
import type {ImChannelKind} from '@teloa/contract'
import type {ChannelManagerDeps} from '../src/core/channel-manager.ts'
import type {ImChannelAdapter,ImInbound} from '../src/core/types.ts'

export async function withTemp(run:(dir:string)=>Promise<void>):Promise<void>{
 const root=await mkdtemp(join(tmpdir(),'teloa-im-manager-'))
 try{await run(root)}finally{await rm(root,{recursive:true,force:true})}
}

/** 假凭据服务：记录调用顺序与 readRecord 次数；writable 可切换。 */
export function fakeCredentials(options:{writable?:boolean}={}){
 const store=new Map<string,CredentialRecord>()
 const calls={read:0,order:[] as string[]}
 const credentials={
  async readRecord(key:string){calls.read+=1;return store.get(key)},
  async describeRecord(key:string){return {configured:store.has(key),...(store.has(key)?{kind:'api-key' as const}:{}),writable:options.writable??true}},
  async modifyRecord(key:string,mutate:(current:CredentialRecord|undefined)=>Promise<CredentialRecord|undefined>){
   calls.order.push('modifyRecord')
   const next=await mutate(store.get(key))
   if(next)store.set(key,next);else store.delete(key)
   return next
  },
  async deleteRecord(key:string){calls.order.push('deleteRecord');store.delete(key)},
 }
 return {store,calls,credentials:credentials as unknown as ChannelManagerDeps['credentials']}
}

/** 假渠道适配器：start 可抛错；handler 暴露给测试投递入站消息。 */
export function fakeAdapter(kind:ImChannelKind,options:{failStart?:boolean}={}){
 let connected=false
 const calls={start:0,stop:0}
 const state:{handler?:(m:ImInbound)=>Promise<void>}={}
 const adapter:ImChannelAdapter={
  id:kind,label:kind,
  capabilities:{text:true,card:false,button:false,thread:false,file:false,edit:false,maxMessageLength:4000,rateLimitPerMinute:20},
  async start(handler){calls.start+=1;state.handler=handler;if(options.failStart)throw new Error('连接失败 xoxb-TEST-SECRET');connected=true},
  async stop(){calls.stop+=1;connected=false},
  async send(){return {messageId:'1'}},
  status(){return {connected}},
 }
 return {adapter,calls,state}
}

export const silentLog={info(){},warn(){}}
