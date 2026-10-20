import {projectDefinition,type ProjectDefinition,type ProjectItem,type ProjectReference,type ProjectSummary,type WorkProject} from '@teloa/contract'
import type {BusinessScopeLabel} from './business-directory.js'
export function projectFields(project:ProjectDefinition,patch:Partial<ProjectDefinition>={}):ProjectDefinition{return projectDefinition({scope:project.scope,title:project.title,goal:project.goal,dueDate:project.dueDate,state:project.state,links:project.links,references:project.references,...patch})}
export function filterProjects(rows:readonly WorkProject[],query:string,archived:boolean){const q=query.trim().toLocaleLowerCase();return rows.filter(row=>(row.state==='archived')===archived&&(!q||(row.title+' '+row.goal).toLocaleLowerCase().includes(q)))}
export function projectProgress(summary:ProjectSummary){const total=summary.totalTasks-summary.cancelledTasks;return {completed:summary.completedTasks,total,percent:total?Math.round(summary.completedTasks/total*100):null}}
export function removeProjectLink(project:WorkProject,item:ProjectItem):ProjectDefinition{
 if(item.origin!=='direct')throw Error('自动汇入的内容请从来源调整。')
 return projectFields(project,{links:project.links.filter(link=>link.kind!==item.kind||link.id!==item.id)})
}
export function removeProjectReference(project:WorkProject,ref:ProjectReference):ProjectDefinition{
 return projectFields(project,{references:project.references.filter(item=>item.scope!==ref.scope||item.kind!==ref.kind||item.id!==ref.id)})
}
/** 引用条目上的业务名：先用本地化名称（回退函数），再用标签原标题，都没有就显示 scope 码。 */
export function referenceScopeName(ref:{scope:string},labels:readonly BusinessScopeLabel[],fallback:(scope:string)=>string):string{
 const localized=fallback(ref.scope);if(localized!==ref.scope)return localized
 return labels.find(label=>label.scope===ref.scope)?.title??ref.scope
}
export const projectStateKeys={planning:'project.state.planning',running:'project.state.running',review:'project.state.review',completed:'project.state.completed',archived:'project.state.archived'} as const
export const projectKindKeys={task:'project.kind.task',group:'project.groups',role:'project.kind.role',plan:'project.plans',resource:'project.resources',artifact:'project.artifacts'} as const
export const projectItemStateKeys={ready:'status.ready',running:'project.state.running',paused:'composition.state.paused',waiting:'attention.review',blocked:'status.blocked',completed:'project.state.completed',cancelled:'status.cancelled',active:'project.item.active',saved:'project.item.saved',archived:'project.state.archived',retired:'project.item.unavailable',withdrawn:'project.item.unavailable'} as const
/** 卡片与详情的目标摘要：新建时首行常是与名称相同的 Markdown 标题，去掉后只留正文；其余标题记号也去掉。 */
export function projectGoalText(project:Pick<ProjectDefinition,'title'|'goal'>){
 const lines=project.goal.split(/\r?\n/).map(line=>line.replace(/^#{1,6}\s+/,'').trim()).filter(Boolean)
 if(lines[0]===project.title.trim())lines.shift()
 return lines.join('\n')
}
const copy={overviewLead:['跨业务查看所有项目','跨業務查看所有專案','Projects across all businesses'],count:['{count} 个','{count} 個','{count}'],created:['创建于 {date}','建立於 {date}','Created {date}'],related:['关联','關聯','Related']} as const
export function projectCopy(locale:string,key:keyof typeof copy){return copy[key][locale.startsWith('zh')?(/Hant|TW|HK/i.test(locale)?1:0):2]}
