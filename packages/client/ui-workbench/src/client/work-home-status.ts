export type AttentionStatus={count:number;known:boolean}
export type PlanStatus={savedPlans:number;examplePlans:number;exampleRuns:number;directory:'loading'|'ready'|'failed'}

type PlanStatusKey='continuous.rolePlans.count'|'attention.persistence.example'|'navigation.plans'|'continuous.detail.runs'|'continuous.saved.description'|'continuous.empty.plans'|'continuous.loading'|'continuous.loading.retry'
type PlanStatusTranslate=(key:PlanStatusKey,values?:Readonly<Record<string,string|number>>)=>string

export function attentionStatusText(status:AttentionStatus,t:(key:'home.attentionCount'|'attention.home.checking',values?:{count:number})=>string):string{return status.known?t('home.attentionCount',{count:status.count}):t('attention.home.checking')}

export function planStatusText(status:PlanStatus,t:PlanStatusTranslate):string{
  const plans=[
    status.savedPlans?t('continuous.rolePlans.count',{count:status.savedPlans}):'',
    status.examplePlans?[String(status.examplePlans),t('attention.persistence.example'),t('navigation.plans')].join(' · '):'',
  ].filter(Boolean).join(' · ')
  const facts=[]
  if(status.directory==='loading')facts.push(t('continuous.loading'))
  if(status.directory==='failed')facts.push(t('continuous.loading.retry'))
  if(status.exampleRuns)facts.push(`${t('attention.persistence.example')} · ${t('continuous.detail.runs',{count:status.exampleRuns})}`)
  else if(status.directory==='ready'&&status.savedPlans)facts.push(t('continuous.saved.description'))
  // 段间用「 · 」拼，与工作台其余摘要行一致；英文分号夹在中文句子里很扎眼。
  if(!plans)return facts.join(' · ')||t('continuous.empty.plans')
  return plans+(facts.length?' · '+facts.join(' · '):'')
}
