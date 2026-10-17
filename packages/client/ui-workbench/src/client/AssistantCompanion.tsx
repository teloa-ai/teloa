import {useEffect,useLayoutEffect,useRef,useState,type ReactNode,type KeyboardEvent,type PointerEvent} from 'react'
import {ChevronUp,EyeOff,ListChecks,MessageCircle,Mic,Minus,Phone,Smile,X} from 'lucide-react'
import standing from '../brand/companion/standing.webp'
import reading from '../brand/companion/reading.webp'
import celebrating from '../brand/companion/celebrating.webp'
import wink from '../brand/companion/wink.webp'
import thinking from '../brand/companion/thinking.webp'
import curious from '../brand/companion/curious.webp'
import cheeky from '../brand/companion/cheeky.webp'
import lyingflat from '../brand/companion/lying-flat.webp'
import mememelon from '../brand/companion/meme-melon.webp'
import {useI18n} from './i18n/provider.js'
import css from './AssistantCompanion.module.css'
import type {AssistantCompanionActivitySnapshot} from './assistant-companion-activity.js'
import {companionInputRegions,companionSafePoint} from './assistant-companion-position.js'
import type {AssistantMiniChatPort} from './assistant-mini-chat.js'
import {AssistantMiniChat} from './AssistantMiniChat.js'

const copy={
 automatic:['自动跟随工作','自動跟隨工作','Follow work automatically'],
 manual:['手动表情','手動表情','Manual expression'],
 activityIdle:['准备好了','準備好了','Ready'],
 activityProcessing:['正在处理','正在處理','Working'],
 activityCompleted:['已完成','已完成','Completed'],
 activityWaiting:['等待继续','等待繼續','Waiting to continue'],
 activityStopped:['已停止','已停止','Stopped'],
 activityFailed:['未能完成','未能完成','Could not complete'],
 activityUnknown:['正在核对状态','正在核對狀態','Checking status'],
 pet:['移动小松鼠，点击发消息','移動小松鼠，點擊發訊息','Move squirrel, click to message'],
 expression:['选择小松鼠表情','選擇小松鼠表情','Choose squirrel expression'],
 appearance:['小松鼠表情','小松鼠表情','Squirrel expressions'],
 voice:['语音留言','語音留言','Voice message'],
 call:['实时通话','即時通話','Voice call'],
 voiceUnavailable:['语音留言暂不可用，媒体服务尚未接通。可以先发文字消息。','語音留言暫不可用，媒體服務尚未接通。可以先發文字訊息。','Voice messages are unavailable until the media service is connected. You can send a text message.'],
 callUnavailable:['实时通话暂不可用，媒体服务尚未接通。可以先发文字消息。','即時通話暫不可用，媒體服務尚未接通。可以先發文字訊息。','Voice calls are unavailable until the media service is connected. You can send a text message.'],
 close:['关闭','關閉','Close'],
 title:['小松鼠助手','小松鼠助理','Squirrel assistant'],
 expand:['展开助手','展開助理','Expand assistant'],
 collapse:['折叠助手','摺疊助理','Collapse assistant'],
 hide:['隐藏助手','隱藏助理','Hide assistant'],
 move:['移动助手，方向键调整位置','移動助理，方向鍵調整位置','Move assistant, use arrow keys to adjust position'],
 conversation:['继续对话','繼續對話','Continue conversation'],
 opening:['正在打开对话','正在開啟對話','Opening conversation'],
 attention:['待你处理','待你處理','Needs you'],
 unknown:['正在核对待处理','正在核對待處理','Checking what needs you'],
 failed:['暂时无法打开原会话，请再试一次。','暫時無法開啟原對話，請再試一次。','Could not open the original conversation. Please try again.'],
} as const

