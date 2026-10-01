import {useEffect,useRef,useState} from 'react'
import {Smile} from 'lucide-react'
import {groupReactionEmojis,type GroupReactionActor,type GroupReactionEmoji,type GroupReactionSummary} from '@teloa/contract'
import {returnPanelFocus} from './panel-focus.js'
import {useI18n} from './i18n/provider.js'
import css from './GroupReactionBar.module.css'

const gridColumns=6

/**
 * 十二格表情浮层（固定集合，恒定 groupReactionEmojis 那十二个，无搜索框、无第十三项）。
 * 浮层自带键盘处理：方向键在 6×2 网格内移动、Enter 选中、Esc 关闭；触发按钮是谁由调用方
 * 负责记（本文件里是 GroupReactionBar 的 opener 状态），这里只管 onPick/onClose 两个回调。
 * 格子用 onMouseDown 而不是 onClick——照 SavedComposer 提及候选浮层的先例
 * （SavedCollaborationPage.tsx:399），避免宿主元素失焦先于选中动作把浮层关掉；
 * `aria-activedescendant` 随方向键指向当前 active 格，同一先例的写法。
 * 关闭兜底：`onBlur` 兜住 Tab 移出/点击外部两种情况；配合格子的 `onMouseDown+preventDefault`，
 * 点格子选中不会先触发这条 blur 误关。
 * T13（输入框工具栏）复用同一个浮层。
 */
export function GroupEmojiPicker({onPick,onClose,labelKey}:{onPick:(emoji:GroupReactionEmoji)=>void;onClose:()=>void;labelKey:string}){
 const {t}=useI18n()
 const [active,setActive]=useState(0)
 const list=useRef<HTMLUListElement>(null)
 useEffect(()=>{list.current?.focus({preventScroll:true})},[])
 const move=(delta:number)=>setActive(current=>(current+delta+groupReactionEmojis.length)%groupReactionEmojis.length)
 const optionId=(index:number)=>'group-emoji-option-'+index
 const onKeyDown=(event:React.KeyboardEvent<HTMLUListElement>)=>{
  if(event.key==='Escape'){event.preventDefault();event.stopPropagation();onClose();return}
  if(event.key==='ArrowRight'){event.preventDefault();move(1);return}
  if(event.key==='ArrowLeft'){event.preventDefault();move(-1);return}
  if(event.key==='ArrowDown'){event.preventDefault();move(gridColumns);return}
  if(event.key==='ArrowUp'){event.preventDefault();move(-gridColumns);return}
  if(event.key==='Enter'){event.preventDefault();onPick(groupReactionEmojis[active]!)}
 }
 return <ul ref={list} tabIndex={-1} role="listbox" aria-label={t(labelKey)} aria-activedescendant={optionId(active)} className={css.emojiOptions} onKeyDown={onKeyDown} onBlur={onClose}>
  {groupReactionEmojis.map((emoji,index)=><li key={emoji} id={optionId(index)} role="option" aria-selected={index===active} onMouseDown={(event:React.MouseEvent<HTMLLIElement>)=>{event.preventDefault();onPick(emoji)}}>{emoji}</li>)}
 </ul>
}

/**
 * actorKind==='role' 用岗位名（roleNames 由调用方喂，本组件绝不把 roleId 直接摆上界面）；
 * `roleNames` 没命中时不回退显示 roleId——直接省略这个 actor（调用方把它计入 `+N`）。
 * 'self' 复用既有「本人」词条，不新造一条。
 */
function actorLabel(actor:GroupReactionActor,roleNames:Readonly<Record<string,string>>,t:(key:string,params?:Record<string,string|number>)=>string):string|undefined{
 return actor.actorKind==='self'?t('collaboration.message.selfRole'):roleNames[actor.actorId]
}

/**
 * actors 至多 64 项（契约上限 groupReactionActorsMax），count 可能大于 actors.length；
 * `roleNames` 没命中的 role 也被省略，两种情况都并入同一个「+N」。
 * 姓名之间按 locale 用 `Intl.ListFormat` 拼接（不是写死的中文顿号）；
 * 溢出的人数没有对应的叙述性词条（group.reaction.by 在十一列里恒为「{names}」，是纯透传模板，
 * 溢出提示只能在 names 这个参数值本身里表达），这里用不需要翻译的「+N」数字占位，不新造中文短语。
 */
function actorsTitle(item:GroupReactionSummary,roleNames:Readonly<Record<string,string>>,t:(key:string,params?:Record<string,string|number>)=>string,locale:string):string{
 const known=item.actors.map(actor=>actorLabel(actor,roleNames,t)).filter((name):name is string=>name!==undefined)
 const overflow=item.count-known.length
 const names=new Intl.ListFormat(locale,{type:'conjunction',style:'narrow'}).format(known)
 const list=overflow>0?(names?names+' ':'')+'+'+overflow:names
 const by=t('group.reaction.by',{names:list})
 return item.mine?t('group.reaction.mine')+'\n'+by:by
}

/**
 * 消息下方的表情条：已有的每种表情一个聚合按钮（emoji+计数，自己加过的高亮），
 * 「加表情」按钮唤出十二格浮层挑新的一种。归档群只读：不出现加表情按钮，
 * 聚合按钮仍然可见但整批 disabled——群还看得见历史，但不能再改。
 */
export function GroupReactionBar({messageId,items,archived,onToggle,roleNames}:{messageId:string;items:GroupReactionSummary[];archived:boolean;onToggle:(emoji:GroupReactionEmoji)=>Promise<void>;roleNames:Readonly<Record<string,string>>}){
 const {t,locale}=useI18n()
 const [opener,setOpener]=useState<HTMLElement|null>(null)
 const [error,setError]=useState<string|undefined>(undefined)
 const toggle=async(emoji:GroupReactionEmoji)=>{
  setError(undefined)
  try{await onToggle(emoji)}
  catch{setError(t('group.reaction.failed'))}
 }
 const closePicker=()=>{const previous=opener;setOpener(null);returnPanelFocus(previous,document)}
 return <div className={css.bar} data-message-id={messageId}>
  {items.map(item=><button key={item.emoji} type="button" className={css.chip} aria-pressed={item.mine} disabled={archived} title={actorsTitle(item,roleNames,t,locale)} onClick={()=>{void toggle(item.emoji)}}><span>{item.emoji}</span><span>{item.count}</span></button>)}
  {!archived&&<div className={css.addAnchor}>
   <button type="button" className={css.add} aria-label={t('group.reaction.add')} onClick={(event:React.MouseEvent<HTMLButtonElement>)=>setOpener(event.currentTarget)}><Smile size={14}/></button>
   {opener&&<GroupEmojiPicker labelKey="group.reaction.pick" onPick={emoji=>{closePicker();void toggle(emoji)}} onClose={closePicker}/>}
  </div>}
  {error&&<p className={css.hint} role="alert">{error}</p>}
 </div>
}
