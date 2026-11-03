import test from 'node:test'
import assert from 'node:assert/strict'
import {existsSync} from 'node:fs'
import {registerHooks} from 'node:module'
import type {PageCreateDraftPreview} from '@teloa/contract'
import {createRolePreview} from '../src/client/page-create-role-preview.ts'
registerHooks({resolve(specifier,context,next){
 if(specifier.endsWith('.js')&&specifier.startsWith('.')&&context.parentURL?.includes('/ui-workbench/src/client/')){
  const source=new URL(specifier.slice(0,-3)+'.ts',context.parentURL)
  if(existsSync(source))return next(source.href,context)
 }
 return next(specifier,context)
}})
const {translateMessage}=await import('../src/client/i18n/messages.ts')

const body={name:'资料核验员',kind:'employee',scopes:['general','research'],duty:'保留原始引号“证据”\n逐份核对',dataScope:'仅合成资料',executionScope:'不得对外发送',skills:['核验技能'],knowledge:['resource-fixed-v1'],responsibility:{triggers:['收到资料'],autonomousActions:['整理引用'],confirmationPoints:Array.from({length:30},(_,i)=>`确认条件 ${i+1}`),escalationRules:['资料冲突时交还本人'],deliveryChecks:['每条结论有来源']},runtimeConfig:{agentPresetId:'standard',model:{provider:'minimax',model:'MiniMax-M3',reasoningEffort:'off'},fallbackModel:{provider:'other',model:'fallback'}}}
const preview={draft:{entity:'role',body:JSON.stringify(body)},fields:[{path:'name',value:'"资料核验员"'}],fieldsTruncated:true,roleReferences:{knowledge:['原件核对规范'],skills:['核验技能']}} as PageCreateDraftPreview
test('员工预览从完整正文显示全部职责、权限与模型，不复用截断路径或 JSON 引号',()=>{
 for(const locale of ['zh-CN','zh-TW','en'] as const){
  const t=(key:Parameters<typeof translateMessage>[1],params?:Record<string,string|number>)=>translateMessage(locale,key,params)
  const result=createRolePreview(preview,t,{general:t('business.scope.general'),research:'研究业务'})
  const value=(key:Parameters<typeof translateMessage>[1])=>result.fields.find(field=>field.path===t(key))?.value
  assert.equal(value('team.form.name'),body.name)
  assert.equal(value('team.form.mission'),body.duty)
  assert.equal(value('team.form.responsibility.confirmationPoints'),body.responsibility.confirmationPoints.join('\n'))
  assert.equal(value('team.form.dataBoundary'),body.dataScope)
  assert.equal(value('team.form.executionBoundary'),body.executionScope)
  assert.equal(value('team.detail.businessScope'),t('business.scope.general')+'\n研究业务')
  assert.equal(value('team.form.materials'),'原件核对规范')
  assert.equal(value('roleModels.primary'),'MiniMax-M3 · minimax · off')
  assert.equal(value('roleModels.fallback'),'fallback · other')
  assert.ok(result.consequences.includes(t('team.form.noGrant')))
  assert.ok(!result.fields.some(field=>/^(?:name|kind|scopes|responsibility)[.\[]?/.test(field.path)))
 }
})
test('员工引用未能核对时不回显标识或把模型输入当可信名称',()=>{
 for(const locale of ['zh-CN','zh-TW','en'] as const){
  const t=(key:Parameters<typeof translateMessage>[1])=>translateMessage(locale,key)
  for(const roleReferences of [undefined,{knowledge:[null],skills:[null]}]){
   const result=createRolePreview({...preview,roleReferences} as PageCreateDraftPreview,t,{})
   const materials=result.fields.find(field=>field.path===t('team.form.materials'))!.value
   const skills=result.fields.find(field=>field.path===t('market.industry.resource.skill'))!.value
   assert.ok(materials.trim());assert.ok(skills.trim())
   assert.doesNotMatch(materials,/resource-fixed-v1/)
   assert.doesNotMatch(skills,/核验技能/)
  }
 }
})
test('员工预览损坏或错实体时失败，不能展示通用字段充当有效确认',()=>{
 const t=(key:Parameters<typeof translateMessage>[1])=>translateMessage('zh-CN',key)
 for(const draft of [{entity:'skill',body:JSON.stringify(body)},{entity:'role',body:'bad json'},{entity:'role',body:JSON.stringify({...body,responsibility:undefined})}])assert.throws(()=>createRolePreview({...preview,draft} as PageCreateDraftPreview,t,{}))
})