/** 其余语言沿用英文回退；仅维护当前已定稿的三类文案。 */
export function assistantCompanionText(locale:string,key:keyof typeof copy){return copy[key][locale==='zh-CN'?0:locale.startsWith('zh')?1:2]}
type PresentationStorage=Pick<Storage,'getItem'|'setItem'>
const presentationKey='teloa.personal-assistant-presentation/v1'
const poses=[
 {id:'standing',image:standing,label:['站立','站立','Standing']},
 {id:'reading',image:reading,label:['阅读','閱讀','Reading']},
 {id:'celebrating',image:celebrating,label:['庆祝','慶祝','Celebrating']},
 {id:'wink',image:wink,label:['眨眼','眨眼','Winking']},
 {id:'thinking',image:thinking,label:['思考','思考','Thinking']},
 {id:'curious',image:curious,label:['好奇','好奇','Curious']},
 {id:'cheeky',image:cheeky,label:['调皮','調皮','Cheeky']},
 {id:'lying-flat',image:lyingflat,label:['躺平','躺平','Relaxing']},
 {id:'meme-melon',image:mememelon,label:['吃瓜','吃瓜','Watching']},
] as const
function readPresentation(storage?:PresentationStorage){
 try{const value=JSON.parse(storage?.getItem(presentationKey)??'null');if(!value||typeof value!=='object')return null
 const position=value.position&&Number.isFinite(value.position.x)&&Number.isFinite(value.position.y)?{x:value.position.x,y:value.position.y}:null
 return {position,pose:poses.some(item=>item.id===value.pose)?value.pose:'standing',mode:value.mode==='manual'||value.mode!=='auto'&&value.pose&&value.pose!=='standing'?'manual' as const:'auto' as const,collapsed:value.collapsed===true}
 }catch{return null}
}
/** chat 为同一原主聊的小窗端口；缺省时会话图标仍按旧行为打开完整会话。 */
export type AssistantCompanionProps={name?:string;startCall?:(()=>Promise<void>)|undefined;voiceMessage?:ReactNode;activity?:AssistantCompanionActivitySnapshot;storage?:PresentationStorage;active:boolean;setActive:(active:boolean)=>void;openConversation:()=>Promise<void>;chat?:AssistantMiniChatPort|undefined;openAttention:()=>void;needCount:number;attentionKnown:boolean}
type Point={x:number;y:number}
type Drag={pointerId:number;start:Point;origin:Point;moved:boolean}
type Panel='expressions'|'voice'|'call'|'chat'

