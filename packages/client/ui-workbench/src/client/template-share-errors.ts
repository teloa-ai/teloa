import type {TemplateSharePolicy} from '@teloa/contract'
import type {TemplateShareMessageKey} from './i18n/locales/template-share.js'
export function templateSharePolicyKey(policy?:TemplateSharePolicy):TemplateShareMessageKey{
 if(policy?.reason==='authentication-required')return 'templateShare.login'
 if(policy?.reason==='administrator-required')return 'templateShare.administrator'
 if(policy?.reason==='permission-denied'||policy?.reason==='forbidden')return 'templateShare.denied'
 return 'templateShare.offline'
}
/** 只呈现稳定状态，不把原始服务异常和本机细节搬进产品。 */
export function templateShareErrorKey(error:unknown,fallback:TemplateShareMessageKey='templateShare.unknown'):TemplateShareMessageKey{
 if(!error||typeof error!=='object')return fallback
 const value=error as {code?:string;status?:number;statusCode?:number;message?:string},code=String(value.code??'').toLowerCase(),status=value.status??value.statusCode
 if(status===401||code==='authentication-required'||code.includes('unauth'))return 'templateShare.login'
 if(code==='administrator-required')return 'templateShare.administrator'
 if(status===403||code==='permission-denied'||code.includes('forbidden'))return 'templateShare.denied'
 if(code==='stale'||code==='stale-context'||code==='context-changed'||code==='acceptance-conflict')return 'templateShare.contextChanged'
 if(code==='cancelled')return 'templateShare.cancelled'
 if(code==='popup-blocked')return 'templateShare.popupBlocked'
 if(code==='share-changed')return 'templateShare.changed'
 if(status===410||code==='gone'||code==='revoked')return 'templateShare.revoked'
 if(status===404||code.includes('not_found')||code.includes('not-found'))return 'templateShare.notFound'
 if(status===400||code.includes('invalid')||code.includes('bad_request'))return 'templateShare.invalid'
 if(code==='teloa/source-unavailable')return 'templateShare.receiveSourceUnavailable'
 if(code==='teloa/dependency-unavailable')return 'templateShare.installUnavailable'
 if(status===503||code.includes('unavailable'))return 'templateShare.offline'
 return fallback
}
