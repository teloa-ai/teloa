import {useState,type ReactNode} from 'react'
import type {BusinessObjectSnapshot} from '@teloa/contract'
import type {ArtifactApi} from './artifact-api.js'
import type {BusinessTaskApi} from './business-task-api.js'
import type {BusinessRecordApi} from './business-record-api.js'
import {submitTeamDecision,teamDecisionSubject} from './business-team-collaboration.js'
import {AttentionDecisionCard} from './AttentionDecisionCard.js'
import {SecurityDecisionForm} from './SecurityDecisionForm.js'
import type {AttentionItem} from './attention-item.js'
import common from './AttentionDecisionCard.module.css'
import {TaskDetailSection} from './TaskDetailSection.js'
import {ContextDrawer} from './ContextDrawer.js'
import {useI18n} from './i18n/provider.js'
import css from './BusinessTeamCollaboration.module.css'

/** 复用通用决策卡与表单；本人决定、固定成果反馈和补充任务分别保存，不自动启动模型或响应动作。 */
export function BusinessTeamDecision({record,reviewType,scopeName,sourceName,reviewSummary,api,returnWork,reviewContext,note,changeNote,close,changed}:{record:BusinessObjectSnapshot;reviewType:string;scopeName:string;sourceName:string;reviewSummary:string;api:Pick<BusinessRecordApi,'get'|'create'>;returnWork?:{api:Pick<BusinessTaskApi,'create'>;artifacts:Pick<ArtifactApi,'get'|'feedback'>;output:{id:string;version:number};assignee:{roleId:string;expectedVersion:number}}|undefined;reviewContext?:ReactNode;note:string;changeNote:(note:string)=>void;close:()=>void;changed:(record:BusinessObjectSnapshot)=>void}){
 const {locale,dateTime}=useI18n(),zh=locale.startsWith('zh'),hant=zh&&/Hant|TW|HK/i.test(locale),tr=(cn:string,tw:string,en:string)=>zh?hant?tw:cn:en
 const [busy,setBusy]=useState(false),[failed,setFailed]=useState(false),[phase,setPhase]=useState<'idle'|'feedback'|'task'> ('idle')
 const submit=async(choice:'accepted'|'changes',reason:string)=>{if(busy||phase!=='idle'&&choice!=='changes')return;setBusy(true);setFailed(false);try{
  const raw=new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify([record.scope,teamDecisionSubject(record),choice,reason.trim()]))));const hex=[...raw].map(v=>v.toString(16).padStart(2,'0')).join('');const id=hex.slice(0,8)+'-'+hex.slice(8,12)+'-4'+hex.slice(13,16)+'-8'+hex.slice(17,20)+'-'+hex.slice(20,32)
  if(choice==='changes'){
   if(!returnWork)throw Error('补充任务入口未就绪。')
   const current=await api.get({scope:record.scope,type:record.type,id:record.id});if(current.version!==record.version||current.snapshotHash!==record.snapshotHash)throw Error('对象版本已变化。')
   let original=await returnWork.artifacts.get(returnWork.output.id);const version=original.versions.find(v=>v.number===returnWork.output.version),section=version?.sections[0];if(!version||!section||version.source.scope!==record.scope)throw Error('固定成果来源失效。')
   original=await returnWork.artifacts.feedback(original,version.number,section.id,reason.trim(),id);setPhase('feedback')
   const fixed='\n原成果固定版本：'+original.id+'/v'+version.number+'；段落：'+section.id+'\n原段落（固定输入）：\n'+section.text.slice(0,3000)+'\n文件快照：'+JSON.stringify(version.files?.map(f=>({path:f.path,sha256:f.sha256}))??[])
   await returnWork.api.create({requestId:id,reference:{scope:record.scope,type:record.type,id:record.id,version:record.version,snapshotHash:record.snapshotHash},assignee:returnWork.assignee,goal:'[质量退回] 本人审阅后要求补充：'+reason.trim()+fixed+'。只处理该固定候选与明确补充请求；不扩大数据、工具或处置权限。依据不足时准确列出缺口。保留原成果，提交新的待复核交付，不代本人采用或结案。'});setPhase('task')
  }
  const result=await submitTeamDecision(api,record,{reviewType},choice,reason,id);changed(result)
 }catch{setFailed(true)}finally{setBusy(false)}}

 const impact=tr('采用仅保存对此版本的认可。退回将保存原成果反馈，并交给协调员工补充，等待原生执行。两者均不授权规则上线、处置或结案。','採用僅儲存對此版本的認可。退回將儲存原成果回饋，並交予協調員工補充，等待原生執行。兩者均不授權規則上線、處置或結案。','Acceptance records your review of this version. Return saves feedback and assigns scoped follow-up work, pending native execution. Neither authorizes deployment, response actions or closure.')
 const item:AttentionItem={id:'business-review:'+record.id+':'+record.version,kind:'review',source:'business',persistence:'saved',scope:record.scope,title:record.title,occurredAt:record.receivedAt,reason:{kind:'text',text:impact},target:{kind:'business',target:{scope:record.scope,section:'data',objectType:record.type,id:record.id}}}
 return <ContextDrawer padded title={tr('审阅与决定','審閱與決定','Review and decide')} close={close} canClose={!busy}><div className={css.detail}>
  <AttentionDecisionCard embedded id={item.id} item={item} sourceName={sourceName} scopeName={scopeName} occurred={dateTime(record.receivedAt)} request={{title:record.title,targets:[tr('候选版本','候選版本','Candidate version')+' '+record.version]}} summary={record.summary} evidence={reviewSummary?[{kind:'text',title:tr('独立质量意见','獨立品質意見','Independent quality review'),body:reviewSummary,source:sourceName}]:[]} actions={<div className={css.reviewForm}>
   <TaskDetailSection title={tr('查看交付、报告与复核依据','查看交付、報告與覆核依據','Inspect deliverables, report and review evidence')}>{reviewContext}</TaskDetailSection>
   <SecurityDecisionForm rejectDisabled={!returnWork} approveDisabled={phase!=='idle'} reasonLocked={phase!=='idle'} combined={false} locked={busy} classes={{form:common.decision,check:common.check,actions:common.actions}} reasonDraft={{value:note,change:changeNote}} maxReasonLength={1800} labels={{approve:tr('采用此版本研判','採用此版本研判','Accept this version'),reject:tr('退回AI补充','退回AI補充','Request AI changes')}} approve={reason=>{void submit('accepted',reason)}} reject={reason=>{if(returnWork)void submit('changes',reason)}}/>
   {!returnWork&&<p role="status">{tr('补充任务入口尚未就绪，暂不能退回。请从原成果提交反馈。','補充工作入口尚未就緒，暫不能退回。請從原成果提交回饋。','Follow-up assignment is unavailable. Submit feedback from the original output.')}</p>}
   {phase!=='idle'&&<p role="status">{phase==='feedback'?tr('原成果反馈已保存；补充任务待确认。','原成果回饋已儲存；補充工作待確認。','Feedback saved; follow-up task pending confirmation.'):tr('已交办补充任务，等待原生执行。','已交辦補充工作，等待原生執行。','Follow-up task assigned; pending native execution.')}</p>}
   {failed&&<p role="alert">{tr('提交尚未确认。请保留原意见重试，或刷新核对对象版本。相同请求不会重复写入。','提交尚未確認。請保留原意見重試，或重新整理核對物件版本。相同請求不會重複寫入。','Submission unconfirmed. Retry with the same note or refresh to check the version. Identical requests do not duplicate writes.')}</p>}
  </div>}/>
 </div></ContextDrawer>
}
