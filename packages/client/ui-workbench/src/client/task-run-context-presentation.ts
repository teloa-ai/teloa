import type {RunView} from './task-run-api.js'

export type TaskRunContextSection={
 key:'plan'|'industry'|'business'
 titleKey:'taskExecution.context.planTitle'|'taskExecution.context.industryTitle'|'taskExecution.context.businessTitle'
 facts:Array<{labelKey:'taskExecution.context.occurrence'|'taskExecution.context.dataScope'|'taskExecution.context.delivery'|'taskExecution.context.method'|'taskExecution.context.fixedMethod'|'taskExecution.context.output'|'taskExecution.context.source'|'taskExecution.context.objectId'|'taskExecution.context.version'|'taskExecution.context.summary';value:string}>
 requirements:Array<{label?:string;labelKey?:'taskExecution.context.obtain';value:string}>
 skills:Array<{title:string;version:string}>
 notice:string
}

export function taskRunContextSections(run:Pick<RunView,'planContext'|'industryContext'|'businessContext'>):TaskRunContextSection[]{
 const sections:TaskRunContextSection[]=[]
 if(run.planContext){
  const {work}=run.planContext
  sections.push({
   key:'plan',titleKey:'taskExecution.context.planTitle',
   facts:[
    {labelKey:'taskExecution.context.occurrence',value:run.planContext.occurrenceId},
    {labelKey:'taskExecution.context.dataScope',value:run.planContext.dataScope},
    {labelKey:'taskExecution.context.delivery',value:run.planContext.delivery},
    ...(work?[{labelKey:'taskExecution.context.method' as const,value:work.method},{labelKey:'taskExecution.context.output' as const,value:work.output},{labelKey:'taskExecution.context.source' as const,value:work.sourceDigest}]:[]),
   ],
   requirements:work?work.requirements.map(value=>({labelKey:'taskExecution.context.obtain' as const,value})):[],
   skills:work?work.skills.map(({title,version})=>({title,version})):[],
   notice:[run.planContext.notice,work?.notice].filter(Boolean).join(' '),
  })
 }
 if(run.industryContext){
  sections.push({
   key:'industry',titleKey:'taskExecution.context.industryTitle',
   facts:[{labelKey:'taskExecution.context.fixedMethod',value:run.industryContext.method},{labelKey:'taskExecution.context.delivery',value:run.industryContext.output},{labelKey:'taskExecution.context.source',value:run.industryContext.sourceDigest}],
   requirements:run.industryContext.requirements.map((label,index)=>({label,value:run.industryContext!.inputs[index]!})),
   skills:run.industryContext.skills.map(({title,version})=>({title,version})),
   notice:run.industryContext.notice,
  })
 }
 if(run.businessContext){
  const {object}=run.businessContext
  sections.push({
   key:'business',titleKey:'taskExecution.context.businessTitle',
   facts:[{labelKey:'taskExecution.context.objectId',value:object.id},{labelKey:'taskExecution.context.version',value:String(object.version)},{labelKey:'taskExecution.context.source',value:object.source},{labelKey:'taskExecution.context.summary',value:object.summary}],
   requirements:object.fields.map(({label,value})=>({label,value})),skills:[],notice:run.businessContext.notice,
  })
 }
 return sections
}
