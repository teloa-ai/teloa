import {WorkError,projectInput} from '@teloa/contract'
import type {ProjectService} from '@teloa/backend'
export const projectEndpoints=['projects/list','projects/get','projects/create','projects/edit','projects/candidates','projects/overview'] as const
export function createProjectHandler(owner:string,get:()=>Promise<Pick<ProjectService,'list'|'get'|'create'|'edit'|'candidates'|'overview'>>){
 return async(endpoint:string,payload:unknown)=>{
  const method=endpoint.slice('projects/'.length) as 'list'|'get'|'create'|'edit'|'candidates'|'overview'
  if(!(projectEndpoints as readonly string[]).includes(endpoint))throw new WorkError('teloa/not-found','未提供此项目接口。')
  const keys={list:['scope'],get:['projectId'],create:['requestId','fields'],edit:['projectId','expectedVersion','fields'],candidates:['scope','kind','query'],overview:['scope','state','cursor','limit']}
  projectInput(payload,keys[method]);return (await get())[method](owner,payload)
 }
}
