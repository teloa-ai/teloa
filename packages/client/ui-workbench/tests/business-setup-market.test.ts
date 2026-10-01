import test from 'node:test'
import assert from 'node:assert/strict'
import {mount,marketProps,nodes} from './market-component-harness.ts'

function fixture(){
 const calls:string[]=[]
 const mounted=mount('MarketPage.tsx')
 const props={...marketProps({category:'connector',query:''}),
  marketCatalogApi:{list:async()=>{calls.push('list');return{items:[]}},add:async()=>{calls.push('add')}},
  managedMcpConnectionApi:{list:async()=>{calls.push('connections');return[]},connect:async()=>{calls.push('connect')}},
  skillSecretsApi:{describe:async()=>[],pending:()=>null},
  forceCategory:{category:'connector',serial:1},
  catalogEntryRequest:{catalogId:'teloa.connector.example',serial:1},
 }
 const render=(patch:Record<string,unknown>={})=>mounted.render('TestCatalog',{...props,...patch})
 const settle=(patch:Record<string,unknown>={})=>{
  render(patch)
  for(const effect of [...mounted.effects])effect()
  return render(patch)
 }
 const detail=(node:unknown)=>nodes(node).find(row=>typeof row.props.initialEntryId==='string')
 return{calls,render,settle,detail}
}

test('正式连接资源首次请求进入真实官方详情，不当成本机内容或自动连接',()=>{
 const f=fixture(),node=f.settle()
 assert.equal(f.detail(node)?.props.initialEntryId,'teloa.connector.example')
 assert.deepEqual(f.calls,[])
})

test('市场隐藏时保留未消费请求，显示后进入该官方详情',()=>{
 const f=fixture()
 assert.equal(f.settle({visible:false}),null)
 assert.equal(f.detail(f.settle())?.props.initialEntryId,'teloa.connector.example')
 assert.deepEqual(f.calls,[])
})

test('同批连接器分类和新详情请求先清旧详情，再进入新目标',()=>{
 const f=fixture();f.settle()
 const node=f.settle({forceCategory:{category:'connector',serial:2},catalogEntryRequest:{catalogId:'teloa.connector.next',serial:2}})
 assert.equal(f.detail(node)?.props.initialEntryId,'teloa.connector.next')
 assert.deepEqual(f.calls,[])
})

test('下一分类请求清除官方详情，旧serial不会复活',()=>{
 const f=fixture();assert.ok(f.detail(f.settle()))
 const patch={forceCategory:{category:'skill',serial:2}}
 const node=f.settle(patch)
 assert.equal(f.detail(node),undefined)
 assert.ok(nodes(node).some(row=>Array.isArray(row.props.kinds)&&row.props.kinds[0]==='skill'))
 assert.equal(f.detail(f.settle(patch)),undefined)
 assert.deepEqual(f.calls,[])
})

test('类别请求同样清技能密钥详情，回到当前分类而不写密钥',()=>{
 const f=fixture(),detail=f.detail(f.settle())
 assert.ok(detail)
 detail.props.openSkillSecrets('example-skill','Example')
 const secret=f.render()
 assert.ok(nodes(secret).some(row=>row.props.skill==='example-skill'))
 const node=f.settle({forceCategory:{category:'skill',serial:2}})
 assert.ok(nodes(node).some(row=>Array.isArray(row.props.kinds)&&row.props.kinds[0]==='skill'))
 assert.equal(nodes(node).some(row=>row.props.skill==='example-skill'),false)
 assert.deepEqual(f.calls,[])
})
