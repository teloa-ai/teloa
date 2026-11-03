import {buildSharePlan,readSharePackageV2} from '../../src/client/share-package-plan.ts'
import {dashboardResourceFixture} from './business-dashboard-resource.ts'

/** 固定 SOC 员工、静态方法、未启用计划与完整看板配置；无记录/同步/凭据。 */
export function scopedShareFixture(){
 const pkg=buildSharePlan({subject:'employee',publisher:'Source author',license:'MIT',roles:[{id:'analyst',name:'Scoped analyst',kind:'employee',duty:'Check supplied materials.',dataScope:'Provided materials.',executionScope:'Confirm external writes.',skills:[],knowledge:[]}],skills:[]})
 const file=pkg.files.find(file=>file.path==='teloa.json')!,manifest=JSON.parse(file.text),configuration=dashboardResourceFixture()
 manifest.format='teloa.business-package/v4';manifest.domain=manifest.scope='SOC'
 const add=(id:string,kind:string,title:string,body:unknown)=>{manifest.resources.push({id,kind,title,version:'1.0.0',required:false,source:{kind:'local',path:id+'.json'}});pkg.files.push({path:id+'.json',text:JSON.stringify(body,null,2)})}
 add(configuration.id,'business-configuration','Original SOC dashboard',configuration)
 add('work','work-template','SOC method',{format:'teloa.work-template/v1',id:'work',title:'SOC method',version:'1.0.0',domain:'SOC',description:'Read the supplied materials.',requirements:['Provide materials.'],output:'A checked summary.',skills:[]})
 add('routine','plan','SOC routine',{format:'teloa.plan/v1',version:'1.0.0',title:'SOC routine',workTemplate:'work',dataScope:'Provided materials.',trigger:{kind:'event',source:'Provided materials',event:'Updated source'}})
 manifest.relations.push({kind:'role-work',from:manifest.resources[0].id,to:'work'},{kind:'role-work',from:manifest.resources[0].id,to:'routine'})
 file.text=JSON.stringify(manifest,null,2);pkg.compatibility={manifestFormat:'teloa.business-package/v4',capabilities:['people','automation','business']}
 pkg.provenance.sources=[{title:'Original SOC package',license:'MIT',resourceIds:manifest.resources.map((resource:{id:string})=>resource.id)}]
 return readSharePackageV2(pkg)
}
