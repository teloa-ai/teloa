import type {MarketContentApi} from './market-content-api.ts'
import type {MarketItem} from './market-preview.ts'
import {mergeMarketItems} from './market-item-identity.ts'

/** 只补齐待核对请求的固定来源；不会恢复提交、读取其它内容正文或采用同哈希的另一声明。 */
export async function readPendingMarketContents(api:Pick<MarketContentApi,'list'>,contentIds:readonly string[],isCurrent:()=>boolean):Promise<MarketItem[]|undefined>{
 if(!contentIds.length||!isCurrent())return
 const rows=await api.list()
 if(!isCurrent())return
 const required=[...new Set(contentIds)],items=mergeMarketItems([],rows.filter(row=>row.contentStorage&&required.includes(row.contentStorage.contentId)))
 if(required.some(id=>!items.some(row=>row.contentStorage?.contentId===id)))throw Error('待核对请求的固定来源尚未读到，请重新读取。')
 return items
}
