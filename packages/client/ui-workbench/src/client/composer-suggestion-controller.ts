/**
 * 输入框「下一条建议」的状态机（与 React/DOM 无关，便于直接测）。
 *
 * 对齐 Codex Composer predictions 的三条硬约束：
 * 1. **不按 Tab 就不会使用**——`accept()` 只把文字交给调用方放进草稿，绝不触发发送；
 * 2. **输入时暂隐**——删空后可继续采纳；Escape 主动丢弃后，同一条回复不再弹；
 * 3. 建议只属于**当前这条助手回复**——按回复序号绑定，换了一条回复才重新给候选。
 */
import {normalizeSuggestion,shouldShowSuggestion,type SuggestionDecision} from './composer-suggestion.ts'

export type SuggestionState={
 /** 本条回复的候选（已归一）；无候选为 null。 */
 readonly text:string|null
 /** 候选绑定到哪一条助手回复（助手消息事件序号）；未绑定为 null。 */
 readonly answerSeq:number|null
 /** 已被本人丢弃的回复序号集合：同一条回复丢弃后不再弹。 */
 readonly dismissed:readonly number[]
 /** 输入框当前内容（用来判断是否已被本人接管）。 */
 readonly draft:string
 /** 已采纳或主动丢弃；普通 DOM 聚焦不改变此状态。 */
 readonly focused:boolean
 readonly enabled:boolean
}

export const initialSuggestionState:Omit<SuggestionState,'enabled'>={
 text:null,answerSeq:null,dismissed:[],draft:'',focused:false,
}

export class ComposerSuggestionController{
 private state:SuggestionState
 private settled=false
 constructor(enabled:boolean){this.state={...initialSuggestionState,enabled}}
 get snapshot():SuggestionState{return this.state}

 /** 只登记已完成回复的身份；模型返回前不生成本地模板。 */
 completeAnswer(answerSeq:number):void{
  if(this.state.answerSeq===answerSeq)return
  this.settled=false
  this.state={...this.state,answerSeq,text:null,focused:false}
 }
 clearAnswer():void{this.settled=false;this.state={...this.state,answerSeq:null,text:null}}
 /** 宿主用模型算出的候选：直接写入（仍按回复序号绑定，同一条回复只认首次）。 */
 setCandidate(answerSeq:number,text:string|null):void{
  if(this.state.answerSeq!==answerSeq||this.settled)return
  this.settled=true
  this.state={...this.state,text:normalizeSuggestion(text)}
 }
 /**
  * 输入框内容变化：有内容时候选临时让位（不永久丢弃）。
  * 把内容删回空，同一条回复的候选要重新出现——这与 Codex 的表现一致。
  */
 setDraft(draft:string):void{
  this.state={...this.state,draft}
 }
 /** Escape：丢弃本条候选。 */
 escape():void{this.dismiss()}
 setEnabled(enabled:boolean):void{this.state={...this.state,enabled}}
 /** 丢弃当前候选：按回复序号记住，不再弹。 */
 dismiss():void{
  const seq=this.state.answerSeq
  this.state={...this.state,focused:true,...(seq!==null&&!this.state.dismissed.includes(seq)?{dismissed:[...this.state.dismissed,seq]}:{})}
 }
 /**
  * Tab 采纳：返回要放进草稿的文字并清空候选；**不发送**。
  * 候选不可见时返回 null（这时 Tab 不应该被吃掉）。
  */
 accept():string|null{
  if(this.decision!=='show')return null
  const text=this.state.text
  this.state={...this.state,text:null,focused:true}
  return text
 }
 get decision():SuggestionDecision{
  return shouldShowSuggestion({enabled:this.state.enabled,draft:this.state.draft,focused:this.state.focused,
   dismissedForAnswer:this.state.answerSeq!==null&&this.state.dismissed.includes(this.state.answerSeq),text:this.state.text})
 }
}
