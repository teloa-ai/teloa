import {ContextDrawer} from './ContextDrawer.js'
import {CreateEntry} from './CreateEntry.js'
import {MarketTemplateCreator} from './MarketTemplateCreator.js'
import type {MyResourcesWiring} from './TeamCapabilitiesPage.js'
import {useI18n} from './i18n/provider.js'
import css from './MarketTemplateCreator.module.css'
import {useTemplateShare} from './EmployeeTemplateShare.js'

export type MarketResourceKind='skill'|'app'

/** 应用页按需创建原子能力；关闭保留本入口草稿，准备会话不自动发送或安装。 */
export function MarketResourceCreator({kind,open,close,creation,browse}:{kind:MarketResourceKind;open:boolean;close:()=>void;creation:NonNullable<MyResourcesWiring['pageCreate']>;browse:()=>void}){
 const {t}=useI18n(),sharing=useTemplateShare()
 if(kind==='app')return <MarketTemplateCreator kind="app" open={open} close={close} creation={creation}/>
 return <ContextDrawer open={open} title={t('market.apps.createSkill')} close={close}>
  <div className={css.body}><CreateEntry entity="skill" embedded active={open} directSentence submitLabelKey="market.apps.continue" {...(sharing?{sentenceDraft:{key:'teloa.market-creation-input/v1/skill',storage:sharing.storage}}:{})} api={creation.api} prepare={prompt=>creation.prepare(prompt)} onPrepared={close} openMarket={browse}
   onConfirm={creation.confirmSkill} afterConfirm={creation.openSkill}/></div>
 </ContextDrawer>
}
