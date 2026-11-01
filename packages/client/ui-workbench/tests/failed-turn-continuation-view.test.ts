import test from 'node:test'
import assert from 'node:assert/strict'
import {mount,nodes} from './market-component-harness.ts'
import {draftContinuityCopy} from '../src/client/draft-continuity-copy.ts'

test('真实失败行组件中的继续回答按钮准确标明新续办语义，点击仅调用原seq一次',async()=>{
 const calls:unknown[][]=[],port={subscribe:()=>()=>{},getSnapshot:()=>'',available:(seq:number)=>seq===12,continue:async(...args:unknown[])=>{calls.push(args)}}
 const view=mount('BudgetTurnErrorView.tsx',{'@teloa/contract':{readWorkBudgetExhaustedCode:()=>undefined},'./draft-continuity-copy.js':{draftContinuityCopy}},['ContinueAnswer'])
 const row=view.render('ContinueAnswer',{port,seq:12}),button=nodes(row).find(node=>node.type==='button')!
 assert.ok(button);assert.deepEqual(button.children,['Continue answer']);assert.match(button.props.title,/does not replay/)
 button.props.onClick();await Promise.resolve();assert.deepEqual(calls,[[12,draftContinuityCopy('en','instruction')]])
 assert.equal(view.render('ContinueAnswer',{port,seq:11}),null)
})
