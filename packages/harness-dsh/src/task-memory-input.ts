function taskInput(text:string):{value:Record<string,unknown>;suffix:string}|null{
 try{
  // 真实图片任务把未纳入数量追加在固定 JSON 后；只识别宿主的完整固定后缀。
  const suffix=text.match(/\n\n本轮还有 [1-9][0-9]* 张已授权图片未进模型。$/)?.[0]??''
  const value=JSON.parse(suffix?text.slice(0,-suffix.length):text)
  if(!value||typeof value!=='object'||Array.isArray(value)||!value.task||typeof value.task!=='object'||!value.role||typeof value.role!=='object'||typeof value.task.goal!=='string')return null
  return {value,suffix}
 }catch{return null}
}

/** 保留固定任务和知识；当前员工记忆由 prompt 接缝重新核验，Run 审计快照不改写。 */
export function taskInputWithoutMemory(text:string):string{
 const parsed=taskInput(text)
 if(!parsed||!Object.hasOwn(parsed.value,'memory'))return text
 const {memory:_,...retained}=parsed.value
 return JSON.stringify(retained)+parsed.suffix
}

/** 当前任务查询不携带准备阶段冻结的知识、记忆或工具授权正文。 */
export function taskMessageQuery(texts:readonly string[]):string{
 for(const text of texts){
  const parsed=taskInput(text)
  if(parsed){const task=parsed.value.task as {title?:string;goal:string};return [task.title,task.goal].filter(item=>typeof item==='string').join('\n').slice(0,8000)}
 }
 return texts.join('\n').slice(0,8000)
}
