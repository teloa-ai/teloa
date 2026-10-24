/**
 * 输入框「下一条建议」的状态机（与 React/DOM 无关，便于直接测）。
 *
 * 对齐 Codex Composer predictions 的三条硬约束：
 * 1. **不按 Tab 就不会使用**——`accept()` 只把文字交给调用方放进草稿，绝不触发发送；
 * 2. **点进输入框就消失**——`focus()` 记下"本条回复已丢弃"，同一条回复不再弹；
 * 3. 建议只属于**当前这条助手回复**——按回复序号绑定，换了一条回复才重新给候选。
 */
import {deriveSuggestionFromAnswer,normalizeSuggestion,shouldShowSuggestion,type SuggestionDecision} from './composer-suggestion.ts'

export type SuggestionState={
 /** 本条回复的候选（已归一）；无候选为 null。 */
 readonly text:string|null
 /** 候选绑定到哪一条助手回复（助手消息事件序号）；未绑定为 null。 */
 readonly answerSeq:number|null
 /** 已被本人丢弃的回复序号集合：同一条回复丢弃后不再弹。 */
 readonly dismissed:readonly number[]
 /** 输入框当前内容（用来判断是否已被本人接管）。 */
 readonly draft:string
 /** 输入框是否聚焦。 */
 readonly focused:boolean
 readonly enabled:boolean
}

export const initialSuggestionState:Omit<SuggestionState,'enabled'>={
 text:null,answerSeq:null,dismissed:[],draft:'',focused:false,
}

export class ComposerSuggestionController{
 private state:SuggestionState
 constructor(enabled:boolean){this.state={...initialSuggestionState,enabled}}
 get snapshot():SuggestionState{return this.state}
 /** 本条回复是否已展示过候选（用来做"同一条回复只算一次"的幂等）。 */
 hasCandidateFor(answerSeq:number):boolean{return this.state.answerSeq===answerSeq}

 /** 助手回复结束：为这条回复给一次候选（已有候选不重算）。 */
 completeAnswer(answerSeq:number,answerText:string):void{
  if(this.state.answerSeq===answerSeq)return
  // 新的一条回复到手：清掉上一次的焦点态，让空输入框能重新出现候选。
  this.state={...this.state,answerSeq,text:normalizeSuggestion(deriveSuggestionFromAnswer(answerText)),focused:false}
 }
 /** 宿主用模型算出的候选：直接写入（仍按回复序号绑定，同一条回复只认首次）。 */
 setCandidate(answerSeq:number,text:string|null):void{
  if(this.state.answerSeq===answerSeq&&this.state.text!==null)return
  this.state={...this.state,answerSeq,text:normalizeSuggestion(text),focused:false}
 }
 /**
  * 输入框内容变化：有内容时候选临时让位（不永久丢弃）。
  * 把内容删回空，同一条回复的候选要重新出现——这与 Codex 的表现一致。
  */
 setDraft(draft:string):void{
  this.state={...this.state,draft}
 }
 /** 聚焦输入框 = 点进输入框：丢弃本条候选。 */
 focus():void{this.dismiss()}
 /** Escape：丢弃本条候选。 */
 escape():void{this.dismiss()}
 blur():void{this.state={...this.state,focused:false}}
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
