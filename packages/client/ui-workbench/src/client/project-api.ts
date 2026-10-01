import {projectDefinition,projectInput,projectOverviewInput,projectUuid,readProject,readProjectDetail,readProjectItem,readProjectOverviewPage,type ProjectDefinition,type ProjectLinkKind,type ProjectOverviewInput} from '@teloa/contract'
type Journal={read:()=>string|null;write:(value:string)=>void;clear:()=>void}
type Call=(endpoint:string,input:unknown)=>Promise<unknown>
export type ProjectApi=ReturnType<typeof createProjectApi>
const fieldsOf=(row:ProjectDefinition)=>projectDefinition({scope:row.scope,title:row.title,goal:row.goal,dueDate:row.dueDate,state:row.state,links:row.links,references:row.references})
export function createProjectApi(call:Call,journal?:Journal){
 let pending:{requestId:string;fields:ProjectDefinition}|undefined,busy=false,recoveryError:Error|undefined
 try{
  const raw=journal?.read()
  if(raw){const stored=projectInput(JSON.parse(raw),['requestId','fields']);if(!projectUuid(stored.requestId))throw Error();pending={requestId:stored.requestId,fields:projectDefinition(stored.fields)}}
 }catch{recoveryError=Error('项目创建恢复记录损坏，请先核对项目目录。')}
 const same=(a:ProjectDefinition,b:ProjectDefinition)=>JSON.stringify(fieldsOf(a))===JSON.stringify(fieldsOf(b))
 return {
  pendingFields:()=>pending?fieldsOf(pending.fields):undefined,
  recoveryError:()=>recoveryError,
  discard(){journal?.clear();pending=undefined;recoveryError=undefined},
  async list(scope:string){
   const result=await call('projects/list',{scope});if(!Array.isArray(result))throw Error('项目目录响应格式不正确。')
   const rows=result.map(readProject);if(rows.some(row=>row.scope!==scope)||new Set(rows.map(row=>row.id)).size!==rows.length)throw Error('项目目录响应不一致。')
   return rows
  },
  async overview(input:ProjectOverviewInput){
   const request=projectOverviewInput(input),result=readProjectOverviewPage(await call('projects/overview',request))
   if(result.rows.length>request.limit||(request.scope!==null&&result.rows.some(row=>row.scope!==request.scope))||(request.state==='current'?result.rows.some(row=>row.state==='archived'):request.state!==null&&result.rows.some(row=>row.state!==request.state)))throw Error('项目总览响应不一致。')
   return result
  },
  async get(projectId:string){const result=readProjectDetail(await call('projects/get',{projectId}));if(result.project.id!==projectId)throw Error('项目详情响应身份不一致。');return result},
  async candidates(scope:string,kind:ProjectLinkKind,query:string){
   const result=await call('projects/candidates',{scope,kind,query});if(!Array.isArray(result)||result.length>100)throw Error('项目候选响应格式不正确。')
   const rows=result.map(readProjectItem);if(rows.some(row=>row.kind!==kind||!row.available||row.origin!=='direct')||new Set(rows.map(row=>row.id)).size!==rows.length)throw Error('项目候选响应不一致。');return rows
  },
  async create(value:ProjectDefinition){
   if(recoveryError)throw recoveryError
   if(busy)throw Error('项目正在保存，请等待当前请求结束。')
   const fields=projectDefinition(value)
   if(pending&&!same(pending.fields,fields))throw Error('上次创建结果尚未核对，请先恢复或核对目录。')
   pending??={requestId:crypto.randomUUID(),fields};busy=true
   try{
    journal?.write(JSON.stringify(pending))
    const result=readProject(await call('projects/create',pending))
    if(!same(result,fields))throw Error('项目创建回包与请求不一致，请核对目录。')
    journal?.clear();pending=undefined;return result
   }finally{busy=false}
  },
  async recover(){if(!pending)throw Error('没有待恢复的项目创建。');return this.create(pending.fields)},
  async edit(projectId:string,expectedVersion:number,fields:ProjectDefinition){
   const normalized=projectDefinition(fields),result=readProject(await call('projects/edit',{projectId,expectedVersion,fields:normalized}))
   if(result.id!==projectId||result.version!==expectedVersion+1||!same(result,normalized))throw Error('项目编辑响应不一致，请刷新核对。')
   return result
  },
 }
}
