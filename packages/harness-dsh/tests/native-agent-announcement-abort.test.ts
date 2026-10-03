import test, {type TestContext} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp, readFile, rm} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {Context} from '@deepseek-ai/cordis'
import {AgentRegistry, type Agent} from '@deepseek-ai/dsh-agent'
import type {AgentLoop} from '@deepseek-ai/dsh-agent-loop'
import {Session, SessionStore, SessionId, SessionSeq, type SessionEvent} from '@deepseek-ai/dsh-session'
import {SessionProjectionRegistry} from '@deepseek-ai/dsh-session-projection'
import Persistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import {SessionAlreadyOwnedError} from '@deepseek-ai/dsh-session-persistence'
import {LlmRuntime, LlmAdapter, createUserMessage} from '@deepseek-ai/dsh-llm'
import {SystemPrompt} from '@deepseek-ai/dsh-system-prompt'
import {ToolRuntime} from '@deepseek-ai/dsh-tools'
import {patchedNativePackage} from './fixtures/native-patched-package.ts'
import {deferred} from './fixtures/native-subagent-admission.ts'

const options = {timeout: 10000}
const immediate = () => new Promise<void>(resolve => setImmediate(resolve))
const route = {provider: 'announcement-no-model', model: 'never'}
type RestoreLoop = AgentLoop & {installRestoreAdmission(policy: () => Readonly<{assertCurrent(): undefined}>): void}

class NoModel extends LlmAdapter {
 calls = 0
 async resolveModel(provider: string, model: string) {return {provider, id: model, name: model, inputModalities: ['text'] as const}}
 async *stream(): AsyncIterable<never> {this.calls++; throw Error('公告回归禁止模型调用')}
}

/** 完整官方 Registry/Loop 副本；peer override 只连接 helper 已验证的私有副本。 */
async function fixture(t: TestContext, {original = false, persistence = false} = {}) {
 const registry = original ? undefined : await patchedNativePackage<typeof import('@deepseek-ai/dsh-agent')>(t, {
  packageName: '@deepseek-ai/dsh-agent', compatBasename: 'dsh-agent-0.2.0-rc.2-announcement-abort',
 })
 // 独立fixture可用于Loop第三版，也可接入root随后集成的持久层准入补口。
 // 有清单就完整验证并使用真实补口；不为缺失能力模拟openWithAdmission。
 const storageManifest = new URL('../compat/dsh-session-persistence-0.2.0-rc.2-open-admission.json', import.meta.url)
 const storageAvailable = persistence && await readFile(storageManifest).then(() => true, (error: NodeJS.ErrnoException) => {
  if (error.code === 'ENOENT') return false
  throw error
 })
 const storage = storageAvailable ? await patchedNativePackage<typeof import('@deepseek-ai/dsh-session-persistence')>(t, {
  packageName: '@deepseek-ai/dsh-session-persistence', compatBasename: 'dsh-session-persistence-0.2.0-rc.2-open-admission',
 }) : undefined
 const jsonl = storage ? await patchedNativePackage<typeof import('@deepseek-ai/dsh-session-persistence-jsonl')>(t, {
  packageName: '@deepseek-ai/dsh-session-persistence-jsonl', compatBasename: 'dsh-session-persistence-jsonl-0.2.0-rc.2-open-admission',
  overrides: {'@deepseek-ai/dsh-session-persistence': storage.root},
 }) : undefined
 const loopPackage = await patchedNativePackage<typeof import('@deepseek-ai/dsh-agent-loop')>(t, {
  packageName: '@deepseek-ai/dsh-agent-loop', compatBasename: 'dsh-agent-loop-0.2.0-rc.2-work-admission',
  overrides: {...registry ? {'@deepseek-ai/dsh-agent': registry.root} : {}, ...storage ? {'@deepseek-ai/dsh-session-persistence': storage.root} : {}},
 })
 const ctx = new Context(), root = await mkdtemp(join(tmpdir(), 'teloa-agent-announcement-')), model = new NoModel()
 t.after(async () => {await ctx.fiber.dispose(); assert.equal(model.calls, 0); await rm(root, {recursive: true, force: true})})
 for (const plugin of [LlmRuntime, SessionStore, SessionProjectionRegistry, SystemPrompt, ToolRuntime, registry?.namespace.AgentRegistry ?? AgentRegistry]) await ctx.plugin(plugin)
 ctx.llm.registerAdapter([route.provider], model)
 if (persistence) await ctx.plugin(jsonl?.namespace.default ?? Persistence, {root, compression: 'none'})
 const mount = async () => {
  const fiber = ctx.plugin(loopPackage.namespace.AgentLoop, {agents: [], ...(persistence ? {requireRestoreAdmission: true} : {})})
  await fiber
  const loop = ctx.agentLoop as RestoreLoop
  if (persistence) loop.installRestoreAdmission(() => Object.freeze({assertCurrent() {return undefined}}))
  return {fiber, loop}
 }
 const mounted = await mount()
 const store = Reflect.get(ctx, 'sessions') as unknown as SessionStore
 return {ctx, store, root, model, mount, OwnedError: storage?.namespace.SessionAlreadyOwnedError ?? SessionAlreadyOwnedError, ...mounted}
}

