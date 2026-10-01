import type {ReactNode} from 'react'

/** root 保留 main 的唯一渲染权；设置只接收它授权的渲染回调，不重复声明官方子 slot。 */
export function createRuntimeSettingsSurface(){
 let render:(()=>ReactNode)|undefined
 const listeners=new Set<()=>void>()
 const notify=()=>{for(const listener of [...listeners])listener()}
 return {
  getSnapshot:()=>render,
  subscribe:(listener:()=>void)=>{listeners.add(listener);return ()=>{listeners.delete(listener)}},
  attach(next:()=>ReactNode){
   render=next;notify()
   return ()=>{if(render!==next)return;render=undefined;notify()}
  },
 }
}
export type RuntimeSettingsSurface=ReturnType<typeof createRuntimeSettingsSurface>
