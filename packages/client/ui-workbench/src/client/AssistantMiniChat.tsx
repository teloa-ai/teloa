import {useEffect,useLayoutEffect,useRef,useState,useSyncExternalStore,type CSSProperties,type KeyboardEvent,type RefObject} from 'react'
import {ArrowUp,Maximize2,X} from 'lucide-react'
import icon from '../brand/companion/icon.webp'
import {useI18n} from './i18n/provider.js'
import {MarkdownPreview} from './knowledge-markdown.js'
import css from './AssistantMiniChat.module.css'
import type {AssistantMiniChatMessage,AssistantMiniChatPort} from './assistant-mini-chat.js'

const copy={
 title:['小窗对话','小窗對話','Quick chat'],
 openFull:['打开完整会话','開啟完整對話','Open full conversation'],
 opening:['正在打开完整会话','正在開啟完整對話','Opening full conversation'],
 close:['关闭小窗','關閉小窗','Close quick chat'],
 input:['给 {name} 发消息','給 {name} 傳訊息','Message {name}'],
 send:['发送','傳送','Send'],
 sending:['正在发送','正在傳送','Sending'],
 queued:['排队中，当前回复结束后处理','排隊中，目前回覆結束後處理','Queued until the current reply finishes'],
 streaming:['正在回复','正在回覆','Replying'],
 working:['正在处理…','正在處理…','Working…'],
 interrupted:['回复已中断','回覆已中斷','Reply interrupted'],
 images:['含 {count} 张图片，可在完整会话查看','含 {count} 張圖片，可在完整對話查看','{count} image(s), shown in the full conversation'],
 checking:['正在核对原助手会话…','正在核對原助理對話…','Checking your assistant conversation…'],
 missing:['还没有和 {name} 的主聊。打开完整会话开始第一次对话。','還沒有和 {name} 的主聊。開啟完整對話開始第一次對話。','There is no main chat with {name} yet. Open the full conversation to start.'],
 offline:['本机服务未连接，恢复后会继续显示。草稿已保留。','本機服務未連線，恢復後會繼續顯示。草稿已保留。','The local service is disconnected. The chat resumes when it reconnects; your draft is kept.'],
 loading:['正在载入原对话…','正在載入原對話…','Loading the conversation…'],
 unavailable:['暂时无法读取原对话。','暫時無法讀取原對話。','Could not load the conversation.'],
 retry:['重试','重試','Retry'],
 empty:['这是你和 {name} 的主聊，发条消息开始吧。','這是你和 {name} 的主聊，傳則訊息開始吧。','This is your main chat with {name}. Send a message to start.'],
 older:['加载更早消息','載入更早訊息','Load earlier messages'],
 loadingOlder:['正在加载…','正在載入…','Loading…'],
 waiting:['需要你确认后才能继续，请在完整会话中处理。','需要你確認後才能繼續，請在完整對話中處理。','Waiting for your confirmation. Handle it in the full conversation.'],
 sendFailed:['未发送，草稿已保留，请重试。','未傳送，草稿已保留，請重試。','Not sent. Your draft is kept; try again.'],
 agentFailed:['上一轮未能完成，可在完整会话查看详情。','上一輪未能完成，可在完整對話查看詳情。','The last turn did not finish. See details in the full conversation.'],
 openFailed:['暂时无法打开原会话，请再试一次。','暫時無法開啟原對話，請再試一次。','Could not open the original conversation. Please try again.'],
 kept:['完整会话已有草稿，这里的草稿已保留。','完整對話已有草稿，這裡的草稿已保留。','The full conversation already has a draft, so this draft stays here.'],
} as const
type CopyKey=keyof typeof copy
const localeIndex=(locale:string)=>locale==='zh-CN'?0:locale.startsWith('zh')?1:2

export type AssistantMiniChatProps={
 chat:AssistantMiniChatPort
 name:string
 status:string
 style:CSSProperties
 containerRef:RefObject<HTMLDivElement>
 /** 复用小松鼠原“继续对话”流程；成功返回 true。 */
 openConversation:()=>Promise<boolean>
 opening:boolean
 openFailed:boolean
 /** 完整会话已接管当前草稿后关闭小窗。 */
 onExpanded:()=>void
 onClose:()=>void
}