/** 通过公开 setup 获得真实且未发布的 Loop Agent；不访问 Registry/Loop 私有字段。 */
async function unpublished(f: Awaited<ReturnType<typeof fixture>>, id: string, operation: (agent: Agent) => Promise<void>) {
 const finished = Error('unpublished registry probe finished')
 await assert.rejects(f.ctx.agents.create({sessionId: SessionId(id), agentOptions: route,
  setup: async (_ctx, agent) => {await operation(agent); throw finished},
 }), error => error === finished)
}

for (const original of [true, false]) test(`${original ? '原版' : '补口'}无signal保留Free串行等待与延迟detach`, options, async t => {
 const f = await fixture(t, {original}), gate = deferred<undefined>(), entered = deferred<void>()
 let later = 0, disposed = 0
 f.ctx.on('agent/created', () => {entered.resolve(); return gate.promise})
 f.ctx.on('agent/created', () => {later++; return undefined})
 f.ctx.on('agent/disposed', () => {disposed++})
 await unpublished(f, 'free-announcement', async agent => {
  const detach = f.ctx.agents.enter(agent, undefined), announcing = f.ctx.agents.announce(agent, 'startup')
  await entered.promise; detach(); await immediate()
  assert.equal(f.ctx.agents.get(agent.id), agent); assert.equal(later, 0); assert.equal(disposed, 0)
  gate.resolve(undefined); await announcing
  assert.equal(later, 1); assert.equal(disposed, 1); assert.equal(f.ctx.agents.get(agent.id), undefined)
  detach(); assert.equal(disposed, 1)
 })
})

test('pre-aborted signal不派发、不发disposed并释放未公告条目；错误identity不能删除live entry', options, async t => {
 const f = await fixture(t), controller = new AbortController(), reason = Error('already canceled')
 controller.abort(reason)
 let created = 0, disposed = 0
 f.ctx.on('agent/created', () => {created++; return undefined})
 f.ctx.on('agent/disposed', () => {disposed++})
 await unpublished(f, 'pre-aborted', async old => {
  const oldDetach = f.ctx.agents.enter(old, undefined)
  await assert.rejects(f.ctx.agents.announce(old, 'startup', controller.signal), error => error === reason)
  assert.equal(f.ctx.agents.get(old.id), undefined); assert.equal(created, 0); assert.equal(disposed, 0)
  await unpublished(f, old.id, async replacement => {
   const detach = f.ctx.agents.enter(replacement, undefined)
   await assert.rejects(f.ctx.agents.announce(old, 'startup', controller.signal), /not live/)
   oldDetach(); assert.equal(f.ctx.agents.get(old.id), replacement)
   await f.ctx.agents.announce(replacement, 'startup', new AbortController().signal)
   detach(); assert.equal(created, 1); assert.equal(disposed, 1)
  })
 })
})