/** 显示偏好与工作执行分开；组件只引用平台原会话和待处理入口。 */
export function AssistantCompanion({name='Teloa',startCall,voiceMessage,activity={status:'idle',pose:'standing'},storage,active,setActive,openConversation,chat,openAttention,needCount,attentionKnown}:AssistantCompanionProps){
 const {locale,number}=useI18n(),text=(key:keyof typeof copy)=>assistantCompanionText(locale,key)
 const [initial]=useState(()=>readPresentation(storage)),[collapsed,setCollapsed]=useState(initial?.collapsed??false),[pose,setPose]=useState<string>(initial?.pose??'standing'),[mode,setMode]=useState<'auto'|'manual'>(initial?.mode??'auto'),[panel,setPanel]=useState<Panel|null>(null),[position,setPosition]=useState<Point|null>(initial?.position??null),[opening,setOpening]=useState(false),[failed,setFailed]=useState(false)
 const root=useRef<HTMLElement>(null),drag=useRef<Drag|null>(null),openingRef=useRef(false),mounted=useRef(true),suppressClick=useRef(false),panelRef=useRef<HTMLDivElement>(null),panelTrigger=useRef<HTMLButtonElement|null>(null)
 const preferredPosition=useRef<Point|null>(initial?.position??null)
 const [panelHeight,setPanelHeight]=useState(320)
 useLayoutEffect(()=>{
  if(!active||!panel||!panelRef.current)return
  const measure=()=>{const height=panelRef.current?.getBoundingClientRect().height;if(height)setPanelHeight(height)}
  measure();const observer=new ResizeObserver(measure);observer.observe(panelRef.current)
  return()=>observer.disconnect()
 },[active,panel,locale])
 useEffect(()=>{mounted.current=true;return()=>{mounted.current=false}},[])
 useEffect(()=>{try{storage?.setItem(presentationKey,JSON.stringify({position:preferredPosition.current,pose,mode,collapsed}))}catch{}},[storage,position,pose,mode,collapsed])
 useEffect(()=>{if(!active)setPanel(null)},[active])
 // 小窗可见期间才持有原会话读取引用；关闭、收起、隐藏或卸载只释放读取，不停止工作。
 const chatVisible=!!chat&&active&&!collapsed&&panel==='chat'
 useEffect(()=>{if(!chatVisible||!chat)return;chat.open();return()=>chat.close()},[chatVisible,chat])
 useEffect(()=>{if(!active||!panel)return
  // 小窗是持续对话窗口：外部点击不关闭，避免等待回复时被页面操作打断；其余轻面板保持外部点击关闭。
  const dismiss=(event:globalThis.PointerEvent)=>{if(panel!=='chat'&&!root.current?.contains(event.target as Node))setPanel(null)}
  const escape=(event:globalThis.KeyboardEvent)=>{if(event.key==='Escape'&&!event.isComposing&&root.current?.contains(event.target as Node)){event.preventDefault();event.stopPropagation();setPanel(null);panelTrigger.current?.focus()}}
  document.addEventListener('pointerdown',dismiss);document.addEventListener('keydown',escape,true);return()=>{document.removeEventListener('pointerdown',dismiss);document.removeEventListener('keydown',escape,true)}},[active,panel])
 function clamp(point:Point):Point{
  const box=root.current?.getBoundingClientRect(),viewport=window.visualViewport
  const left=viewport?.offsetLeft??0,top=viewport?.offsetTop??0,width=viewport?.width??window.innerWidth,height=viewport?.height??window.innerHeight
  const margin=8,maxX=Math.max(left+margin,left+width-(box?.width??0)-margin),maxY=Math.max(top+margin,top+height-(box?.height??0)-margin)
  return {x:Math.max(left+margin,Math.min(point.x,maxX)),y:Math.max(top+margin,Math.min(point.y,maxY))}
 }
 function move(point:Point,remember=true){
  const bounded=clamp(point),box=root.current?.getBoundingClientRect(),viewport=window.visualViewport
  if(remember)preferredPosition.current=bounded
  const next=box&&root.current?companionSafePoint(bounded,box,{x:viewport?.offsetLeft??0,y:viewport?.offsetTop??0,width:viewport?.width??window.innerWidth,height:viewport?.height??window.innerHeight},companionInputRegions(root.current).map(element=>element.getBoundingClientRect())):bounded
  setPosition(previous=>previous?.x===next.x&&previous.y===next.y?previous:next)
 }
 useLayoutEffect(()=>{
  if(!active||!root.current)return
  let frame=0;const watched=new Set<HTMLElement>()
  const fit=()=>{
   frame=0;const box=root.current?.getBoundingClientRect(),viewport=window.visualViewport;if(!box||!root.current)return
   const regions=companionInputRegions(root.current),current=new Set(regions)
   for(const element of watched)if(!current.has(element)){observer.unobserve(element);watched.delete(element)}
   for(const element of current)if(!watched.has(element)){observer.observe(element);watched.add(element)}
   move(preferredPosition.current??{x:(viewport?.offsetLeft??0)+(viewport?.width??window.innerWidth)-box.width-28,y:(viewport?.offsetTop??0)+(viewport?.height??window.innerHeight)-box.height-28},false)
  }
  const schedule=()=>{if(!frame)frame=requestAnimationFrame(fit)},observer=new ResizeObserver(schedule)
  observer.observe(root.current);fit()
  const mutations=new MutationObserver(records=>{if(records.some(record=>!root.current?.contains(record.target)))schedule()})
  mutations.observe(document.body,{subtree:true,childList:true,attributes:true,attributeFilter:['class','style','hidden','aria-hidden','inert']})
  window.addEventListener('resize',schedule);window.visualViewport?.addEventListener('resize',schedule);window.visualViewport?.addEventListener('scroll',schedule)
  return()=>{observer.disconnect();mutations.disconnect();if(frame)cancelAnimationFrame(frame);window.removeEventListener('resize',schedule);window.visualViewport?.removeEventListener('resize',schedule);window.visualViewport?.removeEventListener('scroll',schedule);drag.current=null}
 },[active,collapsed])
 function beginDrag(event:PointerEvent<HTMLButtonElement>){
  if(!event.isPrimary||event.button!==0)return
  const box=root.current?.getBoundingClientRect();if(!box)return
  event.currentTarget.setPointerCapture(event.pointerId)
  drag.current={pointerId:event.pointerId,start:{x:event.clientX,y:event.clientY},origin:{x:box.x,y:box.y},moved:false};suppressClick.current=false
 }
 function moveDrag(event:PointerEvent<HTMLButtonElement>){
  const current=drag.current;if(!current||current.pointerId!==event.pointerId)return
  const dx=event.clientX-current.start.x,dy=event.clientY-current.start.y
  if(Math.hypot(dx,dy)>5)current.moved=true
  if(current.moved){suppressClick.current=true;setPanel(previous=>previous==='chat'?previous:null);move({x:current.origin.x+dx,y:current.origin.y+dy})}
 }
 function endDrag(event:PointerEvent<HTMLButtonElement>){
  if(drag.current?.pointerId!==event.pointerId)return
  suppressClick.current=drag.current.moved||event.type!=='pointerup';drag.current=null
  if(event.currentTarget.hasPointerCapture(event.pointerId))event.currentTarget.releasePointerCapture(event.pointerId)
 }
 function moveWithKeyboard(event:KeyboardEvent<HTMLButtonElement>){
  const steps:Record<string,Point>={ArrowLeft:{x:-1,y:0},ArrowRight:{x:1,y:0},ArrowUp:{x:0,y:-1},ArrowDown:{x:0,y:1}},step=steps[event.key]
  const box=root.current?.getBoundingClientRect();if(!step||!box)return
  event.preventDefault();event.stopPropagation();const distance=event.shiftKey?40:16
  move({x:box.x+step.x*distance,y:box.y+step.y*distance})
 }
 async function continueConversation(){
  if(openingRef.current)return false
  openingRef.current=true;setOpening(true);setFailed(false)
  try{await openConversation();return true}catch{if(mounted.current)setFailed(true);return false}
  finally{openingRef.current=false;if(mounted.current)setOpening(false)}
 }
 if(!active)return null
 const countKnown=attentionKnown&&Number.isSafeInteger(needCount)&&needCount>=0
 const statusKey=({idle:'activityIdle',processing:'activityProcessing',completed:'activityCompleted',waiting:'activityWaiting',stopped:'activityStopped',failed:'activityFailed',unknown:'activityUnknown'} as const)[activity.status]
 const selected=poses.find(item=>item.id===(mode==='auto'?activity.pose:pose))??poses[0],index=locale==='zh-CN'?0:locale.startsWith('zh')?1:2
 const viewport=window.visualViewport,left=viewport?.offsetLeft??0,top=viewport?.offsetTop??0,width=viewport?.width??window.innerWidth,height=viewport?.height??window.innerHeight
 const panelStyle={left:Math.max(left+8,Math.min(position?.x??left+width-268,left+width-Math.min(240,width-16)-8)),top:Math.max(top+8,Math.min((position?.y??top+height-232)-panelHeight-8,top+height-panelHeight-8))}
 // 小窗不遮挡小松鼠及其控制：依次尝试上方、下方、左侧、右侧；仅极窄视口才在可视区内重叠。
 const box=root.current?.getBoundingClientRect(),pet={x:position?.x??box?.x??left+width-168,y:position?.y??box?.y??top+height-232,width:box?.width??140,height:box?.height??200}
 const chatWidth=Math.min(340,width-16),chatHeight=Math.min(460,height-16),minimum=Math.min(chatHeight,300)
 const clampX=(x:number)=>Math.max(left+8,Math.min(x,left+width-chatWidth-8)),clampY=(y:number,h:number)=>Math.max(top+8,Math.min(y,top+height-h-8))
 const roomAbove=pet.y-top-16,roomBelow=top+height-pet.y-pet.height-16
 const chatStyle=roomAbove>=minimum?{left:clampX(pet.x+pet.width-chatWidth),top:pet.y-8-Math.min(chatHeight,roomAbove),height:Math.min(chatHeight,roomAbove)}
  :roomBelow>=minimum?{left:clampX(pet.x+pet.width-chatWidth),top:pet.y+pet.height+8,height:Math.min(chatHeight,roomBelow)}
  :{left:pet.x-chatWidth-8>=left+8?pet.x-chatWidth-8:pet.x+pet.width+8+chatWidth<=left+width-8?pet.x+pet.width+8:clampX(pet.x+pet.width-chatWidth),top:clampY(pet.y+pet.height-chatHeight,chatHeight),height:chatHeight}
 const pointerProps={onPointerDown:beginDrag,onPointerMove:moveDrag,onPointerUp:endDrag,onPointerCancel:endDrag,onLostPointerCapture:()=>{drag.current=null},onKeyDown:moveWithKeyboard}
 const closePanel=()=>{setPanel(null);panelTrigger.current?.focus()}
 const showPanel=(value:Panel,trigger:HTMLButtonElement)=>{panelTrigger.current=trigger;setPanel(previous=>previous===value?null:value)}
 // 小窗是会话图标、角色和名称的同一入口；未接入端口时保留原完整会话行为。
 const openChat=(trigger:HTMLButtonElement)=>{if(chat){setFailed(false);showPanel('chat',trigger)}else void continueConversation()}
 const clickPet=(event:{currentTarget:HTMLButtonElement})=>{if(suppressClick.current){suppressClick.current=false;return}openChat(event.currentTarget)}
 return <section ref={root} className={css.companion} data-assistant-companion data-collapsed={collapsed} data-activity={activity.status} data-pose-mode={mode} aria-label={text('title')} style={position?{left:position.x,top:position.y,right:'auto',bottom:'auto'}:undefined}>
  {collapsed?<div className={css.collapsed}>
   <button type="button" {...pointerProps} className={css.restore} aria-label={text('expand')} onClick={()=>{if(suppressClick.current){suppressClick.current=false;return}setCollapsed(false)}}>{name}<ChevronUp size={14}/></button>
   <button type="button" className={css.icon} aria-label={text('hide')} onClick={()=>setActive(false)}><EyeOff size={14}/></button>
  </div>:<>
   <div className={css.controls}>
    <button type="button" className={css.icon} aria-label={text('expression')} title={text('expression')} aria-expanded={panel==='expressions'} onClick={event=>showPanel('expressions',event.currentTarget)}><Smile size={14}/></button>
    <button type="button" className={css.icon} aria-label={text('collapse')} title={text('collapse')} onClick={()=>{setPanel(null);setCollapsed(true)}}><Minus size={14}/></button>
    <button type="button" className={css.icon} aria-label={text('hide')} title={text('hide')} onClick={()=>setActive(false)}><EyeOff size={14}/></button>
   </div>
   <button type="button" {...pointerProps} className={css.pet} aria-label={text('pet')} title={mode==='manual'?text('manual')+' · '+text('move'):text('move')} disabled={opening} onClick={clickPet}><img key={selected.id} data-assistant-pet src={selected.image} alt={selected.label[index]} draggable={false}/></button>
   <button type="button" className={css.name} disabled={opening} aria-busy={opening} aria-expanded={chat?panel==='chat':undefined} onClick={event=>openChat(event.currentTarget)}>{name}{opening?<small>{text('opening')}</small>:<span className={css.status} role="status" aria-live="polite">{text(statusKey)}</span>}</button>

   <div className={css.actions}>
    <button type="button" className={css.icon} disabled={opening} aria-label={text('conversation')} title={text('conversation')} aria-haspopup={chat?'dialog':undefined} aria-expanded={chat?panel==='chat':undefined} onClick={event=>openChat(event.currentTarget)}><MessageCircle size={16}/></button>
    <button type="button" className={css.icon} aria-label={text('voice')} title={text('voice')} onClick={event=>showPanel('voice',event.currentTarget)}><Mic size={16}/></button>
    <button type="button" className={css.icon} aria-label={text('call')} title={text('call')} disabled={opening} onClick={event=>{if(!startCall){showPanel('call',event.currentTarget);return}if(openingRef.current)return;openingRef.current=true;setOpening(true);setFailed(false);void startCall().catch(()=>{if(mounted.current)setFailed(true)}).finally(()=>{openingRef.current=false;if(mounted.current)setOpening(false)})}}><Phone size={16}/></button>
    <button type="button" className={css.icon} disabled={!countKnown} aria-label={countKnown?`${text('attention')} · ${number(needCount)}`:text('unknown')} title={countKnown?`${text('attention')} · ${number(needCount)}`:text('unknown')} onClick={openAttention}><ListChecks size={16}/>{countKnown&&needCount>0&&<sup>{number(needCount)}</sup>}</button>
   </div>
  </>}
  {chatVisible&&chat&&<AssistantMiniChat chat={chat} name={name} status={text(statusKey)} style={chatStyle} containerRef={panelRef} openConversation={continueConversation} opening={opening} openFailed={failed} onExpanded={()=>setPanel(null)} onClose={closePanel}/>}
  {panel&&panel!=='chat'&&!collapsed&&<div ref={panelRef} className={css.panel} role="region" aria-label={panel==='expressions'?text('appearance'):text(panel)} style={panelStyle}>
   <header><strong>{panel==='expressions'?text('appearance'):text(panel)}</strong><button type="button" className={css.icon} aria-label={text('close')} onClick={closePanel}><X size={14}/></button></header>
   {panel==='expressions'?<><button type="button" className={css.automatic} aria-pressed={mode==='auto'} onClick={()=>{setMode('auto');closePanel()}}>{text('automatic')}</button><div className={css.poses}>{poses.map(item=><button type="button" key={item.id} aria-label={item.label[index]} aria-pressed={mode==='manual'&&pose===item.id} onClick={()=>{setMode('manual');setPose(item.id);closePanel()}}><img src={item.image} alt="" draggable={false}/><span>{item.label[index]}</span></button>)}</div></>:panel==='voice'&&voiceMessage?voiceMessage:<p role="status">{text(panel==='voice'?'voiceUnavailable':'callUnavailable')}</p>}
  </div>}
  {failed&&!collapsed&&!chatVisible&&<p className={css.error} role="alert">{text('failed')}</p>}
 </section>
}
