import {WorkError} from '@teloa/contract'
import type {HomeContextApi} from './home-native-controller.js'
import type {ProjectApi} from './project-api.js'
import type {ProjectConversationCreation} from './project-runtime-api.js'
import type {PromptPreparation} from './prompt-preparation.js'
import {homeConversationPrompt} from './home-work-mode.ts'

const conflict=()=>new WorkError('teloa/conflict','项目归属、版本或状态已变化，请核对后重新准备。')
async function checkProject(api:Pick<ProjectApi,'get'>,creation:ProjectConversationCreation,scope:string){
 const {project}=await api.get(creation.projectId),work=creation.preparation
 if(project.id!==creation.projectId||project.state==='archived'||project.scope!==scope||work&&(work.scope!==scope||project.version!==work.projectVersion))throw conflict()
}

/** 首次输入只在原业务与项目归属均确认后开放；未知回执沿原请求恢复。 */
export async function prepareProjectConversation({api,home,creation,sessionId,scope,mayContinue=()=>true}:{api:Pick<ProjectApi,'get'|'runtime'>;home:Pick<HomeContextApi,'read'|'set'>;creation:ProjectConversationCreation;sessionId:string;scope:string;mayContinue?:()=>boolean}){
 const runtime=api.runtime
 if(!runtime)throw new WorkError('teloa/dependency-unavailable','项目上下文暂不可用，请重试。')
 const current=()=>{if(!mayContinue())throw conflict()}
 current();await checkProject(api,creation,scope);current()
 const existing=await home.read(sessionId)
 current()
 if(existing){if(existing.scopeId!==scope||existing.roleId!==null)throw new WorkError('teloa/conflict','会话业务设置已变化，请核对后继续。')}
 else await home.set({sessionId,scopeId:scope,roleId:null,expectedVersion:0})
 current()
 const bound=(await runtime.members(creation.projectId)).find(value=>value.sessionId===sessionId)
 current()
 if(bound){
  if(bound.memoryMode!==creation.memoryMode)throw new WorkError('teloa/conflict','会话记忆模式与原预约不一致。')
  if(runtime.pending(creation.projectId)?.endpoint==='bind')await runtime.recover(creation.projectId)
 }else await runtime.bind({sessionId,projectId:creation.projectId,expectedVersion:0,memoryMode:creation.memoryMode})
 current()
}

/** 只准备原文，不发送；同一预约恢复时不覆盖已处理的输入或另造准备记录。 */
export async function offerProjectConversationWork({api,preparation,creation,sessionId,scope,scopeNames,mayContinue=()=>true}:{api:Pick<ProjectApi,'get'>;preparation:PromptPreparation;creation:ProjectConversationCreation;sessionId:string;scope:string;scopeNames:Readonly<Record<string,string>>;mayContinue?:()=>boolean}){
 const work=creation.preparation
 if(!work)return true
 if(!mayContinue())return false
 await checkProject(api,creation,scope)
 if(!mayContinue())return false
 const row={id:'project-conversation:'+creation.requestId,sourceId:'project:'+creation.projectId,sourceKind:'home' as const,sourceVersion:work.projectVersion,sessionId,title:creation.title,text:homeConversationPrompt(work.text,scope,scopeNames)}
 const existing=preparation.getSnapshot().find(value=>value.id===row.id)
 if(existing){if(existing.sessionId!==row.sessionId||existing.sourceId!==row.sourceId||existing.sourceVersion!==row.sourceVersion||existing.title!==row.title||existing.text!==row.text)throw conflict()}
 else preparation.prepare(row)
 return true
}
