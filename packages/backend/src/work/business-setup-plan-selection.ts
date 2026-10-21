import {readBusinessConfigurationCandidateVersioned,type BusinessConfigurationCandidate,type BusinessConfigurationCandidateV2,type BusinessObjectTypeDefinition,type BusinessObjectTypeDefinitionV2} from '@teloa/contract'
import type {BusinessSetupChange} from '@teloa/contract'
type Candidate=BusinessConfigurationCandidate|BusinessConfigurationCandidateV2
type Definition=Candidate['definitions'][number]
const same=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b)
const key=(d:Definition)=>d.kind+':'+d.definition.id
function configurationOperations(before:Candidate,after:Candidate){
 const operations:{change:BusinessSetupChange;restore:(candidate:Candidate)=>void}[]=[]
 const add=(id:string,entity:BusinessSetupChange['entity'],label:string,left:unknown,right:unknown,restore:(candidate:Candidate)=>void)=>{if(!same(left,right))operations.push({change:{id,entity,label,before:left??null,after:right??null},restore})}
 add('business:title','business','业务名称',before.title,after.title,c=>{c.title=before.title})
 add('business:home','business','业务首页',before.homePageId,after.homePageId,c=>{if(before.homePageId)c.homePageId=before.homePageId;else delete c.homePageId})
 const left=new Map(before.definitions.map(d=>[key(d),d])),right=new Map(after.definitions.map(d=>[key(d),d]))
 for(const id of new Set([...left.keys(),...right.keys()])){
  const a=left.get(id),b=right.get(id)
  if(a?.kind==='object-type'&&b?.kind==='object-type'){
   const old=a.definition as BusinessObjectTypeDefinition|BusinessObjectTypeDefinitionV2,next=b.definition as typeof old,{fields:oldFields,...oldRest}=old,{fields:nextFields,...nextRest}=next
   add('definition:'+id,'definition',old.title+' · 定义',oldRest,nextRest,c=>{const row=c.definitions.find(d=>key(d)===id)!;row.definition={...oldRest,fields:(row.definition as typeof old).fields} as typeof row.definition})
   const ls=new Map(oldFields.map(f=>[f.name,f])),rs=new Map(nextFields.map(f=>[f.name,f]))
   for(const field of new Set([...ls.keys(),...rs.keys()])){
    const l=ls.get(field),r=rs.get(field)
    add('field:'+id+':'+field,'field',old.title+' · '+(r?.label??l!.label),l,r,c=>{const row=c.definitions.find(d=>key(d)===id) as {kind:'object-type';definition:BusinessObjectTypeDefinition|BusinessObjectTypeDefinitionV2};const fields=row.definition.fields.filter(f=>f.name!==field);if(l)fields.splice(Math.min(oldFields.findIndex(f=>f.name===field),fields.length),0,structuredClone(l));row.definition.fields=fields as typeof row.definition.fields})
   }
  }else add('definition:'+id,'definition',(b??a)!.definition.title,a,b,c=>{c.definitions=c.definitions.filter(d=>key(d)!==id) as Candidate['definitions'];if(a)c.definitions.push(structuredClone(a) as never)})
 }
 const lp=new Map(before.pages.map(p=>[p.id,p])),rp=new Map(after.pages.map(p=>[p.id,p]))
 for(const id of new Set([...lp.keys(),...rp.keys()]))add('page:'+id,'page',(rp.get(id)??lp.get(id))!.title,lp.get(id),rp.get(id),c=>{const position=c.pages.findIndex(p=>p.id===id);c.pages=c.pages.filter(p=>p.id!==id);const old=lp.get(id);if(old)c.pages.splice(Math.min(position<0?before.pages.findIndex(p=>p.id===id):position,c.pages.length),0,structuredClone(old))})
 const beforeOrder=before.pages.map(p=>p.id),afterOrder=after.pages.map(p=>p.id)
 add('business:page-order','page','页面顺序',beforeOrder,afterOrder,c=>{const byId=new Map(c.pages.map(p=>[p.id,p]));c.pages=[...beforeOrder.filter(id=>byId.has(id)).map(id=>byId.get(id)!),...c.pages.filter(p=>!beforeOrder.includes(p.id))]})
 return operations
}
export function businessSetupConfigurationChanges(before:Candidate,after:Candidate):BusinessSetupChange[]{return configurationOperations(before,after).map(row=>row.change)}
/** 选择作用于固定基线，拒绝后重验全部引用；决不能提交仅由前端打勾的旧预览。 */
export function selectBusinessSetupConfiguration(before:Candidate,after:Candidate,rejected:readonly string[]):Candidate{
 const candidate=structuredClone(after),operations=configurationOperations(before,after)
 for(const row of operations)if(rejected.includes(row.change.id))row.restore(candidate)
 return readBusinessConfigurationCandidateVersioned(candidate)
}
