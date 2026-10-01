export const NATIVE_DETAIL_ATTRIBUTE='data-teloa-native-detail'
type AttributeHost=Pick<Element,'getAttribute'|'setAttribute'|'removeAttribute'>
type Owners={previous:string|null;leases:Map<symbol,boolean>;written:string}
const owners=new WeakMap<AttributeHost,Owners>()

/** 同一 body 的多个 root 隐藏优先；清理只释放当前租约，最后恢复原值。 */
export function leaseNativeFloatVisibility(body:AttributeHost|null|undefined,visible:boolean):()=>void{
 if(!body)return ()=>{}
 let held=owners.get(body)
 if(!held){held={previous:body.getAttribute(NATIVE_DETAIL_ATTRIBUTE),leases:new Map(),written:''};owners.set(body,held)}
 const owner=Symbol('native-detail'),entry=held
 const write=()=>{entry.written=[...entry.leases.values()].every(Boolean)?'visible':'hidden';body.setAttribute(NATIVE_DETAIL_ATTRIBUTE,entry.written)}
 entry.leases.set(owner,visible);write()
 return ()=>{
  if(owners.get(body)!==entry||!entry.leases.delete(owner))return
  if(entry.leases.size){write();return}
  owners.delete(body)
  // 不覆盖其它代码在本租约之后写入的属性。
  if(body.getAttribute(NATIVE_DETAIL_ATTRIBUTE)!==entry.written)return
  if(entry.previous===null)body.removeAttribute(NATIVE_DETAIL_ATTRIBUTE)
  else body.setAttribute(NATIVE_DETAIL_ATTRIBUTE,entry.previous)
 }
}
