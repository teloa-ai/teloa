import {useRef,useState} from 'react'
import type {MarketPluginInstallPreview} from '@teloa/contract'
import type {IndustryPluginInstance} from './industry-plugin-api.js'
import {EnableConfirm,PluginInstallConfirm,PluginPreviewFacts,trustKey,trustNoticeKey} from './PluginInstallConsent.js'
import {useI18n} from './i18n/provider.js'
import {localizeWorkError} from './i18n/errors.js'
import css from './RealSkillInstallations.module.css'

type Props={
 instance:IndustryPluginInstance
 preview:(instanceId:string)=>Promise<MarketPluginInstallPreview>
 install:(instanceId:string,expectedRevision:number,preview:MarketPluginInstallPreview)=>Promise<unknown>
 enable:(instanceId:string,preview:MarketPluginInstallPreview)=>Promise<unknown>
 /** 目录那一层的忙碌态：同一实例上不允许两条写并行。 */
 busy:boolean
}

/**
 * 一次性的世代令牌：`isLatest()` 判定"这一轮是不是还作数"。
 * 双击或乱序到达时，后开始的一轮说了算——单独导出是因为这个仓库里组件测试只有
 * `renderToStaticMarkup`（一次性、不可交互），测不了跨两次异步调用的先后关系，
 * 只能把这条不变量本身抽出来单测。
 */
export function createSequenceGuard(sequence:{current:number}){
 const token=++sequence.current
 return {token,isLatest:()=>token===sequence.current}
}

/**
 * 行业模板插件的安装与启用，与市场路径同一套知情同意：
 * 先看预览（权限摘要逐条、发布者、信任结论三态、完整性摘要），勾选核对后才提交安装；
 * 落到「已安装 · 待启用」再由本人第二次显式启用。
 *
 * 行业模板是第三方内容进入系统的主入口，此前这里只有一个「安装插件」按钮——用户从头到尾
 * 看不到「它会改动什么」。服务端现在也要求「客户端持固定预览提交」，不带预览一律 invalid-input。
 */
export function IndustryPluginInstallControl({instance,preview,install,enable,busy}:Props){
 const {locale,t}=useI18n()
 const [fixed,setFixed]=useState<MarketPluginInstallPreview>()
 const [confirming,setConfirming]=useState(false),[ack,setAck]=useState(false)
 const [pending,setPending]=useState(false),[error,setError]=useState('')
 // 迟到的预览不许盖掉更新一次：点两下「查看将要改动的内容」时，界面必须停在后一次的事实上。
 const sequence=useRef(0)
 // work 拿到 isLatest：迟到的预览必须能认出自己已经不是最新一轮，
 // 不然 setFixed 会不受这把锁约束，先后到达的两次谁晚谁胜，与下面的注释矛盾。
 const run=async(work:(isLatest:()=>boolean)=>Promise<unknown>)=>{
  if(pending||busy)return
  const {isLatest}=createSequenceGuard(sequence)
  setPending(true);setError('')
  try{await work(isLatest)}
  catch(cause){if(isLatest())setError(localizeWorkError(locale,cause))}
  finally{if(isLatest())setPending(false)}
 }
 const locked=pending||busy
 const pendingEnable=instance.state==='pending-enable'
 return <div className={css.sheet} data-industry-plugin-consent={instance.id}>
  {error&&<p role="alert" className={css.error}>{error}</p>}
  {fixed&&<>
   <PluginPreviewFacts value={fixed}/>
   <p>{fixed.trust.status==='rejected'?<span className={css.warn}>{t(trustKey('rejected'))}</span>:t(trustKey(fixed.trust.status))} — {t(trustNoticeKey(fixed.trust.status))}</p>
  </>}
  {instance.state==='needs_install'&&!confirming&&<button type="button" disabled={locked} onClick={()=>void run(async isLatest=>{
   const next=await preview(instance.id)
   if(isLatest()){setFixed(next);setConfirming(true)}
  })}>{fixed?t('market.plugin.install.action.preview'):t('market.industry.saved.installPlugin')}</button>}
  {instance.state==='needs_install'&&confirming&&fixed&&<PluginInstallConfirm preview={fixed} busy={locked} cancel={()=>setConfirming(false)} install={async()=>{
   await run(async()=>{await install(instance.id,instance.revision,fixed);setConfirming(false)})
  }}/>}
  {pendingEnable&&<>
   {!fixed&&<button type="button" disabled={locked} onClick={()=>void run(async isLatest=>{
    const next=await preview(instance.id)
    if(isLatest())setFixed(next)
   })}>{t('market.plugin.install.action.preview')}</button>}
   {fixed&&<EnableConfirm preview={fixed} ack={ack} setAck={setAck} busy={locked} enable={()=>void run(async()=>{await enable(instance.id,fixed);setAck(false)})}/>}
  </>}
 </div>
}
