import {useSyncExternalStore} from 'react'
import type {PropsRuntime} from '@deepseek-ai/dsh-client-ui-slots'
import type {SessionEventSource,SessionEventLikeEntry} from '@deepseek-ai/dsh-api-session-controller/client'
import {useI18n} from './i18n/provider.js'
import css from './BusinessBuilderPanel.module.css'
import {EmployeeMentionReplyLabel} from './EmployeeMentionReplyLabel.js'
import {bindEmployeeMentionEventSource} from './employee-mention-presentation.js'

import {readBusinessBuilderPreviewMessage,type BusinessPreviewEvent as Event} from './business-builder-preview-presentation.js'
type Source={sessionId:string;events:Pick<SessionEventSource,'subscribe'|'getSnapshot'>|undefined}
const emptySnapshot={entries:[]},emptySubscribe=()=>()=>{},emptyRead=()=>emptySnapshot

/** 只补充本轮真实署名和宿主回执；答案、推理与图片由原生渲染器及其子插槽完整呈现。 */
export function BusinessBuilderPreviewMessage({source,seq,turn}:PropsRuntime<'conversation.chat.turnTail'>&{source:Source}){
 const events=bindEmployeeMentionEventSource(source.events)
 const snapshot=useSyncExternalStore<{entries:readonly SessionEventLikeEntry[]}>(events?.subscribe??emptySubscribe,events?.getSnapshot??emptyRead,events?.getSnapshot??emptyRead)
 const {t}=useI18n(),entries=snapshot.entries.flatMap(row=>row.type==='event'?[{event:row.event as Event}]:[])
 const answer=entries.find(row=>row.event.seq===seq&&row.event.type==='assistant/message'&&row.event.data.turn===turn.turn)?.event
 const preview=answer?readBusinessBuilderPreviewMessage(source.sessionId,{seq:answer.seq,turn:answer.data.turn,step:answer.data.step,messageId:answer.data.message.id},entries):null
 return <><EmployeeMentionReplyLabel events={source.events} assistantSeq={answer?.seq}/>{preview&&<section className={css.previewMessage} aria-label={t('business.builder.previewStatus')}><p role="status">{t('business.builder.preview.'+preview.state)}</p></section>}</>
}
