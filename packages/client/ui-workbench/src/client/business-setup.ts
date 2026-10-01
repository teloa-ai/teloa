import type {BusinessResponsibility,DigitalRole} from '@teloa/contract'
import type {ManagedMcpConnectionRecord} from './mcp-connections-api.ts'

export type BusinessSetupAction={kind:'colleagues'}|{kind:'role';id:string}|{kind:'resources'}|{kind:'skills'}|{kind:'connections'}|{kind:'connection';catalogId:string}
export type BusinessSetupObservation<T>={status:'observed';value:T}|{status:'unavailable'}
export type BusinessSetupSnapshot={
 scope:string;configurationVersion:number;configurationHash:string;observedAt:string
 colleagues:BusinessSetupObservation<{responsibility:BusinessResponsibility;roles:DigitalRole[];selectedRole:DigitalRole|null}>
 skills:BusinessSetupObservation<{declared:{name:string;status:'observed'|'unobserved'|'ambiguous'}[];executionChecked:false}>
 knowledge:BusinessSetupObservation<{assigned:{id:string;title:string|null;version:number|null;state:'available'|'withdrawn'|'missing'|'out-of-scope'|'oversized'|'size-unknown'}[];businessResourceCount:number;generalResourceCount:number}>
 connections:BusinessSetupObservation<{items:Pick<ManagedMcpConnectionRecord,'id'|'catalogId'|'serverName'|'status'|'updatedAt'>[];binding:'not-declared'}>
}
export type BusinessSetupInput={scope:string;expectedVersion:number;expectedHash:string}
export type BusinessSetupApi={read(input:BusinessSetupInput,signal?:AbortSignal):Promise<BusinessSetupSnapshot>}
export type BusinessSetupState={status:'loading'|'ready'|'failed';value:BusinessSetupSnapshot|null}

export class BusinessSetupController{
 private readonly api:BusinessSetupApi
 private readonly input:BusinessSetupInput
 private state:BusinessSetupState={status:'loading',value:null}
 private readonly listeners=new Set<()=>void>()
 private abort:AbortController|undefined
 private generation=0
 private disposed=false
 constructor(api:BusinessSetupApi,input:BusinessSetupInput){this.api=api;this.input={...input}}
 getSnapshot():BusinessSetupState{return this.state}
 subscribe(listener:()=>void){if(!this.disposed)this.listeners.add(listener);return ()=>{this.listeners.delete(listener)}}
 private publish(state:BusinessSetupState){this.state=state;for(const listener of this.listeners){if(this.disposed)break;listener()}}
 async load():Promise<void>{
  if(this.disposed)return
  this.abort?.abort()
  const generation=++this.generation,abort=new AbortController();this.abort=abort
  this.publish({status:'loading',value:null})
  // 订阅回调也可能切换目标或开始下一轮读取。
  const current=()=>!this.disposed&&this.generation===generation&&!abort.signal.aborted
  if(!current())return
  try{
   const value=await this.api.read({...this.input},abort.signal)
   if(current())this.publish({status:'ready',value})
  }catch{if(current())this.publish({status:'failed',value:null})}
 }
 dispose():void{this.disposed=true;this.generation++;this.abort?.abort();this.listeners.clear()}
}
