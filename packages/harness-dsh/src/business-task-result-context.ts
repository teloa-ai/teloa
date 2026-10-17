import {WorkError,taskToolArgumentsAllowed,type TaskToolArgumentRule} from '@teloa/contract'
import {readRunBusinessContext,type RunBusinessContext,type TaskRun,type BusinessTaskResultMapping} from '@teloa/backend'

export const objectResultTool='teloa_business_object_result_record'
export type BusinessResultAuthorization={roleId:string;allowedTools:readonly string[];argumentRules?:TaskToolArgumentRule[]}

/** 声明目录不是新授权；只暴露原成果工具及参数合同允许提交的目标。 */
export async function withBusinessTaskResultMappings(context:RunBusinessContext|undefined,authorization:BusinessResultAuthorization,read:(context:RunBusinessContext)=>Promise<BusinessTaskResultMapping[]>):Promise<RunBusinessContext|undefined>{
 if(!context||!authorization.allowedTools.includes(objectResultTool))return context
 const resultMappings=(await read(context)).filter(item=>authorization.argumentRules===undefined||taskToolArgumentsAllowed(authorization.argumentRules,objectResultTool,{mappingId:item.mapping.id,result:{}}))
 return {...context,resultMappings}
}

/** 显式选择与单目标默认共用冻结目录；旧执行缺目录不得临时猜测当前配置。 */
export function fixedBusinessTaskResultMapping(run:Pick<TaskRun,'inputText'|'allowedTools'|'argumentRules'>,mappingId:string|undefined,result:Record<string,unknown>):{mappingId:string;context:RunBusinessContext&{resultMappings:BusinessTaskResultMapping[]}}{
 if(!run.allowedTools.includes(objectResultTool))throw new WorkError('teloa/forbidden','本轮没有业务对象成果授权。')
 const {notice:_notice,...raw}=JSON.parse(run.inputText).businessContext??{}
 const context=readRunBusinessContext(raw),mappings=context?.resultMappings
 if(!context||!mappings)throw new WorkError('teloa/forbidden','本轮未固定成果映射，请从原工作重新准备。')
 const selected=mappingId===undefined?(mappings.length===1?mappings[0]:undefined):mappings.find(item=>item.mapping.id===mappingId)
 if(!selected)throw new WorkError('teloa/forbidden',mappingId===undefined?'请从本轮成果目录选择适用的映射；不能猜测写入目标。':'此成果映射不在本轮授权目录内。')
 const args={mappingId:selected.mapping.id,result}
 if(run.argumentRules!==undefined&&!taskToolArgumentsAllowed(run.argumentRules,objectResultTool,args))throw new WorkError('teloa/forbidden','成果参数超出本轮固定授权。')
 return {mappingId:selected.mapping.id,context:{...context,resultMappings:mappings}}
}
