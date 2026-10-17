import type {CollaborationScope} from './collaboration-preview.js'

export function homeTaskScope(scopeId:string,scopeNames:Readonly<Record<string,string>>):CollaborationScope{
  if(!Object.hasOwn(scopeNames,scopeId))throw Error('工作范围无效。')
  return scopeId as CollaborationScope
}

/** 只拟定可编辑名称，不解析业务、负责人或授权。 */
export function homeTaskTitle(input:string){
  const goal=input.trim()
  return (goal.split(/\r?\n/).find(line=>line.trim())??goal).trim().slice(0,60)
}

export function homeTaskDraft(input:string,scopeId:string,scopeNames:Readonly<Record<string,string>>){
  const goal=input.trim(),scope=homeTaskScope(scopeId,scopeNames)
  if(!goal)throw Error('工作目标不能为空。')
  const title=homeTaskTitle(goal)
  return {title,goal,scope}
}

export function homeConversationPrompt(input:string,scopeId:string,scopeNames:Readonly<Record<string,string>>){
  const goal=input.trim(),scope=homeTaskScope(scopeId,scopeNames)
  if(!goal)throw Error('工作目标不能为空。')
  if(scope==='general')return goal
  return `业务上下文：${scopeNames[scope]}（${scope}）\n资料和工具仍按当前会话重新核验。\n\n${goal}`
}
