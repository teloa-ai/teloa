import {marketPluginPermissionDescription,type MarketPluginInstallPreview} from '@teloa/contract'
import {useI18n} from './i18n/provider.js'
import css from './RealSkillInstallations.module.css'

/**
 * DSH 插件安装的知情同意呈现，市场路径与行业模板路径共用一份。
 *
 * 行业模板恰恰是第三方内容进入系统的主入口，此前那条路只有一个「安装插件」按钮，
 * 用户从头到尾看不到「它会改动什么」。两条路只有共用同一套呈现，才谈得上「这道关存在」。
 */
// 契约里的信任结论是三态。把 rejected 折叠成“未核验”，被拒绝的补丁与仅仅未签名的包在界面上
// 就成了同一句话——前者是核验结论为拒绝（服务端根本不会装），后者只是没能确认为纯新增。
export const trustKey=(status:MarketPluginInstallPreview['trust']['status'])=>status==='verified'?'market.plugin.install.trust.verified':status==='rejected'?'market.plugin.install.trust.rejected':'market.plugin.install.trust.unverified' as const
export const trustNoticeKey=(status:MarketPluginInstallPreview['trust']['status'])=>status==='verified'?'market.plugin.install.trust.verifiedNotice':status==='rejected'?'market.plugin.install.trust.rejectedNotice':'market.plugin.install.trust.unverifiedNotice' as const

/** 权限摘要的唯一呈现：逐条给出 id、描述与必需/可选，必需用 token 色徽标而不是小字，Preview 与 EnableConfirm 共用同一形状。 */
export function PermissionList({permissions}:{permissions:MarketPluginInstallPreview['permissionSummary']['permissions']}){
  const {t}=useI18n()
  if(!permissions.length)return <>{t('market.plugin.install.permission.none')}</>
  return <ul>{permissions.map(permission=><li key={permission.id}>{permission.id} · {marketPluginPermissionDescription(permission.id)??permission.description} · {permission.required?<span className={css.warn}>{t('market.plugin.install.permission.required')}</span>:t('market.plugin.install.permission.optional')}</li>)}</ul>
}
export function PluginPreviewFacts({value}:{value:MarketPluginInstallPreview}){const {t}=useI18n();return <dl><dt>{t('market.plugin.install.field.source')}</dt><dd>{value.source.packageName}</dd><dt>{t('market.plugin.install.field.version')}</dt><dd>{value.source.version}</dd><dt>{t('market.plugin.install.field.integrity')}</dt><dd>{value.trust.integrity}</dd><dt>{t('market.plugin.install.field.publisher')}</dt><dd>{value.trust.publisher}</dd><dt>{t('market.plugin.install.field.trust')}</dt><dd>{t(trustKey(value.trust.status))}</dd><dt>{t('market.plugin.install.field.permissions')}</dt><dd><PermissionList permissions={value.permissionSummary.permissions}/></dd><dt>{t('market.plugin.install.field.restart')}</dt><dd>{t('market.plugin.install.restart.pending')}</dd></dl>}
export function PluginInstallConfirm({preview,busy,cancel,install}:{preview:MarketPluginInstallPreview;busy:boolean;cancel:()=>void;install:()=>Promise<void>}){const {t}=useI18n();return <div role="dialog" aria-label={t('market.plugin.install.confirm.title')} className={css.notice}><h4>{t('market.plugin.install.confirm.title')}</h4><p>{t('market.plugin.install.confirm.notice')}</p><p>{preview.source.packageName}@{preview.source.version}</p><div className={css.buttons}><button type="button" onClick={cancel}>{t('market.plugin.install.action.cancel')}</button><button type="button" disabled={busy} onClick={()=>void install()}>{t('market.plugin.install.confirm.action')}</button></div></div>}
/** 不是弹框：与详情同屏的确认区，逐条摆出权限摘要（id、描述与必需/可选徽标同 Preview）、发布者、来源版本、完整性摘要与信任结论，勾选核对后才能提交启用。启用是最后一次人工把关，`integrity` 必须同屏可核。 */
export function EnableConfirm({preview,ack,setAck,busy,enable}:{preview:MarketPluginInstallPreview;ack:boolean;setAck:(value:boolean)=>void;busy:boolean;enable:()=>void}){
  const {t}=useI18n()
  return <div className={css.notice}><h4>{t('market.plugin.install.enable.title')}</h4><p>{t('market.plugin.install.enable.notice')}</p><dl><dt>{t('market.plugin.install.field.source')}</dt><dd>{preview.source.packageName}</dd><dt>{t('market.plugin.install.field.version')}</dt><dd>{preview.source.version}</dd><dt>{t('market.plugin.install.field.publisher')}</dt><dd>{preview.trust.publisher}</dd><dt>{t('market.plugin.install.field.integrity')}</dt><dd>{preview.trust.integrity}</dd><dt>{t('market.plugin.install.field.trust')}</dt><dd>{preview.trust.status==='rejected'?<span className={css.warn}>{t(trustKey('rejected'))}</span>:t(trustKey(preview.trust.status))}</dd><dt>{t('market.plugin.install.field.permissions')}</dt><dd><PermissionList permissions={preview.permissionSummary.permissions}/></dd></dl><label><input type="checkbox" checked={ack} onChange={event=>setAck(event.target.checked)}/> {t('market.plugin.install.enable.acknowledge')}</label><div className={css.buttons}><button type="button" disabled={busy||!ack} onClick={enable}>{t('market.plugin.install.action.enable')}</button></div></div>
}
