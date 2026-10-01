import type {MarketItem} from './market-preview.js'
import type {SkillAvailability,SkillAvailabilityApi} from './skill-availability-api.js'
import type {SkillInstallApi,SkillInstallationRecord,SkillInstallObservation} from './skill-install-api.js'

export type MarketSkillRuntimeFact={
 record:SkillInstallationRecord
 availability:SkillAvailability|null
 observation:SkillInstallObservation|null
 verificationError?:true
}
export type MarketSkillRuntime={state:'loading'|'ready'|'error';facts:MarketSkillRuntimeFact[]}
export type MarketRuntimePresentation={status:string;action:string;installationId?:string}

const fixedContentId=(record:SkillInstallationRecord)=>record.source.kind==='industry-public'?record.source.sourceContentId:record.source.contentId

function fixedSkillItem(item:MarketItem):boolean{
 return item.kind==='skill'&&!!item.contentStorage?.loaded
}

function matchingSkill(item:MarketItem,runtime:MarketSkillRuntime):MarketSkillRuntimeFact|undefined{
 if(!fixedSkillItem(item))return undefined
 return runtime.facts.find(fact=>fixedContentId(fact.record)===item.contentStorage!.contentId)
}

/**
 * 将市场定义和真实安装事实连接起来。只接受固定内容身份，不按标题、显示名或 Skill 名猜测。
 */
export function marketRuntimeForItem(item:MarketItem,runtime:MarketSkillRuntime):MarketRuntimePresentation|undefined{
 if(item.resourceKind==='plugin')return {status:'状态未核验',action:'查看并安装'}
 if(item.kind!=='skill')return undefined
 if(runtime.state==='loading')return {status:'正在核对安装状态',action:'查看安装管理'}
 if(runtime.state==='error')return {status:'状态未核验',action:'查看安装管理'}
 const fact=matchingSkill(item,runtime)
 if(!fact)return fixedSkillItem(item)?{status:'尚未安装',action:'查看并安装'}:{status:'状态未核验',action:'查看并安装'}
 const installationId=fact.record.id
 if(fact.record.state==='preparing')return {status:'安装待核对',action:'继续核对安装',installationId}
 if(fact.availability?.availability==='disabled'||fact.observation?.state==='disabled')return {status:'已停用',action:'查看安装',installationId}
 if(fact.observation?.state==='missing')return {status:'安装记录存在，运行缺失',action:'核对安装',installationId}
 if(fact.observation?.state==='shadowed')return {status:'已安装，当前被同名能力遮蔽',action:'核对安装',installationId}
 if(fact.observation?.state==='available'&&fact.availability?.availability==='enabled')return {status:'已安装并可用',action:'查看安装',installationId}
 return {status:'已安装，可用性未核验',action:'核对安装',installationId}
}

/** 目录读取失败影响整体可信度；单条可用性检查失败只降级该安装，不丢掉已安装事实。 */
export async function loadMarketSkillRuntime(api:Pick<SkillInstallApi,'list'|'observe'>,availabilityApi?:Pick<SkillAvailabilityApi,'get'>):Promise<MarketSkillRuntime>{
 try{
  const {items}=await api.list()
  const facts=await Promise.all(items.map(async record=>{
   if(record.state!=='installed')return {record,availability:null,observation:null} satisfies MarketSkillRuntimeFact
   const [availability,observation]=await Promise.allSettled([
    availabilityApi?availabilityApi.get(record.id):Promise.resolve(null),
    api.observe(record.id),
   ])
   const failed=availability.status==='rejected'||observation.status==='rejected'
   return {record,availability:availability.status==='fulfilled'?availability.value:null,observation:observation.status==='fulfilled'?observation.value:null,...(failed?{verificationError:true as const}:{})}
  }))
  return {state:'ready',facts}
 }catch{return {state:'error',facts:[]}}
}
