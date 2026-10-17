import test from 'node:test'
import assert from 'node:assert/strict'
import {mount,nodes} from './market-component-harness.ts'
const settle=()=>new Promise(resolve=>setTimeout(resolve,0))
const fixture=(canStart:boolean)=>{
 const conversation={id:'ordinary',sessionId:'ordinary-session',title:'原聊天',status:'ready'},dedicated={...conversation,id:'dedicated',sessionId:'dedicated-session',title:'执行聊天'},calls:unknown[][]=[]
 const app=mount('ObjectConversations.tsx',{'./work-presentation.js':{presentConversations:(rows:any[])=>rows.map(conversation=>({conversation,title:conversation.title,updatedAt:0}))}})
 const work={subscribe:()=>()=>{},getDirectorySnapshot:()=>({rows:[conversation,dedicated]})},management={subscribe:()=>()=>{},getSnapshot:()=>({archived:[]})}
 const render=()=>app.render('ObjectConversations',{object:{kind:'task',id:'task',version:1,canStart},links:[{kind:'task',objectId:'task',objectVersion:1,conversationId:conversation.id,sessionId:conversation.sessionId,sourceOnly:true},{kind:'task',objectId:'task',objectVersion:1,conversationId:dedicated.id,sessionId:dedicated.sessionId}],work,management,useSessions:()=>({}),prepare:async(value:unknown)=>{calls.push(['prepare',value])},open:async(id:string)=>{calls.push(['open',id])},unlink:async(id:string)=>{calls.push(['unlink',id])},link:()=>{calls.push(['link'])},create:()=>{calls.push(['create'])}})
 // 生命周期与真实挂载一致，普通重渲染沿用同一个工作连接。
 render();for(const effect of app.effects)effect()
 const button=(tree:any,label:string)=>nodes(tree).find(node=>node.type==='button'&&(node.props['aria-label']===label||node.children.includes(label)))!
 return {conversation,dedicated,calls,render,button}
}

test('任务创建来源仅打开或解除，专用上下文仍提供准备入口',async()=>{
 const {dedicated,calls,render,button}=fixture(true)
 const rows=nodes(render()).filter(node=>node.type==='li'),sourceButtons=nodes(rows[0]).filter(node=>node.type==='button'),contextButtons=nodes(rows[1]).filter(node=>node.type==='button')
 assert.deepEqual(sourceButtons.map(node=>node.props['aria-label']??node.children.join('')),['原聊天','objectConversations.unlink'],'名称即打开入口，创建来源只有解除')
 assert.deepEqual(contextButtons.map(node=>node.props['aria-label']??node.children.join('')),['执行聊天','objectConversations.prepare','objectConversations.unlink'])
 assert.ok(nodes(rows[0]).some(node=>node.type==='small'&&node.children.includes('objectConversations.source')))
 sourceButtons[0]!.props.onClick();await settle()
 button(render(),'objectConversations.unlink').props.onClick();await settle()
 nodes(nodes(render()).filter(node=>node.type==='li')[1]).find(node=>node.props['aria-label']==='objectConversations.prepare')!.props.onClick();await settle()
 assert.deepEqual(calls,[['open','ordinary-session'],['unlink','ordinary'],['prepare',dedicated]])
})

test('退役对象的关联面板只读：可打开历史，但不能创建、关联、准备或解除',()=>{
 const {render,button}=fixture(false),tree=render(),rows=nodes(tree).filter(node=>node.type==='li')
 for(const label of ['objectConversations.create','objectConversations.link'])assert.equal(button(tree,label).props.disabled,true,label)
 const prepare=nodes(rows[1]).find(node=>node.props['aria-label']==='objectConversations.prepare')!
 assert.equal(prepare.props.disabled,true)
 assert.equal(button(rows[0],'原聊天').props.disabled,false,'打开历史不应受 canStart 限制')
 assert.equal(button(rows[1],'执行聊天').props.disabled,false,'打开历史不应受 canStart 限制')
 assert.equal(button(rows[0],'objectConversations.unlink').props.disabled,false,'创建来源仍可解除')
 assert.equal(button(rows[1],'objectConversations.unlink').props.disabled,true)
 assert.ok(nodes(tree).some(node=>node.type==='p'&&node.children.includes('objectConversations.readOnly')))
})
