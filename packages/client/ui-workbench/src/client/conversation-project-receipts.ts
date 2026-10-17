import {isRecord,readProject,projectUuid} from '@teloa/contract'

export const conversationProjectToolNames=['teloa_projects_create','teloa_projects_change'] as const
export type ConversationProjectReceipt={kind:'project';id:string;title:string;revision:string;scope:string}
/** 入口只来自原会话的真实成功工具回执；技术身份用于导航，展示使用项目标题。 */
export function conversationProjectReceipt(value:unknown,sessionId?:string):ConversationProjectReceipt|undefined{
 try{
  if(!isRecord(value)||value.schema!=='teloa.project-result/v1'||typeof value.sessionId!=='string'||!value.sessionId||sessionId!==undefined&&value.sessionId!==sessionId||!(conversationProjectToolNames as readonly unknown[]).includes(value.operation))return
  const project=readProject(value.project)
  if(project.ownerId!=='local:teloa-owner'||value.projectId!==project.id||value.projectVersion!==project.version||value.projectTitle!==project.title||value.scope!==project.scope)return
  if(value.operation==='teloa_projects_create'&&(!projectUuid(value.requestId)||project.version!==1||project.state!=='planning'))return
  return {kind:'project',id:project.id,title:project.title,revision:project.version+':'+project.updatedAt+':'+project.state,scope:project.scope}
 }catch{/* 损坏或未核验回执保留原生工具详情，不产生原页面入口。 */}
}
