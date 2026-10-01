export type WebAccessDraft={enabled:boolean;blocked:string[];input:string}

/**
 * 设置壳只渲染当前选中的一节，切走即卸载（教训 c）：上网设置节的未保存草稿若挂在组件
 * useState 上，切到别的设置节再切回来就会丢。这里搬到跨挂载存活的模块级单例，
 * 形状仿 savedCollaborationDrafts（saved-collaboration-drafts.ts:47）。
 */
export function createWebAccessDraftStore(){
 let draft:WebAccessDraft|undefined
 const listeners=new Set<()=>void>()
 const publish=():void=>{for(const listener of listeners)listener()}
 return {
  read:():WebAccessDraft|undefined=>draft,
  write:(next:WebAccessDraft):void=>{draft=next;publish()},
  clear:():void=>{draft=undefined;publish()},
  subscribe:(listener:()=>void):(()=>void)=>{listeners.add(listener);return ()=>{listeners.delete(listener)}},
  getSnapshot:():WebAccessDraft|undefined=>draft,
 }
}

/** 全应用单例：见上方注释。 */
export const webAccessDrafts=createWebAccessDraftStore()
