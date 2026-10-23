import assert from 'node:assert/strict'
import test from 'node:test'
import {readFile} from 'node:fs/promises'

// BIZ-008：「待应用」的 AI 团队/员工分享草案卡片详情要有真实的应用（走 template-share acceptance）与放弃（page-create-drafts/settle）。
// 不允许只读卡片，也不允许新增假端点；两个动作都要二次确认、说明影响、失败保留原稿可重试。
const client=(name:string)=>readFile(new URL('../src/client/'+name,import.meta.url),'utf8')

test('分享草案详情提供应用与放弃入口，并二次确认说明影响',async()=>{
 const card=await client('ConversationObjectCard.tsx')
 assert.match(card,/acceptShareDraft/,'应用入口必须接真实 acceptance 端口')
 assert.match(card,/settleShareDraft/,'放弃入口必须接真实草案落定端口')
 assert.match(card,/shareDraftApplyOpen|shareApplyOpen/,'应用需要独立确认态')
 assert.match(card,/shareDraftDiscardOpen|shareDiscardOpen/,'放弃需要独立确认态')
 assert.match(card,/不会发布|does not publish|不發布/,'应用影响说明要包含不发布边界')
 assert.match(card,/不删除|does not delete|不刪除/,'应用影响说明要包含不动原草案边界')
 assert.match(card,/(放弃|Discard)/,'放弃动作文案')
})

test('应用端口调用真实 template-share acceptance，放弃走 page-create-drafts/settle',async()=>{
 const index=await client('index.ts')
 assert.match(index,/createShareAcceptance\(/,'应用必须复用真实分享接收 acceptance')
 assert.match(index,/readPublicCatalogSkill\(/,'公共技能按固定来源解析，不伪造')
 assert.match(index,/settleShareDraft:async[^,]*pageCreateApi\.settle\(/,'放弃必须调用既有草案 settle 端点')
 assert.match(index,/outcome:'discarded'/,'放弃只能落定 discarded')
 assert.match(index,/acceptShareDraft:/,'应用端口接线')
 const card=await client('ConversationObjectCard.tsx')
 assert.match(card,/ports\.acceptShareDraft\(/,'卡片必须真正调用应用端口')
 assert.match(card,/ports\.settleShareDraft\(/,'卡片必须真正调用放弃端口')
})

test('失败保留原稿：应用/放弃失败只在卡片内报错，不关闭详情也不伪造成功',async()=>{
 const card=await client('ConversationObjectCard.tsx')
 assert.match(card,/shareApplyError/,'应用失败要有可读错误')
 assert.match(card,/shareDiscardError/,'放弃失败要有可读错误')
 assert.match(card,/common\.retry|重试|retry/,'失败后保留重试')
 assert.doesNotMatch(card,/skill-installations\/uninstall/,'不新增假端点')
})
