import type { Translate } from '@deepseek-ai/dsh-client-ui-slots'
import {applicationPresentation,applicationProductName} from './application-presentation.ts'
export type BrandLocale={bind:(namespace:string)=>Translate;getSnapshot:()=>{active:string}}
export {standardModeName} from './standard-mode-options.ts'
const taskTeamCopy:Record<string,readonly [string,string]>={
  trigger:['执行小组','Task team'],
  loading:['正在加载执行小组…','Loading task team…'],
  unavailable:['执行小组暂不可用','Task team is unavailable'],
  empty:['尚未建立小组任务清单。','No task checklist has been created for this team.'],
  roster:['负责人和执行助手','Lead and task assistants'],
  tasks:['小组任务','Team tasks'],
  open:['打开执行会话','Open execution conversation'],
  owner:['负责人','Assignee'],
  'memberStatus.inactive':['空闲（查看任务清单核对完成情况）','Idle (see task checklist for completion)'],
}
/** 适配品牌与产品词汇；继续复用原生组件，不注册重复词典、不更改语言偏好。 */
export function installConversationBrand(locale:BrandLocale):()=>void {
  const original=locale.bind
  let enabled=true
  const cached=new Map<string,Translate>()
  const bind:BrandLocale['bind']=namespace=>{
    const native=original.call(locale,namespace)
    if(namespace!=='conversation'&&namespace!=='agent-team'&&namespace!=='dsh-context'&&namespace!=='chat')return native
    const existing=cached.get(namespace)
    if(existing)return existing
    const translated:Translate=(key,params)=>{
      const zh=locale.getSnapshot().active.toLowerCase().startsWith('zh')
      if(!enabled)return native(key,params)
      if(namespace==='chat'){
        if(key==='chat.deepDiving')return zh?'正在处理':'Working'
        if(key==='chat.deepDivingFor')return zh?`正在处理，用时 ${String(params?.duration??'')} ···`:`Working for ${String(params?.duration??'')} ···`
        return native(key,params)
      }
      if(namespace==='agent-team'){
        const copy=taskTeamCopy[key]
        if(copy)return copy[zh?0:1]
        if(key==='failure')return (zh?'执行小组记录暂不可用：':'Task team record is unavailable: ')+String(params?.message??'')
        return native(key,params)
      }
      if(namespace==='dsh-context'){
        if(key==='stats.cost')return zh?'参考费用':'Estimated cost'
        if(key==='stats.costTip')return zh?'按模型报告的用量和 models.dev 参考价估算，包含本会话及各级助手。当前实际提供方和模型见上下文顶部，历史调用以请求轨迹为准。实际提供方没有价格目录时，会按模型匹配参考来源；无法明确匹配时不估算。实际结算以服务账单为准。':'Estimated from model-reported usage and models.dev reference prices, including this session and all assistants. The context header shows the current provider and model; request history records earlier routes. When the actual provider has no price catalog, a model match supplies reference rates; ambiguous matches remain unpriced. The service bill determines the actual charge.'
        if(key==='stats.costPriceBy')return zh?`估算价格来源：models.dev · ${String(params?.p??'')} · ${String(params?.m??'')}。实际调用提供方与模型见上下文顶部和请求轨迹。`:`Reference price source: models.dev · ${String(params?.p??'')} · ${String(params?.m??'')}. See the context header and request history for the actual provider and model.`
        return native(key,params)
      }
      // 接管工作室品牌与欢迎区档位徽标，名称来自同一宿主展示身份。
      if(enabled&&key==='hero.headline')return 'AI-Native Team Studio'
      if(enabled&&key==='hero.preview')return applicationProductName(applicationPresentation.getSnapshot().product,locale.getSnapshot().active)
      // 原生持久引用可能已缩放或转为静态帧，不能把它标成未经处理的原图。
      if(enabled&&key==='image.preview')return zh?'图片预览':'Image preview'
      if(enabled&&key==='image.closePreview')return zh?'关闭图片预览':'Close image preview'
      if(enabled&&key==='image.openOriginal')return zh?'查看图片':'View image'
      if(enabled&&key==='image.original')return zh?'图片':'Image'
      if(enabled&&key==='image.openOriginalLabel')return String(params?.label??(zh?'图片':'Image'))+(zh?'，点击查看图片':', view image')
      return native(key,params)
    }
    cached.set(namespace,translated)
    return translated
  }
  locale.bind=bind
  return ()=>{enabled=false;if(locale.bind===bind)locale.bind=original}
}