for (const explicit of [false, true]) for (const failure of ['throw', 'reject'] as const) {
 test(`${explicit ? '显式signal' : '无signal'} listener ${failure}停止后续且保留原始错误`, options, async t => {
  const f = await fixture(t), reason = Error('listener failed')
  let later = 0, disposed = 0
  f.ctx.on('agent/created', () => {if (failure === 'throw') throw reason; return Promise.reject(reason)})
  f.ctx.on('agent/created', () => {later++; return undefined})
  f.ctx.on('agent/disposed', () => {disposed++})
  await unpublished(f, 'listener-failure', async agent => {
   const detach = f.ctx.agents.enter(agent, undefined)
   await assert.rejects(f.ctx.agents.announce(agent, 'startup', explicit ? new AbortController().signal : undefined), error => error === reason)
   assert.equal(later, 0); assert.equal(f.ctx.agents.get(agent.id), explicit ? undefined : agent)
   assert.equal(disposed, explicit ? 1 : 0); detach(); assert.equal(disposed, 1)
  })
 })
}

for (const window of ['dispatch', 'listener', 'microtask'] as const) test(`${window}重入abort阻止后续派发`, options, async t => {
 const f = await fixture(t), controller = new AbortController(), reason = Error('reentrant abort')
 let first = 0, later = 0, disposed = 0
 if (window === 'dispatch') f.ctx.on('internal/dispatch', (_type, name) => {if (name === 'agent/created') controller.abort(reason)})
 f.ctx.on('agent/created', () => {
  first++
  if (window === 'microtask') {queueMicrotask(() => controller.abort(reason)); return undefined}
  controller.abort(reason)
  // 同步abort之后返回reject仍须被消费，不能产生unhandled rejection。
  return Promise.reject(reason)
 })
 f.ctx.on('agent/created', () => {later++; return undefined})
 f.ctx.on('agent/disposed', () => {disposed++})
 await unpublished(f, 'reentrant-abort', async agent => {
  const detach = f.ctx.agents.enter(agent, undefined)
  await assert.rejects(f.ctx.agents.announce(agent, 'startup', controller.signal), error => error === reason)
  await immediate(); assert.equal(first, window === 'dispatch' ? 0 : 1); assert.equal(later, 0)
  assert.equal(f.ctx.agents.get(agent.id), undefined); assert.equal(disposed, 1); detach(); assert.equal(disposed, 1)
 })
})

test('显式signal复用Cordis作用域、receiver、顺序及bail；成功后abort不删除live Agent', options, async t => {
 const f = await fixture(t), controller = new AbortController(), calls: string[] = []
 let dispatchedReceiver: unknown
 f.ctx.on('internal/dispatch', (mode, name, _args, receiver) => {
  if (name === 'agent/created') {assert.equal(mode, 'serial'); dispatchedReceiver = receiver}
 })
 await unpublished(f, 'scope-a', async agent => {
  await unpublished(f, 'scope-b', async other => {
   other.ctx.on('agent/created', () => {calls.push('wrong-scope'); return undefined})
   agent.ctx.on('agent/created', function () {assert.equal(this, dispatchedReceiver); calls.push('scoped'); return undefined})
   // 事件声明通常只返回undefined；这里直接核对官方serial公开的bail规则。
   for (const [name, value] of [['null', null], ['false', false], ['zero', 0]] as const) {
    f.ctx.on('agent/created', (() => {calls.push(name); return value}) as never)
   }
   f.ctx.on('agent/created', () => {calls.push('after-bail'); return undefined})
   const detach = f.ctx.agents.enter(agent, undefined)
   await f.ctx.extend().agents.announce(agent, 'startup', controller.signal)
   assert.deepEqual(calls, ['scoped', 'null', 'false', 'zero'])
   controller.abort(Error('after success')); await immediate()
   assert.equal(f.ctx.agents.get(agent.id), agent); detach()
  })
 })
})

