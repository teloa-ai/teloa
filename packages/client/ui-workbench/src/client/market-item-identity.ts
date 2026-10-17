import type {MarketItem} from './market-preview.ts'

/** 固定内容的页面身份与文件哈希分开；相同字节可以有不同署名、许可和审核声明。 */
export const fixedMarketItemId=(contentId:string)=>'stored-'+contentId
export const marketItemId=(item:MarketItem)=>item.contentStorage?fixedMarketItemId(item.contentStorage.contentId):item.id

/** 旧导航与公共引用仍使用原哈希标识，不把页面身份写进固定来源合同。 */
export function canonicalMarketItemId(item:MarketItem):string{
 if(item.atomicSkill)return 'atomic-'+item.atomicSkill.hash
 if(item.packageContent)return 'directory-'+item.packageContent.hash
 if(item.contentStorage&&!item.contentStorage.loaded&&item.hash)return (item.kind==='skill'?'atomic-':'directory-')+item.hash
 return item.id
}
export function sameMarketItem(left:MarketItem,right:MarketItem):boolean{
 const a=left.contentStorage?.contentId,b=right.contentStorage?.contentId
 return a!==undefined||b!==undefined?a!==undefined&&b!==undefined&&a===b:left.id===right.id
}
const contentHash=(item:MarketItem)=>item.atomicSkill?.hash??item.packageContent?.hash??(item.contentStorage?.loaded===false?item.hash:undefined)
const stableDeclaration=(value:unknown):string=>JSON.stringify(value===undefined?null:value,(_key,row)=>row&&typeof row==='object'&&!Array.isArray(row)?Object.fromEntries(Object.entries(row).sort(([a],[b])=>a.localeCompare(b))):row)
function checkFixedContent(left:MarketItem,right:MarketItem):void{
 if(!left.contentStorage||!right.contentStorage)return
 const a=contentHash(left),b=contentHash(right)
 if(left.kind!==right.kind||left.version!==right.version||a!==undefined&&b!==undefined&&a!==b||stableDeclaration(left.trust)!==stableDeclaration(right.trust))throw Error('固定内容的类型、版本、摘要或声明不一致，请重新读取。')
}
export function mergeMarketItems(current:readonly MarketItem[],incoming:readonly MarketItem[]):MarketItem[]{
 const result:MarketItem[]=[]
 for(const row of [...current,...incoming]){
  const item=marketItemId(row)===row.id?row:{...row,id:marketItemId(row)},index=result.findIndex(value=>sameMarketItem(value,item))
  if(index<0)result.push(item)
  else {checkFixedContent(result[index]!,item);if(!result[index]!.contentStorage?.loaded||item.contentStorage?.loaded)result[index]=item}
 }
 return result
}
export function matchingMarketItems(items:readonly MarketItem[],id:string|undefined|null):MarketItem[]{
 if(!id)return []
 // 明确的固定身份只按该身份查找；不能借旧哈希别名换成另一声明。
 if(id.startsWith('stored-'))return items.filter(item=>marketItemId(item)===id)
 return items.filter(item=>item.id===id||canonicalMarketItemId(item)===id)
}
export function findMarketItem(items:readonly MarketItem[],id:string|undefined|null):MarketItem|undefined{
 const matches=matchingMarketItems(items,id)
 return matches.length===1?matches[0]:undefined
}
/** 旧别名即使有歧义也保留入口，页面会让本人选择来源，不清掉原导航或草稿。 */
export const marketItemNavigationIds=(items:readonly MarketItem[])=>[...new Set(items.flatMap(item=>[marketItemId(item),canonicalMarketItemId(item)]))]
