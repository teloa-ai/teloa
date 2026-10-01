import {useI18n} from './i18n/provider.js'

const keys={
 title:'market.plugin.install.title',preview:'market.plugin.install.action.preview',loading:'market.plugin.install.status.loading',source:'market.plugin.install.field.source',version:'market.plugin.install.field.version',integrity:'market.plugin.install.field.integrity',publisher:'market.plugin.install.field.publisher',permissions:'market.plugin.install.field.permissions',required:'market.plugin.install.permission.required',optional:'market.plugin.install.permission.optional',restart:'market.plugin.install.field.restart',restartUnknown:'market.plugin.install.restart.pending',restartRequired:'market.plugin.install.restart.required',restartNotRequired:'market.plugin.install.restart.notRequired',prepare:'market.plugin.install.action.prepare',confirmTitle:'market.plugin.install.confirm.title',confirm:'market.plugin.install.confirm.action',cancel:'market.plugin.install.action.cancel',unknown:'market.plugin.install.state.unknownNotice',reconcile:'market.plugin.install.action.reconcile',active:'market.plugin.install.state.active',preparing:'market.plugin.install.state.preparing',failed:'market.plugin.install.state.failed',unknownState:'market.plugin.install.state.unknown',unavailable:'market.plugin.install.unavailable',maintenance:'market.plugin.install.maintenance.title',refresh:'market.plugin.install.action.refresh',empty:'market.plugin.install.empty',open:'market.plugin.install.action.open',failure:'market.plugin.install.failure',attempt:'market.plugin.install.attempt',install:'market.plugin.install.action.install',previewFailed:'market.plugin.install.error.previewFailed',confirmNotice:'market.plugin.install.confirm.notice',sourceOnly:'market.plugin.install.source.githubOnly',status:'market.plugin.install.field.status',back:'market.plugin.install.action.back',record:'market.plugin.install.record.title',noPermissions:'market.plugin.install.permission.none',recovery:'market.plugin.install.recovery',
} as const
export type MarketPluginInstallMessage=keyof typeof keys

/** 兼容旧调用方，同时统一复用产品词典、地区回退和 React 订阅。 */
export function useMarketPluginInstallI18n(){
  const {t}=useI18n()
  return (key:MarketPluginInstallMessage)=>t(keys[key])
}
