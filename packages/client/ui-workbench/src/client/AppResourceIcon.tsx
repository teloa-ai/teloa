import type {AppsRow} from './market-apps-presentation.js'
import {ResourceIcon,resourceBrand} from './ResourceIcon.js'
import type {ResourceBrand} from './resource-icon-assets.js'

/** 固定目录声明的插件身份；不用翻译后的名称、用户技能名或任意来源网址猜品牌。 */
const pluginBrands:Readonly<Record<string,ResourceBrand>>={'674':'slack','579':'sentry','49339676':'remotion','9717366':'pstack'}
export function AppResourceIcon({row,size=40}:{row:AppsRow;size?:40|52}){
 const server=row.kind==='app'?row.connectors[0]?.entry?.connector.serverName:undefined
 const brand=row.pack?pluginBrands[row.pack.pluginId]:server?resourceBrand(server,''):undefined
 return <ResourceIcon kind={row.kind==='app'?'connector':row.kind==='bundle'?'plugin':'skill'} id={row.key} title={row.title} brandKey={brand??null} size={size}/>
}
