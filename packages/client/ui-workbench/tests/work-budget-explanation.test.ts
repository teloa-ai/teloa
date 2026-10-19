import test from 'node:test'
import assert from 'node:assert/strict'
import {existsSync} from 'node:fs'
import {registerHooks} from 'node:module'
import {workBudgetExhaustedCode,readWorkBudgetExhaustedCode} from '@teloa/contract'
import {mount} from './market-component-harness.ts'
import {createWorkBudgetApi} from '../src/client/work-budget-api.ts'
registerHooks({resolve(specifier,context,next){
 if(specifier.startsWith('.')&&specifier.endsWith('.js')&&context.parentURL?.includes('/ui-workbench/src/client/i18n/')){
  const source=new URL(specifier.slice(0,-3)+'.ts',context.parentURL);if(existsSync(source))return next(source.href,context)
 }
 return next(specifier,context)
}})
const errors=await import('../src/client/i18n/errors.ts'),{localizeWorkError}=errors
const {translateMessage}=await import('../src/client/i18n/messages.ts')
const contract=await import('@teloa/contract')
type Node={type:unknown;props:Record<string,any>;children:unknown[]}
const nodes=(node:unknown):Node[]=>node&&typeof node==='object'&&'props' in node?[node as Node,...(node as Node).children.flatMap(nodes)]:[]
const textOf=(node:unknown):string=>typeof node==='string'||typeof node==='number'?String(node):nodes(node).length?(node as Node).children.map(textOf).join(''):''
const locales=['zh-CN','zh-Hant','en'] as const,reasons=['tokens','rounds','concurrent','elapsed'] as const,scopes=['work','owner'] as const

test('会话本轮失败的稳定 code 与请求错误 details 得到同一句本地化说明；畸形 code 不冒充额度原因',()=>{
 for(const reason of reasons)for(const scope of scopes){
  const code=workBudgetExhaustedCode({reason,scope});assert.equal(code,`teloa/budget-exhausted/${reason}/${scope}`);assert.deepEqual(readWorkBudgetExhaustedCode(code),{reason,scope})
  for(const locale of locales){const text=localizeWorkError(locale,{code});assert.equal(text,localizeWorkError(locale,{code:'teloa/budget-exhausted',details:{reason,scope}}));assert.doesNotMatch(text,/teloa\/|\{scope\}/)}
 }
 for(const details of [undefined,{},{reason:'unknown',scope:'work'},{reason:'tokens',scope:'PRIVATE'}])assert.equal(workBudgetExhaustedCode(details),'teloa/budget-exhausted')
 for(const locale of locales){
  assert.equal(localizeWorkError(locale,{code:'teloa/budget-exhausted'}),translateMessage(locale,'planWork.budget.exhausted'))
  for(const code of ['teloa/budget-exhausted/money/owner','teloa/budget-exhausted/tokens/PRIVATE','teloa/budget-exhausted/tokens/owner/x','UNKNOWN'])assert.equal(localizeWorkError(locale,{code}),translateMessage(locale,'error.unknown'),code)
 }
})

test('耗时超额按 24 小时窗口说明自动释放与真实入口，不再称为累计耗时',()=>{
 const expected={'zh-CN':['最近 24 小时','自动释放','“工作额度”'],'zh-Hant':['最近 24 小時','自動釋放','「工作額度」'],en:['last 24 hours','released automatically','“Work limits”']} as const
 for(const locale of locales){
  const text=localizeWorkError(locale,{code:'teloa/budget-exhausted/elapsed/owner'})
  for(const part of expected[locale])assert.ok(text.includes(part),locale+'：'+part)
  assert.ok(text.includes(translateMessage(locale,'planWork.budget.owner')));assert.doesNotMatch(text,/累计耗时|累計耗時|cumulative time/)
  assert.doesNotMatch(translateMessage(locale,'planWork.elapsed'),/累计|累計|Cumulative/)
 }
})