for (const late of ['resolve', 'reject'] as const) test(`abort释放exact entry；late ${late}及旧detach不删除同步重入的同id replacement`, options, async t => {
 const f = await fixture(t), gate = deferred<undefined>(), entered = deferred<void>(), controller = new AbortController()
 const reason = Error('cancel old announcement'), disposed: Agent[] = [], later: Agent[] = []
 await unpublished(f, 'same-id', async old => {
  await unpublished(f, old.id, async replacement => {
   f.ctx.on('agent/created', ({agent}) => {if (agent === old) {entered.resolve(); return gate.promise} return undefined})
   f.ctx.on('agent/created', ({agent}) => {later.push(agent); return undefined})
   let detachReplacement: (() => void) | undefined
   f.ctx.on('agent/disposed', ({agent}) => {
    disposed.push(agent)
    if (agent === old) detachReplacement = f.ctx.agents.enter(replacement, undefined)
   })
   const oldDetach = f.ctx.agents.enter(old, undefined)
   const rejected = assert.rejects(f.ctx.agents.announce(old, 'startup', controller.signal), error => error === reason)
   await entered.promise; oldDetach(); controller.abort(reason)
   // 首listener仍悬挂，abort调用栈中已经移除old并允许重入replacement。
   assert.equal(f.ctx.agents.get(old.id), replacement); await rejected
   await f.ctx.agents.announce(replacement, 'startup', new AbortController().signal)
   if (late === 'resolve') gate.resolve(undefined); else gate.reject(Error('late rejection'))
   await immediate(); oldDetach()
   assert.equal(f.ctx.agents.get(old.id), replacement); assert.deepEqual(later, [replacement]); assert.deepEqual(disposed, [old])
   await assert.rejects(f.ctx.agents.announce(old, 'startup', controller.signal), /not live/)
   detachReplacement!(); assert.deepEqual(disposed, [old, replacement])
  })
 })
})

async function seed(f: Awaited<ReturnType<typeof fixture>>) {
 const id = SessionId('cold-announcement'), messages = ['next-turn', 'next-step'].map(target => createUserMessage({
  source: {kind: 'user', rpcId: target}, content: [{type: 'text', text: 'persisted ' + target}],
 }))
 const events: SessionEvent[] = messages.map((message, index) => ({type: 'agent/inbox/spliced', seq: SessionSeq(index), time: 1,
  data: {target: index === 0 ? 'next-turn' : 'next-step', start: 0, removedCount: 0, inserted: [message]},
 }))
 events.push({type: 'turn/start', seq: SessionSeq(2), time: 2, data: {turn: 1}}, {type: 'step/start', seq: SessionSeq(3), time: 3, data: {turn: 1, step: 1}})
 const session = Session.create(id, events), writer = await f.ctx.sessionPersistence.create(session.header)
 await writer.append(session.snapshotEvents()); await writer.flush(); await writer.close()
 return {id, session, messages}
}

for (const cause of ['caller', 'owner', 'factory'] as const) for (const late of ['never', 'resolve', 'reject'] as const) {
 test(`真实JSONL ${cause}取消悬挂公告：未settle即清Registry/Session/writer并同id恢复；late ${late}无复活`, options, async t => {
  const f = await fixture(t, {persistence: true}), cold = await seed(f)
  const ownerReady = deferred<Context>(), owner = f.ctx.plugin({inject: ['agents'], apply(ctx: Context) {ownerReady.resolve(ctx)}})
  const ownerCtx = await ownerReady.promise, gate = deferred<undefined>(), entered = deferred<Agent>(), controller = new AbortController()
  let old: Agent | undefined, observedSignal: AbortSignal | undefined
  const later: Agent[] = [], disposed: Agent[] = []
  f.ctx.on('agent/created', ({agent, signal}) => {
   if (old === undefined) {old = agent; observedSignal = signal; entered.resolve(agent); return gate.promise}
   return undefined
  })
  f.ctx.on('agent/created', ({agent}) => {later.push(agent); return undefined})
  f.ctx.on('agent/disposed', ({agent}) => {disposed.push(agent)})
  const pending = ownerCtx.agents.resume({resumeSessionId: cold.id, agentOptions: route, signal: controller.signal})
  const rejected = assert.rejects(pending, /cancel announcement|owner disposed|not active|lifecycle disposed/)
  const original = await entered.promise
  assert.equal(f.ctx.agents.get(cold.id), original); assert.equal(f.store.get(cold.id), original.session)
  await assert.rejects(f.ctx.sessionPersistence.open(cold.id, 'write'), f.OwnedError)
  const disposing = cause === 'owner' ? owner.dispose() : cause === 'factory' ? f.fiber.dispose() : undefined
  if (cause === 'caller') controller.abort(Error('cancel announcement'))
  await rejected; await disposing
  // 关键断言全部先于任何gate.resolve/reject；never分支始终不结算listener。
  assert.equal(observedSignal?.aborted, true); assert.equal(f.ctx.agents.get(cold.id), undefined)
  assert.equal(f.store.get(cold.id), undefined); assert.deepEqual(later, []); assert.deepEqual(disposed, [original])
  const writer = await f.ctx.sessionPersistence.open(cold.id, 'write'), {events} = await writer.read()
  await writer.close()
  assert.deepEqual(events.slice(0, cold.session.snapshotEvents().length), cold.session.snapshotEvents())
  assert.equal(events.filter(event => event.type === 'agent/inbox/spliced' && (event.data.removedCount ?? 0) > 0).length, 0)
  assert.equal(events.filter(event => event.type === 'turn/end' && event.data.reason.kind === 'interrupted').length, 1)
  // factory卸载会移除投影定义；新factory仍在同一隔离宿主中重试同一持久id。
  if (cause === 'factory') await f.mount()
  const carrier = Session.create(cold.id, events, cold.session.header), inbox = f.ctx.sessionProjections.stateOf(carrier, 'inbox')!
  assert.deepEqual(inbox['next-turn'], [cold.messages[0]]); assert.deepEqual(inbox['next-step'], [cold.messages[1]])
  const retry = await f.ctx.agents.resume({resumeSessionId: cold.id, agentOptions: route})
  assert.notEqual(retry.agent, original); assert.equal(f.ctx.agents.get(cold.id), retry.agent)
  assert.equal(f.store.get(cold.id), retry.agent.session)
  if (late === 'resolve') gate.resolve(undefined)
  if (late === 'reject') gate.reject(Error('late listener rejection'))
  await immediate()
  assert.equal(f.ctx.agents.get(cold.id), retry.agent); assert.equal(f.store.get(cold.id), retry.agent.session)
  assert.deepEqual(later, [retry.agent]); assert.deepEqual(disposed, [original]); assert.equal(f.model.calls, 0)
  assert.deepEqual(retry.agent.inbox.nextTurn.map(message => message.id), [cold.messages[0]!.id])
  assert.deepEqual(retry.agent.inbox.nextStep.map(message => message.id), [cold.messages[1]!.id])
  await assert.rejects(f.ctx.sessionPersistence.open(cold.id, 'write'), f.OwnedError)
  await assert.rejects(f.ctx.agents.announce(original, 'resume', observedSignal), /not live/)
  await retry.dispose()
 })
}