/** 非模态小窗：同一原主聊的阅读、文字发送与跳到完整会话；审批和工具详情仍在完整会话。 */
export function AssistantMiniChat({chat,name,status,style,containerRef,openConversation,opening,openFailed,onExpanded,onClose}:AssistantMiniChatProps){
 const {locale,number}=useI18n(),index=localeIndex(locale)
 const text=(key:CopyKey,params:Record<string,string>={})=>Object.entries(params).reduce((value,[param,replacement])=>value.replaceAll('{'+param+'}',replacement),copy[key][index] as string)
 const snapshot=useSyncExternalStore(chat.subscribe,chat.getSnapshot,chat.getSnapshot)
 const [kept,setKept]=useState(false)
 const log=useRef<HTMLDivElement>(null),input=useRef<HTMLTextAreaElement>(null),pinned=useRef(true),olderHeight=useRef<number|null>(null)
 const editable=!!snapshot.sessionId&&!snapshot.sending
 const canSend=snapshot.phase==='ready'&&!snapshot.block&&!snapshot.sending&&snapshot.draft.trim()!==''
 const last=snapshot.messages.at(-1),streaming=last?.state==='streaming'
 useEffect(()=>{(input.current&&!input.current.disabled?input.current:containerRef.current)?.focus({preventScroll:true})},[])
 // 身份核验晚于窗口出现时，焦点仍停在窗口本身才移入输入框，不抢用户已移走的焦点。
 useEffect(()=>{if(editable&&document.activeElement===containerRef.current)input.current?.focus({preventScroll:true})},[editable])
 useEffect(()=>{if(!snapshot.draft)setKept(false)},[snapshot.draft])
 useLayoutEffect(()=>{
  const element=log.current;if(!element)return
  if(olderHeight.current!==null){element.scrollTop+=element.scrollHeight-olderHeight.current;olderHeight.current=null;return}
  if(pinned.current)element.scrollTop=element.scrollHeight
 },[snapshot.messages,snapshot.running,snapshot.phase])
 async function expand(){
  if(!await openConversation())return
  const result=chat.handoffDraft()
  if(result==='applied'||result==='empty')onExpanded();else setKept(true)
 }
 function keyDown(event:KeyboardEvent<HTMLTextAreaElement>){
  if(event.key!=='Enter'||event.shiftKey||event.nativeEvent.isComposing||event.keyCode===229)return
  event.preventDefault();if(canSend)void chat.send()
 }
 const message=(row:AssistantMiniChatMessage)=><article key={row.key} className={css.message} data-role={row.role} data-state={row.state}>
  {/* 模型回复按不可信正文渲染：链接加固、远程图片不加载；完整排版与工具卡在完整会话。 */}
  {row.role==='assistant'?<div className={css.markdown}><MarkdownPreview markdown={row.text} images={false}/></div>:<p className={css.bubble}>{row.text}</p>}
  {row.images>0&&<small>{text('images',{count:number(row.images)})}</small>}
  {row.state!=='sent'&&<small>{text(row.state)}</small>}
 </article>
 const body=()=>{
  switch(snapshot.phase){
   case 'ready':return <>
    {snapshot.hasMore&&<button type="button" className={css.older} disabled={snapshot.loadingOlder} onClick={()=>{olderHeight.current=log.current?.scrollHeight??null;void chat.loadOlder()}}>{text(snapshot.loadingOlder?'loadingOlder':'older')}</button>}
    {snapshot.messages.length?snapshot.messages.map(message):<p className={css.state}>{text('empty',{name})}</p>}
    {snapshot.running&&!streaming&&<p className={css.working} role="status">{text('working')}</p>}
   </>
   case 'missing':return <p className={css.state}>{text('missing',{name})}</p>
   case 'unavailable':return <div className={css.state}><p role="alert">{text('unavailable')}</p><button type="button" onClick={()=>chat.open()}>{text('retry')}</button></div>
   case 'offline':return <p className={css.state} role="status">{text('offline')}</p>
   default:return <p className={css.state} role="status">{text(snapshot.phase==='checking'?'checking':'loading')}</p>
  }
 }
 const notice=openFailed?text('openFailed'):kept?text('kept'):snapshot.sendFailed?text('sendFailed'):snapshot.waiting?text('waiting'):snapshot.block??(snapshot.agentFailed?text('agentFailed'):undefined)
 const offerFull=!openFailed&&(snapshot.waiting||snapshot.agentFailed||snapshot.phase==='missing')
 return <div ref={containerRef} className={css.window} role="dialog" aria-modal="false" aria-label={name+' · '+text('title')} tabIndex={-1} style={style} data-assistant-mini-chat data-phase={snapshot.phase}>
  <header className={css.header}>
   <img src={icon} alt="" draggable={false}/>
   <div><strong>{name}</strong><span>{opening?text('opening'):status}</span></div>
   <button type="button" className={css.icon} aria-label={text('openFull')} title={text('openFull')} disabled={opening} onClick={()=>void expand()}><Maximize2 size={14}/></button>
   <button type="button" className={css.icon} aria-label={text('close')} title={text('close')} onClick={onClose}><X size={15}/></button>
  </header>
  <div ref={log} className={css.log} role="log" aria-live="polite" aria-busy={snapshot.phase==='loading'||snapshot.phase==='checking'||streaming} aria-label={text('title')} onScroll={event=>{const element=event.currentTarget;pinned.current=element.scrollHeight-element.scrollTop-element.clientHeight<24}}>{body()}</div>
  {(notice||offerFull)&&<div className={css.notice} role={openFailed||snapshot.sendFailed?'alert':'status'}>{notice&&<p>{notice}</p>}{offerFull&&<button type="button" disabled={opening} onClick={()=>void expand()}>{text('openFull')}</button>}</div>}
  <form className={css.composer} onSubmit={event=>{event.preventDefault();if(canSend)void chat.send()}}>
   <textarea ref={input} rows={1} value={snapshot.draft} disabled={!editable} aria-label={text('input',{name})} placeholder={text('input',{name})} onChange={event=>chat.setDraft(event.currentTarget.value)} onKeyDown={keyDown}/>
   <button type="submit" className={css.send} aria-label={snapshot.sending?text('sending'):text('send')} title={text('send')} disabled={!canSend} aria-busy={snapshot.sending}><ArrowUp size={15}/></button>
  </form>
 </div>
}
