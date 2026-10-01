import {test} from 'node:test'
import assert from 'node:assert/strict'
import {mount,marketProps,nodes} from './market-component-harness.ts'

test('市场没有待恢复的导入时不显示存储实现说明',()=>{
 const host=mount('MarketPage.tsx')
 const tree=host.render('TestCatalog',marketProps({category:'industry'}))
 assert.equal(nodes(tree).filter(node=>node.props.className==='contextBar').length,0)
})

test('市场只在导入中断时显示恢复入口并可核对原请求',async()=>{
 const host=mount('MarketPage.tsx');let recovered=0
 const props={...marketProps({category:'industry'}),contentApi:{pending:()=>({requestId:'pending'}),pendingGithubImport:()=>undefined,recover:async()=>{recovered++;throw new Error('offline')}}}
 const tree=host.render('TestCatalog',props)
 const notice=nodes(tree).find(node=>node.props.className==='contextBar')
 assert.ok(notice)
 const button=nodes(notice).find(node=>node.type==='button')
 assert.ok(button)
 button.props.onClick()
 await Promise.resolve()
 assert.equal(recovered,1)
})
