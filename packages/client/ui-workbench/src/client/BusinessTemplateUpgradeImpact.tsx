import type {BusinessTemplateUpgradeImpact as Impact} from '@teloa/contract'
import {useI18n} from './i18n/provider.js'
export function BusinessTemplateUpgradeImpact({impact}:{impact:Impact}){
 const {locale}=useI18n(),cn=locale==='zh-CN',tw=locale==='zh-TW'||locale==='zh-HK'
 const reasons:Record<Impact['fields'][number]['reason'],string>=cn?{'removed-object':'删除对象类型','removed-field':'删除字段','changed-type':'变更类型或字段来源','changed-rule':'缩减状态或选项','changed-source':'变更记录来源','invalid-existing-value':'现有值不符合新规则'}:tw?{'removed-object':'刪除物件類型','removed-field':'刪除欄位','changed-type':'變更類型或欄位來源','changed-rule':'縮減狀態或選項','changed-source':'變更記錄來源','invalid-existing-value':'現有值不符合新規則'}:{'removed-object':'Remove object type','removed-field':'Remove field','changed-type':'Change type or field mapping','changed-rule':'Narrow states or choices','changed-source':'Change record source','invalid-existing-value':'Existing value violates new rules'}
 return <section aria-label={cn?'配置对记录的影响':tw?'配置對記錄的影響':'Configuration impact on records'}>
  <p role={impact.blocked?'alert':'status'}>{impact.blocked?(cn?'此变化影响现有历史记录，已阻止采用。请先单独迁移数据。':tw?'此變更影響現有歷史記錄，已阻止採用。請先另行遷移資料。':'This change affects existing records and cannot be adopted. Migrate the data separately first.'):(cn?'原记录、工作成果和授权保持不变；新增持续规则仍须单独启用。':tw?'原記錄、工作成果和授權保持不變；新增持續規則仍須另行啟用。':'Records, work results and authorizations are preserved. New ongoing rules require separate activation.')}</p>
  {!!impact.fields.length&&<ul>{impact.fields.map((row,index)=><li key={index}>{row.objectType}{row.field?' / '+row.field:''} · {reasons[row.reason]} · {row.affectedRecords} {cn?'条记录':tw?'筆記錄':'records'}</li>)}</ul>}
  {!!impact.warnings?.length&&<div role="status"><p>{cn?'既有历史数据问题仍需修复；本次未改变这些字段规则，原快照保持不变。':tw?'既有歷史資料問題仍須修復；本次未改變這些欄位規則，原快照保持不變。':'Existing historical data issues still need repair. These field rules are unchanged; original snapshots are preserved.'}</p><ul>{impact.warnings.map((row,index)=><li key={index}>{row.objectType}{row.field?' / '+row.field:''} · {row.affectedRecords} {cn?'条记录':tw?'筆記錄':'records'}</li>)}</ul></div>}
  {!!impact.newSourceRequirements.length&&<p>{cn?'需重新核对来源：':tw?'須重新核對來源：':'Review source requirements: '}{impact.newSourceRequirements.join('、')}</p>}
 </section>
}
