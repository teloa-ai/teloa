import { fileURLToPath } from 'node:url'
import { ReferenceCatalog } from './catalog.ts'
export function createPublicReferenceCatalog():ReferenceCatalog {
  return new ReferenceCatalog(fileURLToPath(new URL('../materials/',import.meta.url)),[
    {id:'workbench',title:'工作台与业务',file:'工作台与业务.md'},
    {id:'capabilities',title:'技能与连接',file:'技能与连接.md'},
  ])
}
