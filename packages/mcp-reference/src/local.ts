import { fileURLToPath } from 'node:url'
import { ReferenceCatalog } from './catalog.ts'
const publicReferences=[
  {id:'workbench',title:'工作台与业务',file:'工作台与业务.md'},
  {id:'capabilities',title:'技能与连接',file:'技能与连接.md'},
] as const
/** 与实际公共MCP目录共用声明；私有资料由Run正文与授权检索提供，不能冒充此服务来源。 */
export const isPublicReferenceSourceId=(id:string):boolean=>publicReferences.some(reference=>reference.id===id)
export function createPublicReferenceCatalog():ReferenceCatalog {
  return new ReferenceCatalog(fileURLToPath(new URL('../materials/',import.meta.url)),publicReferences)
}