const nativeEntry=(component:unknown)=>({options:{key:'turn-error',priority:0},component})
const renderer=(entries:unknown[])=>({subscribe:()=>()=>{},getSnapshot:()=>entries,isLive:(entry:unknown)=>entries.includes(entry)})
const turnView=()=>mount('BudgetTurnErrorView.tsx',{'@teloa/contract':contract,'./i18n/errors.js':errors,'@deepseek-ai/dsh-client-ui-primitives':{StateDot:function StateDot(){return null}}})

test('本轮额度失败行显示原因与下一步，不显示服务端原文或内部 code；其他本轮失败交回原生 renderer',()=>{
 const view=turnView(),Native=function NativeTurnError(){return null},entries=[nativeEntry(Native)]
 const budget=view.render('BudgetTurnErrorView',{renderer:renderer(entries),node:{data:{seq:9,message:'本次请求超出可用工作额度，请调整额度后继续。',code:'teloa/budget-exhausted/elapsed/owner'}},t:()=>''})
 const text=textOf(budget)
 assert.equal(budget.props.role,'status');assert.ok(text.includes('planWork.budget.turnError'));assert.ok(text.includes(localizeWorkError('en',{code:'teloa/budget-exhausted/elapsed/owner'})))
 assert.doesNotMatch(text,/本次请求超出|teloa\/budget-exhausted/)
 const props={node:{data:{seq:9,message:'Network failed',code:'TRANSPORT'}},t:()=>''},other=view.render('BudgetTurnErrorView',{renderer:renderer(entries),...props})
 assert.equal(other.type,Native,'非额度失败沿用原生展示');assert.deepEqual(other.props,props,'不把 renderer 注入原生组件')
 assert.equal(view.render('BudgetTurnErrorView',{renderer:renderer([]),...props}),null,'原生 renderer 已卸载时不伪造失败行')
})

const policy={maxGoalRounds:32,maxTokens:2_000_000,maxElapsedMs:21_600_000,maxConcurrent:8,maxRetries:3,stagnationRounds:3,money:null}
const view=(over:Record<string,unknown>={})=>({version:1,policy,usedTokens:10,usedRounds:0,concurrent:0,usedElapsedMs:60_000,moneyMinorUnits:null,...over})
async function panel(account:Record<string,unknown>,owner:Record<string,unknown>){
 const budgetAccountId='33333333-3333-4333-8333-333333333333',api=createWorkBudgetApi(async method=>method==='work-budgets/read'?{...view(account),budgetAccountId}:view(owner))
 const mounted=mount('WorkBudgetPanel.tsx',{'@teloa/contract':contract,'./i18n/errors.js':errors}),props={api,budgetAccountId}
 mounted.render('WorkBudgetPanel',props);for(const effect of [...mounted.effects])effect()
 await new Promise(resolve=>setTimeout(resolve,0));return mounted.render('WorkBudgetPanel',props)
}

test('任务页工作额度按当前已达上限的维度与范围展开说明；未达上限不报警',async()=>{
 const owner=await panel({},{usedElapsedMs:21_600_000}),alert=nodes(owner).find(node=>node.props.role==='alert')
 assert.equal(owner.props.open,true,'达到上限时自动展开工作额度');assert.equal(textOf(alert),localizeWorkError('en',{code:'teloa/budget-exhausted/elapsed/owner'}))
 const work=await panel({usedTokens:2_000_000},{usedElapsedMs:21_600_000})
 assert.equal(textOf(nodes(work).find(node=>node.props.role==='alert')),localizeWorkError('en',{code:'teloa/budget-exhausted/tokens/work'}),'职责先于本人，与服务端核对顺序一致')
 const fine=await panel({usedElapsedMs:21_599_999},{concurrent:7})
 assert.equal(fine.props.open,undefined);assert.ok(!nodes(fine).some(node=>node.props.role==='alert'))
})
