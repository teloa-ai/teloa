import type { Translate } from '@deepseek-ai/dsh-client-ui-slots'
import {applicationPresentation,applicationProductName} from './application-presentation.ts'
export type BrandLocale={bind:(namespace:string)=>Translate;getSnapshot:()=>{active:string}}
const taskTeamCopy:Record<string,readonly [string,string]>={
  trigger:['执行小组','Task team'],
  loading:['正在加载执行小组…','Loading task team…'],
  unavailable:['执行小组暂不可用','Task team is unavailable'],
  empty:['尚未建立小组任务清单。','No task checklist has been created for this team.'],
  roster:['负责人和执行助手','Lead and task assistants'],
  tasks:['小组任务','Team tasks'],
  open:['打开执行会话','Open execution conversation'],
  owner:['负责人','Assignee'],
}
/** 适配品牌与产品词汇；继续复用原生组件，不注册重复词典、不更改语言偏好。 */
export function installConversationBrand(locale:BrandLocale):()=>void {
  const original=locale.bind
  let enabled=true
  const cached=new Map<string,Translate>()
  const bind:BrandLocale['bind']=namespace=>{
    const native=original.call(locale,namespace)
    if(namespace!=='conversation'&&namespace!=='agent-team')return native
    const existing=cached.get(namespace)
    if(existing)return existing
    const translated:Translate=(key,params)=>{
      const zh=locale.getSnapshot().active.toLowerCase().startsWith('zh')
      if(!enabled)return native(key,params)
      if(namespace==='agent-team'){
        const copy=taskTeamCopy[key]
        if(copy)return copy[zh?0:1]
        if(key==='failure')return (zh?'执行小组记录暂不可用：':'Task team record is unavailable: ')+String(params?.message??'')
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
