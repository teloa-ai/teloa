import test from 'node:test'
import assert from 'node:assert/strict'
import {mount,nodes} from './market-component-harness.ts'

test('业务补充交办不可用时不能点退回，通用表单原有意见与影响确认仍生效',()=>{
 const app=mount('SecurityDecisionForm.tsx'),props={combined:false,locked:false,classes:{},reasonDraft:{value:'请补充固定证据',change(){}},approve(){},reject(){}}
 const unavailable=app.render('SecurityDecisionForm',{...props,rejectDisabled:true})
 assert.equal(nodes(unavailable).find(n=>n.type==='button'&&n.children.includes('security.reject'))?.props.disabled,true)
 const normal=app.render('SecurityDecisionForm',props)
 assert.equal(nodes(normal).find(n=>n.type==='button'&&n.children.includes('security.reject'))?.props.disabled,false)
 assert.equal(nodes(normal).find(n=>n.type==='button'&&n.children.includes('security.approve'))?.props.disabled,true)
 nodes(normal).find(n=>n.type==='input'&&n.props.type==='checkbox')?.props.onChange({target:{checked:true}})
 assert.equal(nodes(app.render('SecurityDecisionForm',props)).find(n=>n.type==='button'&&n.children.includes('security.approve'))?.props.disabled,false)
})

test('部分退回已保存后只允许按原意见重试，不能再采用或修改固定请求',()=>{
 const app=mount('SecurityDecisionForm.tsx'),tree=app.render('SecurityDecisionForm',{combined:false,locked:false,classes:{},reasonDraft:{value:'固定意见',change(){}},approveDisabled:true,reasonLocked:true,approve(){},reject(){}})
 assert.equal(nodes(tree).find(n=>n.type==='textarea')?.props.disabled,true)
 assert.equal(nodes(tree).find(n=>n.type==='button'&&n.children.includes('security.approve'))?.props.disabled,true)
 assert.equal(nodes(tree).find(n=>n.type==='button'&&n.children.includes('security.reject'))?.props.disabled,false)
})
