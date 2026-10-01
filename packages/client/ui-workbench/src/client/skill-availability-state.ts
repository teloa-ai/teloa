import type {SkillAvailability,SkillAvailabilityPreview} from './skill-availability-api.js'

export type AvailabilityAction='disable'|'enable'
export type AvailabilityView={installationId:string;generation:number;loading:boolean;error:string;current?:SkillAvailability;preview?:SkillAvailabilityPreview;action?:AvailabilityAction}
type Action={type:'select';installationId:string;generation:number}|{type:'loaded';generation:number;value:SkillAvailability}|{type:'preview';generation:number;value:SkillAvailabilityPreview;action:AvailabilityAction}|{type:'error';generation:number;error:string}

/** 所有读取与操作共用世代；旧页面或旧预览只可完成网络请求，不能写回界面。 */
export function reduceAvailabilityView(state:AvailabilityView|undefined,action:Action):AvailabilityView{
 const current=state??{installationId:'',generation:0,loading:false,error:''}
 if(action.type==='select')return {installationId:action.installationId,generation:action.generation,loading:true,error:'',...(current.installationId===action.installationId&&current.current?{current:current.current}:{})}
 if(action.generation!==current.generation)return current
 if(action.type==='error')return {...current,loading:false,error:action.error}
 const incoming=action.type==='loaded'?action.value:action.value.availability
 if(incoming.installationId!==current.installationId)return {...current,loading:false,error:'技能可用状态身份不一致。'}
 if(current.current&&incoming.version<current.current.version)return {...current,loading:false}
 if(current.current&&incoming.version===current.current.version&&JSON.stringify(incoming)!==JSON.stringify(current.current))return {...current,loading:false,error:'技能可用状态同版本内容冲突，请重新核对。'}
 if(action.type==='preview'&&incoming.availability===(action.action==='disable'?'disabled':'enabled'))return {installationId:current.installationId,generation:current.generation,loading:false,current:incoming,error:'技能可用状态已变化，请重新选择操作并预览。'}
 return {installationId:current.installationId,generation:current.generation,loading:false,error:'',current:incoming,...(action.type==='preview'?{preview:action.value,action:action.action}:{})}
}
