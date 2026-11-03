import test from 'node:test'
import assert from 'node:assert/strict'
import {mount,marketProps,nodes} from './market-component-harness.ts'

const customRoute=function CustomMcpConnectionRoute(){return null}
function fixture(catalogId='custom.j07_orders'){
 const calls:string[]=[],api={list:async()=>{calls.push('list');return[]},connect:async()=>{calls.push('connect')}}
 const mounted=mount('MarketPage.tsx',{'./CustomMcpConnectionRoute.js':{CustomMcpConnectionRoute:customRoute}})
 const props={...marketProps({category:'connector',query:''}),marketCatalogApi:{list:async()=>{calls.push('catalog');return{items:[]}}},managedMcpConnectionApi:api,forceCategory:{category:'connector',serial:1},catalogEntryRequest:{catalogId,serial:1}}
 const render=(patch:Record<string,unknown>={})=>mounted.render('TestCatalog',{...props,...patch})
 const settle=(patch:Record<string,unknown>={})=>{render(patch);for(const effect of [...mounted.effects])effect();return render(patch)}
 return {calls,api,render,settle}
}
test('业务配置自定义连接进入原本人连接设置，不按官方资源读取或自动连接',()=>{
 const f=fixture(),node=f.settle(),route=nodes(node).find(row=>row.type===customRoute)
 assert.ok(route);assert.equal(route.props.catalogId,'custom.j07_orders');assert.equal(route.props.api,f.api)
 assert.equal(nodes(node).some(row=>row.props.initialEntryId==='custom.j07_orders'),false);assert.deepEqual(f.calls,[])
 route.props.close();assert.equal(nodes(f.render()).some(row=>row.type===customRoute),false)
 assert.equal(nodes(f.settle()).some(row=>row.type===customRoute),false,'关闭后旧serial不重开')
})
test('官方连接仍进入原官方详情，未读本人自定义连接目录',()=>{
 const f=fixture('teloa.connector.example'),node=f.settle()
 assert.equal(nodes(node).find(row=>row.props.initialEntryId)?.props.initialEntryId,'teloa.connector.example')
 assert.equal(nodes(node).some(row=>row.type===customRoute),false);assert.deepEqual(f.calls,[])
})
test('新的分类请求清除自定义连接路由，隐藏时不消费原请求',()=>{
 const f=fixture();assert.equal(f.settle({visible:false}),null);assert.ok(nodes(f.settle()).some(row=>row.type===customRoute))
 const patch={forceCategory:{category:'skill',serial:2}}
 assert.equal(nodes(f.settle(patch)).some(row=>row.type===customRoute),false)
 assert.equal(nodes(f.settle(patch)).some(row=>row.type===customRoute),false);assert.deepEqual(f.calls,[])
})
