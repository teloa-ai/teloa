import {promptFullTextMaxBytes,type CapabilitySnapshot} from '@teloa/contract'
import type {BusinessBuilderApi} from './business-builder-api.ts'
import type {BusinessResponsibilityApi} from './business-responsibility-api.ts'
import type {RoleApi} from './role-api.ts'
import type {ResourceApi} from './resource-api.ts'
import type {ManagedMcpConnectionApi} from './mcp-connections-api.ts'
import type {BusinessSetupApi,BusinessSetupInput,BusinessSetupSnapshot} from './business-setup.ts'

export type BusinessSetupPorts={
 current:Pick<BusinessBuilderApi,'current'>
 responsibility:Pick<BusinessResponsibilityApi,'read'>
 roles:Pick<RoleApi,'list'>
 resources:Pick<ResourceApi,'directory'|'sources'>
 skills:(signal?:AbortSignal)=>Promise<CapabilitySnapshot['skills']>
 connections:Pick<ManagedMcpConnectionApi,'list'>
 isCurrent:()=>boolean
 now?:()=>string
}
export function createBusinessSetupApi(ports:BusinessSetupPorts):BusinessSetupApi{
 return {async read(input,signal){
  const target:BusinessSetupInput={...input}
  const guard=()=>{if(signal?.aborted||!ports.isCurrent())throw Error('Business setup identity changed or reading was cancelled.')}
  const configuration=async()=>{
   guard()
   const current=await ports.current.current({scope:target.scope},signal)
   guard()
   if(!current||current.scope!==target.scope||current.version!==target.expectedVersion||current.hash!==target.expectedHash)throw Error('Business setup configuration changed.')
  }
  await configuration()
  // 不同元数据组互不阻塞；同步抛错也归入该组的 unavailable。
  const read=<T>(action:()=>Promise<T>)=>Promise.resolve().then(()=>{guard();return action()})
  const [responsibility,roles,directory,sources,skills,connections]=await Promise.allSettled([
   read(()=>ports.responsibility.read({scope:target.scope})),read(()=>ports.roles.list()),
   read(()=>ports.resources.directory()),read(()=>ports.resources.sources()),
   read(()=>ports.skills(signal)),read(()=>ports.connections.list()),
  ])
  await configuration()
  const snapshot:BusinessSetupSnapshot={scope:target.scope,configurationVersion:target.expectedVersion,configurationHash:target.expectedHash,observedAt:ports.now?.()??new Date().toISOString(),colleagues:{status:'unavailable'},skills:{status:'unavailable'},knowledge:{status:'unavailable'},connections:{status:'unavailable'}}
  if(responsibility.status==='fulfilled'&&roles.status==='fulfilled'){
   const fixed=responsibility.value
   const relevant=roles.value.filter(role=>role.id===fixed.roleId||role.kind==='employee'&&role.scopes.includes(target.scope))
   const selectedRole=relevant.find(role=>role.id===fixed.roleId&&role.version===fixed.currentRoleVersion)??null
   snapshot.colleagues={status:'observed',value:{responsibility:fixed,roles:relevant,selectedRole}}
   if(skills.status==='fulfilled'&&(selectedRole||fixed.roleId===null)){
    const declared=(selectedRole?.skills??[]).map(name=>{
     const matches=skills.value.filter(skill=>skill.name===name)
     const status: 'observed'|'unobserved'|'ambiguous'=matches.length>1?'ambiguous':matches.length===1&&matches[0]!.modelInvocable?'observed':'unobserved'
     return {name,status}
    })
    snapshot.skills={status:'observed',value:{declared,executionChecked:false}}
   }
   if(directory.status==='fulfilled'&&sources.status==='fulfilled'&&(selectedRole||fixed.roleId===null)){
    const resources=directory.value.resources
    const assigned=(selectedRole?.knowledge??[]).map(id=>{
     const row=resources.find(resource=>resource.id===id)
     if(!row)return {id,title:null,version:null,state:'missing' as const}
     const source=sources.value.find(source=>source.id===row.sourceId&&source.version===row.sourceVersion)
     const state:'withdrawn'|'out-of-scope'|'size-unknown'|'oversized'|'available'=row.status==='withdrawn'?'withdrawn':!row.scopeIds.every(scope=>selectedRole!.scopes.includes(scope))?'out-of-scope':!source?'size-unknown':source.bytes>promptFullTextMaxBytes?'oversized':'available'
     return {id,title:row.title,version:row.version,state}
    })
    snapshot.knowledge={status:'observed',value:{assigned,businessResourceCount:resources.filter(row=>row.status==='active'&&row.scopeIds.includes(target.scope)).length,generalResourceCount:resources.filter(row=>row.status==='active'&&row.scopeIds.length===1&&row.scopeIds[0]==='general').length}}
   }
  }
  if(connections.status==='fulfilled')snapshot.connections={status:'observed',value:{items:connections.value.map(({id,catalogId,serverName,status,updatedAt})=>({id,catalogId,serverName,status,updatedAt})),binding:'not-declared'}}
  guard()
  return snapshot
 }}
}
