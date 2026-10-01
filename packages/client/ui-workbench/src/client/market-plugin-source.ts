import {readMarketPluginRegistrySource,type MarketPluginRegistrySource} from '@teloa/contract'
import type {MarketItem} from './market-preview.js'

/** GitHub 或显示标题都不是可安装身份；只有条目显式携带的 npm 精确来源可提交。 */
export function marketPluginInstallSource(item:MarketItem):MarketPluginRegistrySource|undefined{
  if(item.resourceKind!=='plugin'||item.pluginInstallSource===undefined)return undefined
  try{return readMarketPluginRegistrySource(item.pluginInstallSource)}catch{return undefined}
}
