/** 超过 max（UTF-16 长度）时截断并以省略号结尾，不劈开代理对；用于平台对卡片字段的硬上限。 */
export function truncate(text:string,max:number):string{
 if(text.length<=max)return text
 let out=text.slice(0,max-1)
 if(/[\uD800-\uDBFF]$/.test(out))out=out.slice(0,-1)
 return out+'…'
}