for (const failure of ['throw', 'reject'] as const) test(`真实JSONL公告${failure}清理后保留双Inbox并可重试`, options, async t => {
 const f = await fixture(t, {persistence: true}), cold = await seed(f), reason = Error('cold announcement failed')
 let failing = true, later = 0
 f.ctx.on('agent/created', () => {
  if (!failing) return undefined
  if (failure === 'throw') throw reason
  return Promise.reject(reason)
 })
 f.ctx.on('agent/created', () => {later++; return undefined})
 await assert.rejects(f.ctx.agents.resume({resumeSessionId: cold.id, agentOptions: route}), error => error === reason)
 assert.equal(f.ctx.agents.get(cold.id), undefined); assert.equal(f.store.get(cold.id), undefined); assert.equal(later, 0)
 const writer = await f.ctx.sessionPersistence.open(cold.id, 'write'), {events} = await writer.read()
 await writer.close()
 const inbox = f.ctx.sessionProjections.stateOf(Session.create(cold.id, events, cold.session.header), 'inbox')!
 assert.deepEqual(inbox['next-turn'], [cold.messages[0]]); assert.deepEqual(inbox['next-step'], [cold.messages[1]])
 assert.equal(events.filter(event => event.type === 'agent/inbox/spliced' && (event.data.removedCount ?? 0) > 0).length, 0)
 failing = false
 const retry = await f.ctx.agents.resume({resumeSessionId: cold.id, agentOptions: route})
 assert.equal(f.ctx.agents.get(cold.id), retry.agent); assert.equal(later, 1); assert.equal(f.model.calls, 0)
 await retry.dispose()
})

test('补口清单只声明Registry已有announce，不增加新dispatcher或Remote API', async () => {
 const compat = new URL('../compat/', import.meta.url)
 const registry = JSON.parse(await readFile(new URL('dsh-agent-0.2.0-rc.2-announcement-abort.json', compat), 'utf8')) as {api: string[]; package: string}
 assert.equal(registry.package, '@deepseek-ai/dsh-agent'); assert.deepEqual(registry.api, ['AgentRegistry.announce'])
})
