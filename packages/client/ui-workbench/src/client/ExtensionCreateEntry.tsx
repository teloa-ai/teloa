import {readMarketPluginRegistrySource,type PageCreateDraftPreview} from '@teloa/contract'
import {MarketPluginInstallControl} from './MarketPluginInstallations.js'
import type {MarketPluginInstallApi} from './market-plugin-install-api.js'
import {useI18n} from './i18n/provider.js'

type Props={preview:PageCreateDraftPreview;api:MarketPluginInstallApi;apply:(appliedRef:string)=>Promise<void>}

/**
 * 会话草案只给出官方扩展坐标；真实权限、来源与完整性仍须由既有安装预览读取。
 * 安装服务返回真实安装记录后，才允许父级将草案标为已落地。
 */
export function ExtensionCreateEntry({preview,api,apply}:Props){
 const {t}=useI18n()
 let source
 try{source=readMarketPluginRegistrySource(JSON.parse(preview.draft.body))}catch{return <p role="alert">{t('create.readFailed')}</p>}
 return <MarketPluginInstallControl api={api} source={source} title={source.packageName} onInstalled={record=>{void apply(record.id).catch(()=>{})}}/>
}
