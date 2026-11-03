import {useState,type FormEvent} from 'react'
import css from './McpConnectionView.module.css'
import type {SkillSecretsApi,SkillSecretsState} from './skill-secrets-api.js'

const rows={
 title:['本人授权的技能密钥访问','本人授權的技能密鑰存取','Owner-authorized skill credential access'],
 help:['仅授权当前固定安装版本。授权和值不随技能导出；换版本、切换来源或被同名技能遮蔽后不再生效。','只授權目前固定安裝版本。授權及密鑰不隨技能匯出；更換版本、切換來源或被同名技能遮蔽後不再生效。','Authorize this fixed installation only. Consent and credentials are excluded from skill exports and do not transfer to another version or source.'],
 destination:['允许访问的 HTTPS 地址及路径前缀','允許存取的 HTTPS 位址及路徑前綴','Allowed HTTPS origin and path prefix'],
 place:['密钥放置位置','密鑰放置位置','Credential placement'],
 bearer:['Authorization: Bearer','Authorization: Bearer','Authorization: Bearer'],
 header:['请求头','請求標頭','Header'],query:['查询参数','查詢參數','Query parameter'],
 name:['参数名称','參數名稱','Parameter name'],method:['允许的 HTTP 方法','允許的 HTTP 方法','Allowed HTTP method'],
 confirm:['我确认此版本技能仅按以上目标、方法与位置使用密钥；保存授权不会执行请求。','我確認此版本技能只按以上目標、方法及位置使用密鑰；儲存授權不會執行請求。','I authorize this skill version to use a credential only at the destination, method and placement shown. Saving consent sends no request.'],
 authorize:['确认授权并填写密钥','確認授權並填寫密鑰','Authorize and enter credential'],
 active:['这是本人授权，不是官方目录审核。密钥仅在宿主代发时使用，不交给模型或脚本环境。','這是本人授權，並非官方目錄審核。密鑰只在宿主代發時使用，不交給模型或指令碼環境。','This is your consent, not an official catalog review. Only the host HTTP tool receives the credential; models and script environments do not.'],
 revoke:['撤销授权并删除密钥','撤銷授權並刪除密鑰','Revoke access and delete credential'],
 revokeConfirm:['确认撤销此技能的密钥访问并删除已保存的值？','確認撤銷此技能的密鑰存取並刪除已儲存的值？','Revoke this skill’s credential access and delete its saved values?'],
 yes:['确认撤销','確認撤銷','Confirm revocation'],cancel:['取消','取消','Cancel'],
 invalid:['请填写不含账号、查询串或片段的完整 HTTPS 地址。','請填寫不含帳號、查詢字串或片段的完整 HTTPS 位址。','Enter an HTTPS address without credentials, query parameters or a fragment.'],
} as const
const copy=(locale:string,key:keyof typeof rows)=>rows[key][locale==='zh-CN'?0:locale.startsWith('zh')?1:2]

export type OwnedSkillConsentDraft={target:'bearer'|'header'|'query';destination:string;parameter:string;method:string;confirmed:boolean}
export const initialOwnedSkillConsentDraft=():OwnedSkillConsentDraft=>({target:'bearer',destination:'',parameter:'',method:'GET',confirmed:false})

/** 可信授权控件：非秘密草稿归发起对象保留；密钥值仍交原password控件处理。 */
export function OwnedSkillConsent({skill,state,api,locale,busy,act,draft,onDraft}:{skill:string;state:SkillSecretsState;api:SkillSecretsApi;locale:string;busy:boolean;act:(run:()=>Promise<SkillSecretsState>)=>Promise<boolean>;draft:OwnedSkillConsentDraft;onDraft:(value:OwnedSkillConsentDraft)=>void}){
 const {target,destination,parameter,method,confirmed}=draft
 const [revoking,setRevoking]=useState(false),[error,setError]=useState('')
 const change=(patch:Partial<OwnedSkillConsentDraft>)=>onDraft({...draft,...patch})
 const owner=state.owner
 if(!owner||!state.writable||!api.authorizeOwned||!api.revokeOwned)return null
 const submit=(event:FormEvent)=>{
  event.preventDefault();setError('')
  let url:URL
  try{url=new URL(destination);if(url.protocol!=='https:'||url.username||url.password||url.port||url.search||url.hash||(destination!==url.origin&&destination!==url.origin+url.pathname))throw Error()}catch{setError(copy(locale,'invalid'));return}
  if(!confirmed)return
  const secrets=[{envVarName:'SKILL_API_KEY',label:{'zh-CN':'API 密钥',en:'API key'},required:true,target,...(target==='bearer'?{}:{name:parameter}),endpoints:[{origin:url.origin,pathPrefixes:[url.pathname]}],methods:[method]}]
  void act(()=>api.authorizeOwned!(skill,owner.installation,state.binding,secrets)).then(success=>{if(success)onDraft({...draft,confirmed:false,destination:'',parameter:''})})
 }
 return <section className={css.fieldset} aria-label={copy(locale,'title')}>
  <p className={css.reason}>{copy(locale,'active')} · {owner.version}</p>
  {!owner.authorized?<form onSubmit={submit}>
   <p className={css.reason}>{copy(locale,'help')}</p>
   <fieldset className={css.fieldset} disabled={busy||!state.writable}>
    <label className={css.label}>{copy(locale,'destination')}<input className={css.input} type="url" value={destination} onChange={e=>change({destination:e.target.value,confirmed:false})} required placeholder="https://api.example.com/v1/"/></label>
    <label className={css.label}>{copy(locale,'place')}<select className={css.input} value={target} onChange={e=>change({target:e.target.value as typeof target,confirmed:false})}><option value="bearer">{copy(locale,'bearer')}</option><option value="header">{copy(locale,'header')}</option><option value="query">{copy(locale,'query')}</option></select></label>
    {target!=='bearer'&&<label className={css.label}>{copy(locale,'name')}<input className={css.input} value={parameter} onChange={e=>change({parameter:e.target.value,confirmed:false})} required/></label>}
    <label className={css.label}>{copy(locale,'method')}<select className={css.input} value={method} onChange={e=>change({method:e.target.value,confirmed:false})}>{['GET','POST','PUT','PATCH','DELETE'].map(v=><option key={v}>{v}</option>)}</select></label>
    <label className={css.label}><input type="checkbox" checked={confirmed} onChange={e=>change({confirmed:e.target.checked})}/>{copy(locale,'confirm')}</label>
    <button className={`${css.btn} ${css.btnPrimary}`} type="submit" disabled={!confirmed}>{copy(locale,'authorize')}</button>
   </fieldset>
  </form>:<div className={css.actions}>
   {!revoking?<button className={`${css.btn} ${css.btnDestructive}`} type="button" disabled={busy||!state.writable} onClick={()=>setRevoking(true)}>{copy(locale,'revoke')}</button>:<div className={css.confirmBox} role="alertdialog" aria-label={copy(locale,'revoke')}>
    <p>{copy(locale,'revokeConfirm')}</p><button className={`${css.btn} ${css.btnDestructive}`} type="button" disabled={busy||!state.writable} onClick={()=>void act(()=>api.revokeOwned!(skill,owner.installation,state.binding!)).then(success=>{if(success)setRevoking(false)})}>{copy(locale,'yes')}</button><button className={css.btn} type="button" onClick={()=>setRevoking(false)}>{copy(locale,'cancel')}</button>
   </div>}
  </div>}
  {error&&<p className={css.error} role="alert">{error}</p>}
 </section>
}
