import { createArtifact, changeArtifact, sourceKey, sourceStamp, type ArtifactChange, type ArtifactRef, type ArtifactSourceRef } from './artifact-preview.ts'
import { resolveArtifactSource, type ArtifactConversation } from './artifact-source.ts'
import { changeTaskPreview, type TaskPreview } from './task-preview.ts'
import type { CollaborationScope } from './collaboration-preview.ts'
import type { ArtifactMessage } from './artifact-native.ts'
import type { ArtifactFile } from './artifact-files.ts'
export type ArtifactWorkChange=
  |{type:'create';id:string;source:ArtifactSourceRef;expectedSource:string;title:string;body:string;now:string;messages?:ArtifactMessage[];files?:ArtifactFile[]}
  |{type:'change';id:string;expectedSource:string;change:ArtifactChange}
  |{type:'follow';id:string;artifact:ArtifactRef;goal:string;now:string}
  |{type:'review';artifact:ArtifactRef;expectedTaskVersion:number;now:string}
  |{type:'link';artifact:ArtifactRef;object:Extract<ArtifactSourceRef,{kind:'object'}>;now:string}
export function changeArtifactWork(state:TaskPreview,command:ArtifactWorkChange,conversation?:ArtifactConversation):TaskPreview{
  if(command.type==='create'){
    const source=resolveArtifactSource(state,command.source,conversation)
    if(sourceStamp(source)!==command.expectedSource)throw Error('来源已变化，请核对当前来源后保留草稿继续。')
    if(command.id.startsWith('task-result:')||command.id.startsWith('run-result:')||state.artifacts.some(item=>item.id===command.id))throw Error('产物编号冲突。')
    if(command.body.length>16000)throw Error('工作成果不能超过 16000 字。')
    const artifact=createArtifact({id:command.id,source,title:command.title,sections:(command.body.trim()||(command.files?.length?'文件快照：'+command.files.map(file=>file.path).join('、'):'')).split(/\n\s*\n/).map((body,index)=>({id:'section-'+(index+1),title:'段落 '+(index+1),text:body})),note:command.messages?.length?'本人整理工作成果；保留明确选取的原消息与图片身份':'本人整理工作成果；未自动提取历史',now:command.now,...(command.messages?{messages:command.messages}:{}),...(command.files?{files:command.files}:{})})
    return {...state,artifacts:[...state.artifacts,artifact]}
  }
  const artifact=state.artifacts.find(item=>item.id===(command.type==='change'?command.id:command.artifact.id))
  if(!artifact)throw Error('产物不存在。')
  if(command.type==='change'){
    const change=command.change
    // 旧来源不可用仍可对历史版本反馈；修订必须重新核对来源。
    const source=change.type==='feedback'?artifact.versions.find(item=>item.number===change.version)?.source:resolveArtifactSource(state,artifact.source,conversation)
    if(!source)throw Error('产物版本不存在。')
    if(change.type!=='feedback'){
      if(sourceStamp(source)!==command.expectedSource)throw Error('来源已变化，请核对后继续修改。')
      if(artifact.source.kind==='task'){
        const task=state.tasks.find(item=>item.id===artifact.source.id)
        if(task&&['completed','cancelled'].includes(task.state))throw Error('原任务已结束，请创建跟进任务保留原稿。')
      }
    }
    const next=changeArtifact(artifact,change,source)
    return {...state,artifacts:state.artifacts.map(item=>item.id===next.id?next:item)}
  }
  const version=artifact.versions.find(item=>item.number===command.artifact.version)
  if(!version)throw Error('产物版本不存在。')
  if(!Number.isFinite(Date.parse(command.now)))throw Error('时间无效。')
  if(command.type==='link'){
    const object=resolveArtifactSource(state,command.object)
    if(version.source.private||object.scope!==version.source.scope)throw Error('仅能关联同业务范围的非私人来源稿件；关联不授予共享权限。')
    if(artifact.links.some(link=>sourceKey(link.object)===sourceKey(command.object)&&link.artifactVersion===version.number))return state
    return {...state,artifacts:state.artifacts.map(item=>item.id===artifact.id?{...item,links:[...item.links,{object:structuredClone(command.object),objectVersion:object.version,artifactVersion:version.number,at:command.now}]}:item)}
  }
  if(artifact.source.kind!=='task')throw Error('请从原任务产物创建跟进任务。')
  const task=state.tasks.find(item=>item.id===artifact.source.id)
  if(!task)throw Error('原任务不存在。')
  if(command.type==='review'){
    if(!task.approvalRequired||['completed','cancelled'].includes(task.state))throw Error('当前任务不能添加审批稿件。')
    if(task.version!==command.expectedTaskVersion)throw Error('任务版本已变化，请重新核对。')
    if(task.reviewArtifact?.id===artifact.id&&task.reviewArtifact.version===version.number)return state
    return {...state,tasks:state.tasks.map(item=>item.id===task.id?{...item,reviewArtifact:{...command.artifact},version:item.version+1,updatedAt:command.now,need:'approval',state:'waiting',history:[...item.history,{text:'选择审批稿件 '+artifact.id+' · v'+version.number+'；等待重新提交，尚未批准。',actorId:'self',at:command.now}]}:item),approvals:state.approvals.map(item=>item.taskId===task.id&&item.status==='pending'?{...item,status:'stale',version:item.version+1}:item)}
  }
  const next=changeTaskPreview(state,{type:'create',id:command.id,title:'跟进：'+version.title.slice(0,110),goal:command.goal,scope:version.source.scope as CollaborationScope,now:command.now})
  return {...next,tasks:next.tasks.map(item=>item.id===command.id?{...item,sourceTaskId:task.id,artifactSource:{...command.artifact},evidence:[...item.evidence,'来源产物 '+artifact.id+' · v'+version.number]}:item)}
}
