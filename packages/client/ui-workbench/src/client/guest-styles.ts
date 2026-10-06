const styles=new Map<string,string>()

/** 浏览器产物在求值时登记 CSS；挂载时才带宿主 nonce 注入，避免认证文档的 CSP 失效。 */
export function registerGuestStyle(id:string,css:string):void{styles.set(id,css)}
export function installGuestStyles(document:Document,nonce?:string):void{
 for(const [id,css] of styles){
  let tag=Array.from(document.querySelectorAll<HTMLStyleElement>('style[data-teloa-guest-css]')).find(node=>node.dataset.teloaGuestCss===id)
  if(tag)continue
  tag=document.createElement('style')
  tag.dataset.teloaGuestCss=id
  if(nonce)tag.nonce=nonce
  tag.textContent=css
  document.head.appendChild(tag)
 }
}
