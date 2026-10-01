import type { PreviewTask, TaskPreview } from './task-preview.ts'
import type { PlanRun } from './continuous-preview.ts'
import type { ArtifactSource, ArtifactSourceRef } from './artifact-preview.ts'
export type ArtifactConversation={id:string;title:string;scope:string;bindingId:string}
export function taskArtifactSource(task:PreviewTask):ArtifactSource{return {ref:{kind:'task',id:task.id},title:task.title,scope:task.scope,version:`${task.version} · ${task.updatedAt}`,author:task.assigneeId,evidence:[...task.evidence],private:false}}
export function runArtifactSource(run:PlanRun):ArtifactSource{return {ref:{kind:'run',id:run.id},title:run.snapshot.fields.title,scope:run.snapshot.fields.scope,version:String(run.revision),author:run.actor.name,evidence:[run.input,'计划配置 v'+run.snapshot.version,...(run.snapshot.template?['模板 '+run.snapshot.template.templateId+' · '+run.snapshot.template.version]:[])],private:false}}
export function resolveArtifactSource(state:TaskPreview,ref:ArtifactSourceRef,conversation?:ArtifactConversation):ArtifactSource{
  if(ref.kind==='task'){const task=state.tasks.find(item=>item.id===ref.id);if(task)return taskArtifactSource(task)}
  if(ref.kind==='run'){const run=state.continuous.runs.find(item=>item.id===ref.id);if(run)return runArtifactSource(run)}
  if(ref.kind==='session'&&conversation?.id===ref.id)return {ref,title:conversation.title,scope:conversation.scope,version:conversation.bindingId,author:'本人会话',evidence:[],private:true}
  if(ref.kind==='analysis'){const run=state.business.runs.find(item=>item.id===ref.id&&item.scope===ref.scope);if(run)return {ref,title:run.title,scope:run.scope,version:run.batchId+' · '+run.createdAt,author:'业务分析记录',evidence:run.inputs.map(input=>`${input.type} · ${input.id} · v${input.version}`),private:false}}
  if(ref.kind==='object'){const item=state.business.objects.find(item=>item.id===ref.id&&item.scope===ref.scope&&item.type===ref.objectType);if(item)return {ref,title:item.title,scope:item.scope,version:String(item.version),author:'业务来源',evidence:[],private:false}}
  throw Error('来源不存在或当前会话绑定未就绪，请返回原工作核对。')
}
/**
 * 成果目录要不要向服务端拉、拉哪一份——返回值同时充当拉取 effect 的依赖键。
 *
 * 刷新后 `state.detail` 这颗种子与页面同步恢复，任务台账却是异步装载的：首屏判不出
 * 这份来源是持久任务，拉取只能先跳过。来源身份从头到尾没变过，所以键必须把「台账已
 * 认出它是持久任务」一起算进去，台账到位时键才会变、effect 才会补拉，面板也才回填。
 */
export function artifactListFetchKey(target:{source:ArtifactSourceRef}|null,tasks:readonly PreviewTask[]):string{
  const source=target?.source
  if(source?.kind==='session')return 'session '+source.id
  if(source?.kind==='task'&&tasks.some(task=>task.id===source.id&&task.storage==='persistent'))return 'task '+source.id
  return ''
}
