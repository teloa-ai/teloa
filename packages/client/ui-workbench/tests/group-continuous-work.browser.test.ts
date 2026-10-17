import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,writeFile,rm} from 'node:fs/promises'
import {fileURLToPath} from 'node:url'
import {join} from 'node:path'
import {build} from 'vite'
// @ts-expect-error 复用既有无头浏览器加载器。
import {launchOptions,loadPlaywright} from './fixtures/load-playwright.mjs'

// 群连续工作（规格 §5、§6.7）：同一条本人消息下的真实处理状态随原工作事实推进；正式组件在无头 Chrome 中渲染。
test('群动态状态随真实工作推进，成功回帖收起回执，审批停止与未知保留原工作入口',{timeout:30000},async t=>{
 const root=fileURLToPath(new URL('../../../../',import.meta.url)),client=fileURLToPath(new URL('../src/client/',import.meta.url)),temp=await mkdtemp(join(root,'.runtime-group-continuous-work-'))
 t.after(()=>rm(temp,{recursive:true,force:true}))
 await writeFile(join(temp,'fixture.tsx'),`import React from 'react';import {createRoot} from 'react-dom/client';import {flushSync} from 'react-dom';import {GroupMessageStatus,GroupProgressStatus} from '${client}GroupMessageStatus.tsx';import {I18nProvider} from '${client}i18n/provider.tsx';import {translateMessage} from '${client}i18n/messages.ts';
 const view=createRoot(document.getElementById('root')),locale='zh-CN',snapshot={locale,dshLocale:locale,revision:1},runtime={t:(key,params)=>translateMessage(locale,key,params),subscribe:()=>()=>{},getSnapshot:()=>snapshot};
 const recipient=(phase,mode='work')=>({roleId:'11111111-1111-4111-8111-111111111111',name:'跟进员',taskId:'22222222-2222-4222-8222-222222222222',runId:'33333333-3333-4333-8333-333333333333',phase,resultMessageId:null,executionMode:mode});
 const f=window.workFixture={calls:[],archived:false,status:null,render:()=>render()};
 f.set=(phase,extra={})=>{f.status={messageId:'44444444-4444-4444-8444-444444444444',attemptVersion:1,phase,recipients:[recipient(phase,extra.mode)],hintCode:extra.hint??null,canRetry:extra.canRetry??false};render()};
 function render(){flushSync(()=>view.render(<I18nProvider runtime={runtime}><main><textarea aria-label="群讨论消息" defaultValue="未发送的群讨论"/>{f.status&&<GroupMessageStatus status={f.status} archived={f.archived} retrying={false} retryFailed={false} retry={()=>f.calls.push(['retry'])} openTask={taskId=>f.calls.push(['open',taskId])}/>}<div data-n46-progress><GroupProgressStatus statuses={f.status?[f.status]:[]} avatar={()=>null}/></div></main></I18nProvider>))}
 f.set('running');`)
 const result=await build({configFile:false,root,logLevel:'error',define:{'process.env.NODE_ENV':'"development"'},build:{write:false,minify:false,lib:{entry:join(temp,'fixture.tsx'),name:'GroupContinuousWorkTest',formats:['iife']}}})
 const bundle=Array.isArray(result)?result[0]:result;assert.ok(bundle&&'output'in bundle)
 const script=bundle.output.find(item=>item.type==='chunk')!.code,styles=bundle.output.flatMap(item=>item.type==='asset'&&item.fileName.endsWith('.css')?[String(item.source)]:[]).join('\n')
 const browser=await loadPlaywright().chromium.launch(launchOptions());t.after(()=>browser.close())
 const page=await browser.newPage({viewport:{width:1280,height:800}}),errors:string[]=[];t.after(()=>page.close());page.setDefaultTimeout(3000);page.on('pageerror',(error:Error)=>errors.push(error.message));await page.route('**/*',(route:any)=>route.abort())
 await page.setContent('<html lang="zh-CN"><body><div id="root"></div></body></html>');await page.addStyleTag({content:styles});await page.addScriptTag({content:script})
 const status=page.getByRole('status',{name:'处理状态'}),progress=page.locator('[data-n46-progress]'),set=(phase:string,extra:Record<string,unknown>={})=>page.evaluate(([phase,extra]:readonly [string,Record<string,unknown>])=>(window as any).workFixture.set(phase,extra),[phase,extra] as const)
 const calls=()=>page.evaluate(()=>(window as any).workFixture.calls)
 // 处理中：只给查看工作，不给重新安排。
 await progress.getByText('正在处理',{exact:true}).waitFor()
 assert.equal(await status.count(),0,'进行中不再在历史消息下重复状态')
 assert.equal(await status.getByRole('button',{name:'重新安排'}).count(),0)
 // 同一正式组件收到可信交流模式时用回复口径；不伪造逐字输入信号。
 await set('running',{mode:'reply'});await progress.getByText('正在回复…',{exact:true}).waitFor();assert.equal(await progress.getByText('正在处理',{exact:true}).count(),0)
 await set('delivering',{mode:'reply'});await progress.getByText('正在发送回复…',{exact:true}).waitFor();assert.equal(await progress.getByText('正在回复…',{exact:true}).count(),0)
 await set('recorded',{mode:'reply'});assert.equal(await status.count(),0);assert.equal(await progress.innerText(),'')
 // 原 Run 在原生审批处等待本人：状态说明需要确认，入口回到原工作，不在群里代为决定。
 await set('awaiting-approval')
 await status.getByText('需要你确认',{exact:true}).waitFor()
 await status.getByRole('button',{name:'查看工作',exact:true}).click()
 assert.deepEqual(await calls(),[['open','22222222-2222-4222-8222-222222222222']])
 assert.equal(await page.getByLabel('群讨论消息').inputValue(),'未发送的群讨论','打开工作不清空讨论草稿')
 // 本轮原生审批已收敛；任务仍需本人核对结果时不冒充另一张审批卡。
 await set('awaiting-review');await status.getByText('等待你核对结果',{exact:true}).waitFor()
 assert.equal(await status.getByText('需要你确认',{exact:true}).count(),0)
 // 工作完成退出动态提示，查看原工作仍可达，不重复完成回执。
 await set('completed')
 await page.getByRole('button',{name:'查看工作',exact:true}).waitFor()
 assert.equal(await progress.innerText(),'')
 assert.equal(await status.count(),0)
 // 追加续办排队与停止收敛。
 await set('queued');await progress.getByText('已收到，等待回应',{exact:true}).waitFor()
 assert.equal(await progress.getByText(/正在安排/).count(),0,'排队时不显示内部过程文案')
 await set('stopping');await progress.getByText('正在停止',{exact:true}).waitFor()
 await set('stopped',{hint:'work-stopped'})
 await status.getByText('已停止',{exact:true}).waitFor()
 await status.getByText('原工作已停止，不会自动重新开始。',{exact:true}).waitFor()
 assert.equal(await status.getByRole('button',{name:'重新安排'}).count(),0,'停止后不提供重新安排')
 // 提交结果未知：只核对原工作，不能重新选人。
 await set('unknown',{hint:'delivery-unknown'})
 await status.getByText('提交结果暂未确认，正在核对原工作，不会重复安排。',{exact:true}).waitFor()
 assert.equal(await status.getByRole('button',{name:'重新安排'}).count(),0)
 await status.getByRole('button',{name:'查看工作',exact:true}).waitFor()
 // 运行结束而回帖被拒：准确保留原结果，不永远显示交付，也不重新派工。
 await set('publication-blocked',{hint:'result-retained'})
 await status.getByText('结果未发出',{exact:true}).waitFor()
 await status.getByText('结果未能贴回本群，原结果已保留。可查看工作并核对群权限或资料。',{exact:true}).waitFor()
 assert.equal(await progress.innerText(),'')
 assert.equal(await status.getByRole('button',{name:'重新安排'}).count(),0)
 await status.getByRole('button',{name:'查看工作',exact:true}).waitFor()
 assert.equal(await status.getByRole('button',{name:'查看工作',exact:true}).innerText(),'','轻量工作入口用图标并保留可访问名称')
 // 引用资料变化：说明原因，不给内部码。
 await set('blocked',{hint:'source-changed'})
 await status.getByText('引用的资料已变化，请核对后再继续。',{exact:true}).waitFor()
 // 交流回应由原消息内容承载，退出动态提示，不冒称业务工作完成。
 await set('completed',{mode:'reply'})
 await page.getByRole('button',{name:'查看工作',exact:true}).waitFor()
 assert.equal(await progress.innerText(),'')
 assert.equal(await status.count(),0)
 assert.doesNotMatch(await page.locator('main').innerText(),/已回应|已完成|正在输入|teloa\/|[0-9a-f]{8}-[0-9a-f]{4}/)
 // 多位员工的原工作收在一个数量入口，按员工选择仍打开原 taskId；Esc 回到入口。
 await page.evaluate(()=>{const f=(window as any).workFixture,base=f.status.recipients[0];f.status.recipients=[{...base,name:'甲',roleId:'11111111-1111-4111-8111-111111111111',taskId:'77777777-7777-4777-8777-777777777777'},{...base,name:'乙',roleId:'22222222-2222-4222-8222-222222222222',taskId:'88888888-8888-4888-8888-888888888888'}];f.render()})
 const workMenu=page.getByRole('button',{name:'查看 2 项工作',exact:true})
 await workMenu.click();await page.getByRole('menuitem',{name:'查看 乙 的工作',exact:true}).click()
 assert.deepEqual((await calls()).at(-1),['open','88888888-8888-4888-8888-888888888888'])
 assert.equal(await page.getByRole('menuitem').count(),0)
 await workMenu.click();await page.keyboard.press('Escape');assert.equal(await page.getByRole('menuitem').count(),0)
 assert.equal(await workMenu.evaluate((node:HTMLElement)=>node===document.activeElement),true)
 assert.equal(await page.getByLabel('群讨论消息').inputValue(),'未发送的群讨论')
 assert.deepEqual(errors,[])
})
