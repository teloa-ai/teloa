import test from 'node:test'
import assert from 'node:assert/strict'
import {mount,nodes} from './market-component-harness.ts'

const content=(node:any):string=>typeof node==='string'?node:node?.children?.map(content).join('')??''
const setup=()=>mount('GroupChannelBindings.tsx',{'./i18n/provider.js':{useI18n:()=>({t:(key:string,params?:{id:string})=>key+(params?.id??'')})}})
const channel={channelId:'slack',kind:'slack',enabled:true,status:{connected:true}}
const bindings=[{channelId:'slack',groupId:'g1',chatId:'current'},{channelId:'slack',groupId:'g2',chatId:'other'}]
async function read(app:any,props:any){app.render('GroupChannelBindings',props);for(const effect of app.effects)effect();await new Promise(resolve=>setImmediate(resolve));return app.render('GroupChannelBindings',props)}

test('渠道只显示当前群绑定和真实连接状态，管理入口复用设置',async()=>{
 const app=setup();let opened=0
 const props={groupId:'g1',context:{api:{channels:async()=>[channel],groups:async()=>bindings},openSettings(){opened++}}}
 const tree=await read(app,props)
 assert.ok(content(tree).includes('current'));assert.ok(!content(tree).includes('other'))
 assert.ok(content(tree).includes('imChannels.status.connected'))
 nodes(tree).find(node=>node.type==='button'&&content(node)==='collaboration.channels.manage')!.props.onClick()
 assert.equal(opened,1)
})

test('禁用和缺失渠道分别显示关闭与未知，不因已有绑定假报连接',async()=>{
 for(const [channels,expected] of [[[{...channel,enabled:false}],'imChannels.status.disabled'],[[],'collaboration.channels.unknown']] as const){
  const app=setup(),tree=await read(app,{groupId:'g1',context:{api:{channels:async()=>channels,groups:async()=>bindings},openSettings(){}}})
  assert.ok(content(tree).includes(expected));assert.ok(!content(tree).includes('imChannels.status.connected'))
 }
})

test('失败与空绑定有下一步，切群不展示旧绑定且旧请求不能覆盖新群',async()=>{
 const app=setup();let resolveOld:(value:any)=>void=()=>{}
 const context={api:{channels:async()=>[channel],groups:()=>new Promise(resolve=>{resolveOld=resolve})},openSettings(){}}
 app.render('GroupChannelBindings',{groupId:'g1',context})
 const cleanup=app.effects[0]!() as ()=>void
 cleanup()
 const tree=await read(app,{groupId:'g2',context:{...context,api:{channels:async()=>[channel],groups:async()=>[]}}})
 assert.ok(content(tree).includes('collaboration.channels.empty'))
 resolveOld(bindings);await new Promise(resolve=>setImmediate(resolve))
 assert.ok(!content(app.render('GroupChannelBindings',{groupId:'g2',context})).includes('current'))
 const failure=await read(setup(),{groupId:'g1',context:{api:{channels:async()=>{throw Error('private raw error')},groups:async()=>[]},openSettings(){}}})
 assert.ok(content(failure).includes('collaboration.channels.failed'));assert.ok(!content(failure).includes('private raw error'))
 assert.ok(nodes(failure).some(node=>node.props['aria-label']==='collaboration.action.refresh'))
})
