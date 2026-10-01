import { changeTaskPreview, type TaskPreview } from './task-preview.ts'

export type IndustryTaskSource={loadId:string;resourceId:string;sourceHash:string;title:string;version:string;method:string;requirements:string[];inputs:string[];output:string;skills:{id:string;title:string;version:string}[]}
export type IndustryTaskCommand={id:string;loadId:string;resourceId:string;goal:string;inputs:string[];now:string}
export function createIndustryTask(state:TaskPreview,command:IndustryTaskCommand):TaskPreview{
 const load=state.industryLoads.find(row=>row.id===command.loadId)
 const resource=load?.resources.find(row=>row.id===command.resourceId)
 const definition=resource?.inspection.definition
 if(!load||!resource||!load.entrypoints.includes(resource.id)||definition?.kind!=='work-template')throw Error('工作入口不存在或尚未解析。')
 const template=definition.manifest
 if(command.inputs.length!==template.requirements.length||command.inputs.some(value=>typeof value!=='string'||!value.trim()||value.length>4000))throw Error('请补齐每项模板输入，每项不能超过4000字。')
 const next=changeTaskPreview(state,{type:'create',id:command.id,title:template.title,goal:command.goal,scope:load.spaceId,now:command.now})
 const source:IndustryTaskSource={loadId:load.id,resourceId:resource.id,sourceHash:load.sourceHash,title:template.title,version:template.version,method:template.description,requirements:[...template.requirements],inputs:command.inputs.map(value=>value.trim()),output:template.output,skills:template.skills.map(value=>({...value}))}
 return {...next,tasks:next.tasks.map(task=>task.id===command.id?{...task,industrySource:source,history:[...task.history,{text:'使用行业任务模板 '+template.title+' · '+template.version+'；技能声明不表示安装或已执行。',actorId:'self',at:command.now}]}:task)}
}
