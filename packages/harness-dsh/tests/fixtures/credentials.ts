import type {TestContext} from 'node:test'
import {mkdtemp,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import type {KeyringPort} from '../../src/credentials/key-sources.ts'
export function memoryKeyring(options:{failSet?:boolean;hang?:boolean;getDelayMs?:number;items?:Map<string,string>}={}){
 const items=options.items??new Map<string,string>()
 const wait=(signal:AbortSignal)=>new Promise<never>((_,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}))
 const port:KeyringPort={
  get:async(account,signal)=>{if(options.hang)return wait(signal);if(options.getDelayMs)await new Promise(done=>setTimeout(done,options.getDelayMs));return items.get(account)},
  set:async(account,value,signal)=>{if(options.hang)return wait(signal);if(options.failSet)throw Error('locked');items.set(account,value)},
  delete:async account=>items.delete(account),
 }
 return {items,port}
}
export async function tempHome(t:TestContext,prefix='teloa-cred-'):Promise<string>{
 const root=await mkdtemp(join(tmpdir(),prefix))
 t.after(()=>rm(root,{recursive:true,force:true}))
 return root
}
export const rand=(n:number)=>{let out='';while(out.length<n)out+=Math.random().toString(36).slice(2);return out.slice(0,n)}
