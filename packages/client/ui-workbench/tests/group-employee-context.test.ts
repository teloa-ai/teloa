import assert from 'node:assert/strict'
import test from 'node:test'
import {mount,nodes} from './market-component-harness.ts'

// 捕捉群内员工详情误走全局员工导航的分支；详情正文仍由平台提供同一装配器。
const Saved=()=>null,ProfileDrawer=()=>null
function fixture(withRenderer=true){
 const navigation:string[]=[],rendered:string[]=[]
 const app=mount('CollaborationPage.tsx',{'./SavedCollaborationPage.js':{SavedCollaborationPage:Saved},'./RoleProfileDrawer.js':{RoleProfileDrawer:ProfileDrawer}})
 const props={visible:true,target:{groupId:'group-a',rootId:'topic-a'},roles:[{id:'role-a',kind:'employee',name:'Mina'}],profileName:'Max',persistence:{api:{}},work:{tasks:[],openTask:()=>{},openRole:(id:string)=>navigation.push(id),...(withRenderer?{renderRole:(id:string,close:()=>void)=>{rendered.push(id);return {type:'employee',props:{close},children:[]}}}:{})}}
 const paint=()=>app.render('CollaborationPage',props)
 const saved=(tree:ReturnType<typeof paint>)=>nodes(tree).find(node=>node.type===Saved)!
 return {app,props,paint,saved,navigation,rendered}
}
test('群内打开员工详情不离开群；关闭只收起详情，原群与话题身份不变',()=>{
 const f=fixture();let tree=f.paint();f.saved(tree).props.work.openRole('role-a');tree=f.paint()
 assert.deepEqual(f.navigation,[],'群内详情不得调用全局员工目录导航')
 const drawer=nodes(tree).find(node=>node.type===ProfileDrawer&&node.props.open);assert.ok(drawer,'员工身份由打开的共用身份抽屉承载')
 assert.equal(drawer.props.title,'Mina');assert.deepEqual(f.rendered,['role-a'])
 assert.deepEqual(f.saved(tree).props.target,{groupId:'group-a',rootId:'topic-a'});assert.equal(f.saved(tree).props.visible,true)
 drawer.props.close();tree=f.paint();assert.equal(nodes(tree).some(node=>node.type===ProfileDrawer&&node.props.open),false,'保留已关闭的身份容器不能继续展示员工详情')
 assert.deepEqual(f.saved(tree).props.target,{groupId:'group-a',rootId:'topic-a'});assert.deepEqual(f.navigation,[])
})
test('切群或离开群视图后不复现上一群的员工抽屉',()=>{
 const f=fixture();let tree=f.paint();f.saved(tree).props.work.openRole('role-a');tree=f.paint()
 f.props.target={groupId:'group-b',rootId:''};tree=f.paint();assert.equal(nodes(tree).some(node=>node.type===ProfileDrawer&&node.props.open),false,'切群当轮即关闭旧群身份，不能等effect之后才隔离');for(const effect of f.app.effects)effect();tree=f.paint()
 assert.equal(nodes(tree).some(node=>node.type===ProfileDrawer&&node.props.open),false)
 f.saved(tree).props.work.openRole('role-a');tree=f.paint();f.props.visible=false;tree=f.paint();for(const effect of f.app.effects)effect();f.props.visible=true;tree=f.paint()
 assert.equal(nodes(tree).some(node=>node.type===ProfileDrawer&&node.props.open),false);assert.deepEqual(f.navigation,[])
})
test('没有平台详情装配器的旧消费方继续使用原明确导航',()=>{
 const f=fixture(false);const tree=f.paint();f.saved(tree).props.work.openRole('role-a')
 assert.deepEqual(f.navigation,['role-a'])
})
