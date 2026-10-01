import {readBundledExtensionView,type BundledExtensionId,type BundledExtensionView} from '@teloa/contract'

type Call=(endpoint:string,payload:unknown)=>Promise<unknown>
export type BundledExtensionsApi=ReturnType<typeof createBundledExtensionsApi>
/** 启停幂等（布尔目标态），不登记待恢复请求。 */
export function createBundledExtensionsApi(call:Call){
 return {
  async list():Promise<BundledExtensionView[]>{
   const rows=await call('bundled-extensions/list',{})
   if(!Array.isArray(rows))throw Error('官方扩展响应格式不正确。')
   return rows.map(readBundledExtensionView)
  },
  async set(extensionId:BundledExtensionId,enabled:boolean):Promise<BundledExtensionView>{
   return readBundledExtensionView(await call('bundled-extensions/set',{extensionId,enabled}))
  },
 }
}
