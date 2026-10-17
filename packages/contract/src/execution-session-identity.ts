/** 编排器保留的执行身份；只用于普通会话接入分类，不替代归属或执行权限核验。 */
export function isReservedExecutionSessionId(id:string):boolean{
 return /^(?:task-run|group-routing)-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)
}
