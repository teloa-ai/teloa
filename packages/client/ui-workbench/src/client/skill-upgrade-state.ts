import type {SkillUpgradePreview} from './skill-upgrade-api.js'
import type {MarketItem} from './market-preview.js'
export type SkillUpgradeView={contentId:string;generation:number;loading:boolean;error:string;preview?:SkillUpgradePreview}
type Action={type:'target';contentId:string;generation:number}|{type:'result';generation:number;preview:SkillUpgradePreview}|{type:'error';generation:number;error:string}
export function reduceSkillUpgradeView(state:SkillUpgradeView|undefined,action:Action):SkillUpgradeView{
 const current=state??{contentId:'',generation:0,loading:false,error:''}
 if(action.type==='target')return {contentId:action.contentId,generation:action.generation,loading:!!action.contentId,error:'',...(current.contentId===action.contentId&&current.preview?{preview:current.preview}:{})}
 if(action.generation!==current.generation)return current
 if(action.type==='error')return {...current,loading:false,error:action.error}
 if(action.preview.target.source.kind!=='atomic'||action.preview.target.source.contentId!==current.contentId)return {...current,loading:false,error:'升级目标来源不一致，请重新选择。'}
 return {...current,loading:false,error:'',preview:action.preview}
}
export function upgradeCandidates(items:readonly MarketItem[],query:string){const needle=query.trim().toLocaleLowerCase();return items.filter(item=>item.kind==='skill'&&item.source.kind==='stored'&&!!item.contentStorage?.contentId&&item.source.contentId===item.contentStorage.contentId&&!!item.hash&&[item.title,item.version].some(value=>value.toLocaleLowerCase().includes(needle)))}
