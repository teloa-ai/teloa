import test from 'node:test'
import assert from 'node:assert/strict'
import {mount,nodes} from './market-component-harness.ts'

test('连接与运行环境直接呈现官方管理正文，不再要求跳转',()=>{
 const page=mount('SettingsShell.tsx')
 const surface={subscribe:()=>()=>{},getSnapshot:()=>()=>({type:'form',props:{'aria-label':'官方配置'},children:[]})}
 const tree=page.render('NativePanelsSettings',{surface})
 assert.ok(nodes(tree).some(node=>node.type==='form'&&node.props['aria-label']==='官方配置'))
 assert.equal(nodes(tree).filter(node=>node.type==='button').length,0)
})
test('运行设置等待拥有者就绪，卸载后不调用失效正文',()=>{
 const page=mount('SettingsShell.tsx')
 const tree=page.render('NativePanelsSettings',{surface:{subscribe:()=>()=>{},getSnapshot:()=>undefined}})
 assert.ok(nodes(tree).some(node=>node.props.role==='status'))
})

test('开发者工具开关以官方已接受值为准，保存期间不乐观改值并阻止重复写入',async()=>{
  function Switch(){}
  const page=mount('SettingsShell.tsx',{'@deepseek-ai/dsh-client-ui-primitives':{Switch}})
  let accepted=false,finish:()=>void=()=>{}
  const writes:boolean[]=[]
  const preference={enabled:{subscribe:()=>()=>{},getSnapshot:()=>accepted},setEnabled:(next:boolean)=>{writes.push(next);return new Promise<void>(resolve=>{finish=()=>{accepted=next;resolve()}})}}
  const props={preference}
  const find=()=>nodes(page.render('DeveloperToolsSettings',props)).find(node=>node.type===Switch)!
  assert.equal(find().props.checked,false)
  const saving=find().props.onChange(true)
  await find().props.onChange(true)
  assert.equal(find().props.disabled,true)
  assert.equal(find().props.checked,false)
  assert.deepEqual(writes,[true])
  finish();await saving
  assert.equal(find().props.disabled,false)
  assert.equal(find().props.checked,true)
  accepted=false
  assert.equal(find().props.checked,false,'外部官方偏好变更在重读后生效')
})

test('开发者工具保存被宿主拒绝后保持官方值，提示错误并可重试',async()=>{
  function Switch(){}
  const page=mount('SettingsShell.tsx',{'@deepseek-ai/dsh-client-ui-primitives':{Switch},'./i18n/errors.js':{localizeWorkError:(_locale:string,cause:Error)=>cause.message}})
  const props={preference:{enabled:{subscribe:()=>()=>{},getSnapshot:()=>false},setEnabled:async()=>{throw Error('保存被拒绝')}}}
  const find=()=>nodes(page.render('DeveloperToolsSettings',props)).find(node=>node.type===Switch)!
  await find().props.onChange(true)
  assert.equal(find().props.checked,false)
  assert.equal(find().props.disabled,false)
  assert.ok(nodes(page.render('DeveloperToolsSettings',props)).some(node=>node.props.role==='alert'&&node.children.includes('保存被拒绝')))
})
