import test from 'node:test'
import assert from 'node:assert/strict'
import {Context} from '@deepseek-ai/cordis'
import {WORK_CONTEXT_INJECT,requireSidebarRight} from '../src/client/sidebar-right-service.ts'

function provider(toggles:{value:number}){
  return {
    name:'sidebar-right-provider',
    apply(ctx:Context){
      ctx.provide('sidebarRight',{
        isExpanded:()=>true,
        toggleExpanded:()=>{toggles.value++},
      } as never)
    },
  }
}

test('Cordis 拒绝未声明 inject 的 sidebarRight 读取',async t=>{
  const root=new Context(),toggles={value:0};t.after(()=>root.fiber.dispose())
  await root.plugin(provider(toggles))
  await assert.rejects(async()=>{await root.plugin({name:'undeclared-consumer',apply(ctx:Context){requireSidebarRight(ctx)}})},/cannot get property "sidebarRight" without inject/)
  assert.equal(toggles.value,0)
})

test('workContext 在子 fiber 声明 sidebarRight 后可安全取到原生右栏控制面',async t=>{
  const root=new Context(),toggles={value:0};t.after(()=>root.fiber.dispose())
  await root.plugin(provider(toggles))
  assert.ok(WORK_CONTEXT_INJECT.includes('sidebarRight'))
  await root.plugin({name:'declared-consumer',inject:['sidebarRight'],apply(ctx:Context){
    const face=requireSidebarRight(ctx)
    assert.ok(face,'声明过 inject 就该取得到，不该退回 undefined')
    face.toggleExpanded()
  }})
  assert.equal(toggles.value,1)
})
