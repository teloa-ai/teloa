import {groupHasSharedArtifactReference,groupSharedResults} from '../src/client/group-result-index.ts'
import * as React from 'react'
import * as groupPanelPreference from '../src/client/group-panel-preference.ts'
import * as groupMessageOverlays from '../src/client/group-message-overlays.ts'
import {groupReadingFixture} from './group-reading-fixture.ts'
import * as groupMessageWindow from '../src/client/group-message-window.ts'
import {twinDraftCopy} from '../src/client/i18n/locales/twin-drafts.ts'

/** 旧消息/输入夹具保留真实投影；成果呈现由 group-work-results.browser.test.ts 真浏览器单独覆盖。 */
export function groupResultFixtureModule(id:string):unknown{
 if(id==='./i18n/locales/twin-drafts.js')return {twinDraftCopy}
 if(id==='./group-message-window.js')return groupMessageWindow
 if(id==='./use-group-reading.js')return groupReadingFixture
 if(id==='./group-panel-preference.js')return groupPanelPreference
 if(id==='./group-message-overlays.js')return groupMessageOverlays
 if(id==='./DetailsMenu.js')return {DetailsMenu:({children,className,menuRef}:any)=>React.createElement('details',{ref:menuRef,className},children)}
 if(id==='./group-result-index.js')return {groupHasSharedArtifactReference,groupSharedResults}
 if(id==='./GroupArtifactPreview.js')return {GroupArtifactPreview:()=>null}
 if(id==='./GroupWorkResults.js')return {GroupWorkResults:()=>null}
 // 消息处理状态的阶段、提示与恢复动作由 group-message-status.browser.test.ts 使用真实组件覆盖。
 if(id==='./GroupMessageStatus.js')return {GroupMessageStatus:()=>null,GroupProgressStatus:()=>null}
 // 旧文件只验父层消息/异步/草稿；资料面板和固定版预览由 group-materials.browser.test.ts 真浏览器覆盖。
 if(id==='./GroupMaterialsPanel.js')return {GroupMaterialsPanel:()=>null}
 // 原工作暂停时的恢复抽屉由 group-continue-paused.browser.test.ts 使用真实组件覆盖。
 if(id==='./GroupWorkResume.js')return {GroupWorkResumeDrawer:()=>null}
 if(id==='./GroupAttachmentPreview.js')return {GroupAttachmentPreview:()=>null}
 if(id==='./GroupResourcePreview.js')return {GroupResourcePreview:()=>null}
 // 完整回复预览由 group-message-body.browser.test.ts 覆盖，旧消息夹具不打开抽屉。
 if(id==='./GroupMessageBodyPreview.js')return {GroupMessageBodyPreview:()=>null}
 // 成员搜索、原单聊和本群授权由 group-members-parity.browser.test.ts 使用真实组件覆盖。
 if(id==='./GroupMembersPanel.js')return {GroupMembersPanel:()=>null}
 // 原消息夹具没有提及读取端口；@我由 group-mentions-integration.browser.test.ts 真组件覆盖。
 if(id==='./GroupMentions.js')return {GroupMentions:()=>{throw Error('未接提及端口的旧消息夹具不应打开提及面板')}}
 // 此边界保留真实的名称、详情与点击端口；共用行的样式/预览归成果浏览器用例核对。
 if(id==='./WorkArtifactCard.js')return {WorkArtifactCard:({label,detail,onPreview}:any)=>React.createElement('article',null,React.createElement('button',{onClick:onPreview,disabled:!onPreview},label),detail)}
 return undefined
}
