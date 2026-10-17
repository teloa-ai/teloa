import test from 'node:test'
import assert from 'node:assert/strict'
import {mount,nodes} from './market-component-harness.ts'

// 编译实际共用 hook，使用同一种轻量 hooks 容器；不在测试中重写关闭判断。
const sharedDismiss=()=>mount('use-dialog-dismiss.ts').exported

test('共同抽屉关闭只调用离开动作，等待提交时阻止Escape与遮罩关闭',()=>{
 let closes=0
 const app=mount('ContextDrawer.tsx',{'./dialog-focus.js':{openDialog:()=>()=>{}},'./use-dialog-dismiss.js':sharedDismiss()})
 const props={open:true,title:'详情',close:()=>closes++,children:null}
 const tree=app.render('ContextDrawer',props),box={getBoundingClientRect:()=>({left:500,right:1060,top:0,bottom:800})}
 let prevented=0,stopped=0
 const cancel={preventDefault:()=>prevented++,stopPropagation:()=>stopped++}
 tree.props.onCancel(cancel)
 assert.equal(closes,1)
 assert.equal(prevented,1)
 assert.equal(stopped,1)
 const busy=app.render('ContextDrawer',{...props,canClose:false})
 busy.props.onCancel(cancel)
 const outside={target:box,currentTarget:box,clientX:400,clientY:100,pointerId:1,stopPropagation(){}}
 busy.props.onPointerDown(outside);busy.props.onPointerUp(outside)
 assert.equal(closes,1)
 assert.equal(nodes(busy).find(node=>node.type==='button')?.props.disabled,true)
})

test('子对话框的 React cancel 冒泡不属于外层抽屉，不能再关闭外层',()=>{
 let closes=0,prevented=0
 const app=mount('ContextDrawer.tsx',{'./dialog-focus.js':{openDialog:()=>()=>{}},'./use-dialog-dismiss.js':sharedDismiss()})
 const drawer=app.render('ContextDrawer',{title:'详情',close:()=>closes++,children:null})
 drawer.props.onCancel({target:{id:'edit'},currentTarget:{id:'detail'},preventDefault:()=>prevented++,stopPropagation(){}})
 assert.equal(closes,0)
 assert.equal(prevented,0,'子对话框自己决定是否阻止原生关闭')
})

test('共同抽屉遮罩需按下与松开均在外部，打开与关闭复用入口焦点生命周期',()=>{
 let closes=0,opened=0,restored=0
 const app=mount('ContextDrawer.tsx',{'./dialog-focus.js':{openDialog:()=>{opened++;return()=>restored++}},'./use-dialog-dismiss.js':sharedDismiss()})
 const props={title:'详情',close:()=>closes++,children:null}
 const tree=app.render('ContextDrawer',props),cleanup=app.effects[0]?.() as ()=>void
 assert.equal(opened,1);cleanup();assert.equal(restored,1)
 const box={getBoundingClientRect:()=>({left:500,right:1060,top:0,bottom:800})}
 const pointer=(x:number)=>({target:box,currentTarget:box,clientX:x,clientY:100,pointerId:1,stopPropagation(){}})
 tree.props.onPointerDown(pointer(550));tree.props.onPointerUp(pointer(400));assert.equal(closes,0)
 tree.props.onPointerDown(pointer(400));tree.props.onPointerUp(pointer(400));assert.equal(closes,1)
 app.render('ContextDrawer',{...props,open:false});app.effects[0]?.();assert.equal(opened,1)
})
