import test from 'node:test'
import assert from 'node:assert/strict'
import {mount,nodes} from './market-component-harness.ts'

function setup(action='rename'){
 const calls:string[]=[],state={ready:true,pending:{},archived:[],copyHistory:[],copies:{},uncertain:[]}
 const management={subscribe:()=>()=>{},getSnapshot:()=>state,rename:async(id:string,title:string)=>{calls.push(`rename:${id}:${title}`)},archive:async(id:string)=>{calls.push(`archive:${id}`)},acknowledgeCopy:()=>{}}
 const props={target:{row:{sessionId:'source'},title:'Original',blank:false,action},running:false,candidates:[],management,title:'Original',changeTitle:(title:string)=>{props.title=title},close:()=>{calls.push('close')},open:async()=>{}}
 const page=mount('ConversationActions.tsx',{'./i18n/errors.js':{localizeWorkError:(_:string,error:Error)=>error.message}})
 return {calls,state,props,render:()=>page.render('ConversationActions',props)}
}
const button=(tree:any,key:string)=>nodes(tree).find(node=>node.type==='button'&&nodes(node).some(item=>item.children.includes(key)))!
const flush=async()=>{await new Promise(resolve=>setImmediate(resolve))}

test('更多入口先呈现三项操作菜单，选择后才进入对应弹框',()=>{
 function ComposerPopover(){}
 const page=mount('ConversationActions.tsx',{'./ComposerPopover.js':{ComposerPopover}}),calls:string[]=[]
 const props={title:'Original',disabled:false,choose:(action:string)=>calls.push(action)}
 let tree=page.render('ConversationActionMenu',props)
 assert.equal(nodes(tree).some(node=>node.props.role==='menuitem'),false)
 nodes(tree).find(node=>node.props['aria-haspopup']==='menu')!.props.onClick()
 tree=page.render('ConversationActionMenu',props)
 assert.equal(nodes(tree).find(node=>node.type===ComposerPopover)!.props.role,'menu')
 const actions=nodes(tree).filter(node=>node.props.role==='menuitem')
 assert.equal(actions.length,3)
 actions[2]!.props.onClick()
 assert.deepEqual(calls,['archive'])
 assert.equal(nodes(page.render('ConversationActionMenu',props)).some(node=>node.props.role==='menuitem'),false)
})

test('目录成果入口只通知原会话读取，关闭菜单且不触发管理写入',()=>{
 function ComposerPopover(){}
 const page=mount('ConversationActions.tsx',{'./ComposerPopover.js':{ComposerPopover}}),calls:string[]=[]
 const props={title:'已有成果的原会话',disabled:false,choose:(action:string)=>calls.push(action),results:()=>calls.push('read-results')}
 let tree=page.render('ConversationActionMenu',props)
 nodes(tree).find(node=>node.props['aria-haspopup']==='menu')!.props.onClick()
 tree=page.render('ConversationActionMenu',props)
 const result=nodes(tree).find(node=>node.props.role==='menuitem'&&nodes(node).some(item=>item.children.includes('shell.artifacts')))!
 assert.ok(result)
 result.props.onClick()
 assert.deepEqual(calls,['read-results'])
 assert.equal(nodes(page.render('ConversationActionMenu',props)).some(node=>node.props.role==='menuitem'),false)
})

test('重命名是独立表单，未修改、空白、处理中都不能提交；成功后关闭',async()=>{
 const s=setup();let tree=s.render()
 assert.equal(button(tree,'workDirectory.rename.save').props.disabled,true)
 assert.equal(nodes(tree).some(node=>node.children.includes('workDirectory.archive.title')),false)
 assert.equal(nodes(tree).some(node=>node.children.includes('source')),false)
 const submit=()=>nodes(tree).find(node=>node.type==='form')!.props.onSubmit({preventDefault(){}})
 submit();await flush();assert.deepEqual(s.calls,[])
 s.props.title='  ';tree=s.render();submit();await flush();assert.deepEqual(s.calls,[])
 s.props.title=' Updated ';tree=s.render();submit();submit();await flush()
 assert.deepEqual(s.calls,['rename:source:Updated','close'])
})

test('副本创建入口保留历史核对闸，不把重命名、归档混在一个表单',()=>{
 const s=setup('copy'),tree=s.render()
 assert.equal(button(tree,'workDirectory.copy.create').props.disabled,true)
 assert.equal(nodes(tree).some(node=>node.type==='form'),false)
 assert.equal(nodes(tree).some(node=>node.children.includes('workDirectory.archive.title')),false)
 assert.equal(nodes(tree).some(node=>node.type==='details'),false)
})
