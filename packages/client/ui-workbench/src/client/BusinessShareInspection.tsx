import type {BusinessShareInspection as Inspection} from '@teloa/contract'
import {useI18n} from './i18n/provider.js'
import css from './BusinessShareForm.module.css'
/** 两种分享协议共用检查摘要，始终只显示脱敏位置。 */
export function BusinessShareInspection({inspection,purpose}:{inspection:Inspection;purpose:string}){
 const {locale}=useI18n(),cn=locale==='zh-CN',tw=locale==='zh-TW'||locale==='zh-HK'
 return <section className={css.sources} aria-label={cn?'分享内容检查':tw?'分享內容檢查':'Share content inspection'}>
  <h3>{cn?'用途与实际文件':tw?'用途與實際檔案':'Purpose and actual files'}</h3><p>{inspection.findings.some(hit=>hit.path==='purpose')?(cn?'用途说明需要修改。':tw?'用途說明需要修改。':'Edit the purpose description.'):purpose}</p>
  <ul>{inspection.fileList.map(file=><li key={file.path}>{file.path}</li>)}</ul>
  {inspection.findings.length?<div role="alert"><p>{cn?'检测到疑似凭据，已阻止下载和保存。请修改说明或原业务定义，再重新预览。':tw?'偵測到疑似憑證，已阻止下載和儲存。請修改說明或原業務定義，再重新預覽。':'Possible credentials detected. Download and save are blocked. Edit the description or source business definition, then preview again.'}</p><ul>{inspection.findings.map((hit,index)=><li key={index}>{hit.path} · {hit.kind} · {hit.start}–{hit.end}</li>)}</ul></div>:<p>{cn?'未发现已知凭据形态。请核对用途、默认值及其他私人信息；接收者仍须绑定本人的来源。':tw?'未發現已知憑證形態。請核對用途、預設值及其他私人資訊；接收者仍須綁定本人的來源。':'No known credential patterns found. Review the purpose, defaults and other private information. Recipients must bind their own sources.'}</p>}
 </section>
}
