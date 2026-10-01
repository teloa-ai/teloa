export type PanelFocusTarget={focus:(options?:{preventScroll?:boolean})=>void;isConnected:boolean;getClientRects:()=>ArrayLike<unknown>;matches:(selector:string)=>boolean}
export type PanelFocusDocument={getElementById:(id:string)=>{focus:(options?:{preventScroll?:boolean})=>void}|null}

/** 非模态侧栏关闭后把焦点还给打开它的元素；那个元素已经不在场（移除、不可见或被禁用）时退回主工作区。 */
export function returnPanelFocus(opener:PanelFocusTarget|null,doc:PanelFocusDocument):void{
  if(opener&&opener.isConnected&&opener.getClientRects().length&&!opener.matches(':disabled')){opener.focus({preventScroll:true});return}
  doc.getElementById('teloa-main')?.focus({preventScroll:true})
}
