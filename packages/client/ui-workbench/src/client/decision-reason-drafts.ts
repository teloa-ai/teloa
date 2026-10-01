/** 只保留当前页面会话的审核意见；影响确认不入草稿，固定版本变化使用新键。 */
const drafts=new Map<string,string>()
export const readDecisionReason=(key:string)=>drafts.get(key)??''
export function writeDecisionReason(key:string,value:string):void{
 drafts.delete(key)
 if(value)drafts.set(key,value.slice(0,4000))
 if(drafts.size>50)drafts.delete(drafts.keys().next().value!)
}
