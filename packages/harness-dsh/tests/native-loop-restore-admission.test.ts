import test, {type TestContext} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp, readFile, readdir, rm, writeFile} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {fileURLToPath} from 'node:url'
import ts from 'typescript'
import {Context} from '@deepseek-ai/cordis'
import {AgentLoop, type Config} from '@deepseek-ai/dsh-agent-loop'
import {AgentRegistry, type Agent, type ResumeAgentOptions} from '@deepseek-ai/dsh-agent'
import {Session, SessionStore, SessionId, SessionSeq, SessionLogOffset, type SessionHeader, type SessionEvent} from '@deepseek-ai/dsh-session'
import {SessionProjectionRegistry} from '@deepseek-ai/dsh-session-projection'
import Persistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import {SessionAlreadyOwnedError, type SessionPersistence, type SessionHandle, type SessionPersistenceOpenOptions} from '@deepseek-ai/dsh-session-persistence'
import {SystemPrompt} from '@deepseek-ai/dsh-system-prompt'
import {ToolRuntime} from '@deepseek-ai/dsh-tools'
import {LlmRuntime, LlmAdapter, createUserMessage, type GenerateOptions, type StreamChunk, type UserMessage} from '@deepseek-ai/dsh-llm'
import {patchedNativePackage} from './fixtures/native-patched-package.ts'
import {deferred} from './fixtures/native-subagent-admission.ts'

type ReadonlyJson<T> = T extends string | number | boolean | null | undefined ? T : {readonly [K in keyof T]: ReadonlyJson<T[K]>}
type RestoreRequest = Readonly<{
 sessionId: SessionId
 header: ReadonlyJson<SessionHeader>
 events: readonly ReadonlyJson<SessionEvent>[]
 inheritedEventCount: SessionLogOffset
 signal: AbortSignal
}>
type RestoreLease = Readonly<{assertCurrent(): undefined}>
type RestorePolicy = (input: RestoreRequest) => RestoreLease | PromiseLike<RestoreLease>
type AdmissionPersistence = SessionPersistence & {openWithAdmission(id: SessionId, admission: RestorePolicy, options?: SessionPersistenceOpenOptions): Promise<SessionHandle>}
type RestoreLoop = AgentLoop & {requireRestoreAdmission(): void; installRestoreAdmission(policy: RestorePolicy): void}
const options = {timeout: 10000}
const denied = /restore admission|checkpoint revoked|checkpoint denied/
const route = {provider: 'restore-deterministic', model: 'fixed-output'}
const immediate = () => new Promise<void>(resolve => setImmediate(resolve))
const lease = (): RestoreLease => Object.freeze({assertCurrent() {return undefined}})

/** 明确的 deterministic 模型替身；真实官方 Loop/Session/JSONL，不代表真实模型质量。 */
class DeterministicRestoreModel extends LlmAdapter {
 readonly requests: GenerateOptions[] = []
 async resolveModel(provider: string, model: string) {return {provider, id: model, name: model, inputModalities: ['text'] as const}}
 async *stream(request: GenerateOptions): AsyncIterable<StreamChunk> {
  this.requests.push(request)
  yield {type: 'block-start', index: 0, blockType: 'text'}
  yield {type: 'text-delta', index: 0, text: 'deterministic restore accepted'}
  yield {type: 'block-end', index: 0, block: {type: 'text', text: 'deterministic restore accepted'}}
  yield {type: 'finish', reason: {kind: 'stop'}}
 }
}

async function fixture(t: TestContext, original = false) {
 const seam = original ? undefined : await patchedNativePackage<typeof import('@deepseek-ai/dsh-session-persistence')>(t, {
  packageName: '@deepseek-ai/dsh-session-persistence', compatBasename: 'dsh-session-persistence-0.2.0-rc.2-open-admission',
 })
 const overrides = seam ? {'@deepseek-ai/dsh-session-persistence': seam.root} : {}
 const backend = original ? undefined : await patchedNativePackage<typeof import('@deepseek-ai/dsh-session-persistence-jsonl')>(t, {
  packageName: '@deepseek-ai/dsh-session-persistence-jsonl', compatBasename: 'dsh-session-persistence-jsonl-0.2.0-rc.2-open-admission', overrides,
 })
 const pkg = original ? undefined : await patchedNativePackage<typeof import('@deepseek-ai/dsh-agent-loop')>(t, {
  packageName: '@deepseek-ai/dsh-agent-loop', compatBasename: 'dsh-agent-loop-0.2.0-rc.2-work-admission', overrides,
 })
 const root = await mkdtemp(join(tmpdir(), 'teloa-loop-restore-')), ctx = new Context()
 t.after(async () => {await ctx.fiber.dispose(); await rm(root, {recursive: true, force: true})})
 for (const plugin of [LlmRuntime, SessionStore, SessionProjectionRegistry, SystemPrompt, ToolRuntime, AgentRegistry]) await ctx.plugin(plugin)
 await ctx.plugin(backend?.namespace.default ?? Persistence, {root, compression: 'none'})
 const persistence = ctx.sessionPersistence as AdmissionPersistence
 const adapter = new DeterministicRestoreModel()
 ctx.llm.registerAdapter([route.provider], adapter)
 const created: Agent[] = [], sessions: Session[] = []
 const store = Reflect.get(ctx, 'sessions') as unknown as SessionStore
 ctx.on('agent/created', ({agent}) => {created.push(agent); return undefined})
 ctx.on('session/created', session => {sessions.push(session)})
 const mount = async (config: {agents?: Config['agents']; requireRestoreAdmission?: boolean} = {}) => {
  const fiber = ctx.plugin(pkg?.namespace.AgentLoop ?? AgentLoop, {agents: [], ...config})
  await fiber
  return {loop: ctx.agentLoop as RestoreLoop, fiber}
 }
 async function seed(target: 'next-turn' | 'next-step' = 'next-turn', boundary: 'none' | 'turn' | 'step' = 'step', inherited = false, both = false) {
  const id = SessionId('cold-checkpoint')
  const message = createUserMessage({source: {kind: 'user', rpcId: 'persisted-input'}, content: [{type: 'text', text: 'persisted pending ' + target}]})
  const events: SessionEvent[] = [{type: 'agent/inbox/spliced', seq: SessionSeq(0), time: 1, data: {target, start: 0, removedCount: 0, inserted: [message]}}]
  if (both) {
   const other = target === 'next-turn' ? 'next-step' : 'next-turn'
   events.push({type: 'agent/inbox/spliced', seq: SessionSeq(events.length), time: 1, data: {target: other, start: 0, removedCount: 0,
    inserted: [createUserMessage({source: {kind: 'user'}, content: [{type: 'text', text: 'persisted pending ' + other}]})],
   }})
  }
  if (boundary !== 'none') events.push({type: 'turn/start', seq: SessionSeq(events.length), time: 2, data: {turn: 1}})
  if (boundary === 'step') events.push({type: 'step/start', seq: SessionSeq(events.length), time: 3, data: {turn: 1, step: 1}})
  const header = {...Session.create(id).header, delegationDepth: 0, ...(inherited ? {isSeeded: true, parentSession: SessionId('durable-parent')} : {})}
  const cold = Session.create(id, events, header, SessionLogOffset(inherited ? events.length : 0))
  const writer = await ctx.sessionPersistence.create(cold.header, {inheritedEventCount: cold.inheritedEventCount})
  await writer.append(cold.snapshotEvents()); await writer.flush(); await writer.close()
  const files = (await readdir(root, {recursive: true})).filter(path => path.endsWith('.jsonl'))
  assert.equal(files.length, 1)
  const path = join(root, files[0]!), bytes = await readFile(path)
  return {id, message, path, bytes, header: cold.header, events: cold.snapshotEvents(), inheritedEventCount: cold.inheritedEventCount}
 }
 return {ctx, adapter, created, sessions, store, mount, seed, pkg, persistence, ownedError: seam?.namespace.SessionAlreadyOwnedError ?? SessionAlreadyOwnedError,
  async readBack(cold: Awaited<ReturnType<typeof seed>>, projections = ctx.sessionProjections) {
   const writer = await ctx.sessionPersistence.open(cold.id, 'write')
   try {
    const {events} = await writer.read()
    const carrier = Session.create(cold.id, events, writer.header, writer.inheritedEventCount)
    const inbox = projections.stateOf(carrier, 'inbox')
    assert.ok(inbox, '必须由仍独立存活的官方Inbox投影重建完整状态')
    return {events, inbox}
   } finally {await writer.close()}
  },
  async unchanged(cold: Awaited<ReturnType<typeof seed>>) {
   assert.deepEqual(await readFile(cold.path), cold.bytes, '拒绝不得改写任何原始 JSONL 字节')
   assert.equal(ctx.agents.get(cold.id), undefined); assert.equal(store.get(cold.id), undefined)
   assert.equal(created.length, 0); assert.equal(sessions.length, 0); assert.equal(adapter.requests.length, 0)
   const reopened = await ctx.sessionPersistence.open(cold.id, 'write')
   assert.deepEqual((await reopened.read()).events, cold.events)
   await reopened.close()
   assert.deepEqual(await readFile(cold.path), cold.bytes)
  },
 }
}

function assertFrozen(value: unknown) {
 if (value === null || typeof value !== 'object') return
 assert.ok(Object.isFrozen(value))
 for (const child of Object.values(value)) assertFrozen(child)
}

for (const target of ['next-turn', 'next-step'] as const) for (const boundary of ['none', 'turn', 'step'] as const) {
 test(`required缺provider：${target}/${boundary}原始JSONL完整不变，无Agent、零模型、writer可重开`, options, async t => {
  const f = await fixture(t), cold = await f.seed(target, boundary), {loop} = await f.mount()
  loop.requireRestoreAdmission(); loop.requireRestoreAdmission()
  // 配置对象不是私有单向 required 状态，不能通过回写 false 绕过。
  Reflect.set(loop.config, 'requireRestoreAdmission', false)
  await assert.rejects(f.ctx.agents.resume({resumeSessionId: cold.id, agentOptions: route}), denied)
  await f.unchanged(cold)
 })
}

for (const target of ['next-turn', 'next-step'] as const) for (const mode of ['throw', 'async-deny', 'stale-lease'] as const) {
 test(`独立policy ${mode}拒绝${target}与未闭step，继承前缀也不授予许可`, options, async t => {
  const f = await fixture(t), cold = await f.seed(target, 'step', true), {loop} = await f.mount()
  let requests = 0
  loop.installRestoreAdmission(candidate => {
   requests++
   assert.deepEqual(Object.keys(candidate).sort(), ['events', 'header', 'inheritedEventCount', 'sessionId', 'signal'])
   assert.ok(Object.isFrozen(candidate)); assertFrozen(candidate.header); assertFrozen(candidate.events)
   assert.equal(candidate.sessionId, cold.id); assert.deepEqual(candidate.header, cold.header)
   assert.deepEqual(candidate.events, cold.events); assert.equal(candidate.inheritedEventCount, cold.inheritedEventCount)
   assert.ok(candidate.signal instanceof AbortSignal); assert.equal(Object.isFrozen(candidate.signal), false)
   const first = candidate.events[0]
   assert.ok(first?.type === 'agent/inbox/spliced')
   assert.equal(Reflect.set(first.data, 'start', 99), false)
   if (mode === 'async-deny') return immediate().then(() => {throw Error('checkpoint denied')})
   if (mode !== 'stale-lease') throw Error('checkpoint denied')
   return Object.freeze({assertCurrent() {throw Error('checkpoint revoked')}})
  })
  await assert.rejects(f.ctx.agents.resume({resumeSessionId: cold.id, agentOptions: route}), denied)
  assert.equal(requests, 1); await f.unchanged(cold)
 })
}

for (const kind of ['undefined', 'mutable', 'getter', 'promise', 'thenable', 'value'] as const) {
 test(`lease ${kind}无效或assertCurrent非同步void，拒绝且接住异步reject`, options, async t => {
  const f = await fixture(t), cold = await f.seed(), {loop} = await f.mount()
  loop.requireRestoreAdmission()
  loop.installRestoreAdmission((() => {
   if (kind === 'undefined') return undefined
   if (kind === 'mutable') return {assertCurrent() {}}
   if (kind === 'getter') return Object.freeze({get assertCurrent() {return () => undefined}})
   return Object.freeze({assertCurrent() {
    if (kind === 'promise') return Promise.reject(Error('invalid async assertion'))
    if (kind === 'thenable') return {then(_resolve: unknown, reject: (error: unknown) => void) {reject(Error('invalid thenable assertion'))}}
    return true
   }})
  }) as RestorePolicy)
  await assert.rejects(f.ctx.agents.resume({resumeSessionId: cold.id, agentOptions: route}), denied)
  await immediate(); await f.unchanged(cold)
 })
}

test('scoped receiver共享唯一模块私有policy；无dispatcher/RPC或公共事件调用口', options, async t => {
 const f = await fixture(t), cold = await f.seed(), {loop} = await f.mount()
 const scoped = f.ctx.extend().agentLoop as RestoreLoop
 assert.equal(Reflect.get(loop, 'runtime'), Reflect.get(scoped, 'runtime'))
 assert.deepEqual(Object.keys(Reflect.get(loop, 'runtime')), ['ctx'])
 assert.equal(Reflect.set(scoped, 'runtime', {}), false)
 for (const name of ['restoreAdmission', 'restorePolicy', 'dispatchRestoreAdmission', 'invokeRestoreAdmission']) assert.equal(Reflect.get(loop, name), undefined)
 for (const value of [undefined, null, {}, false, Promise.resolve()]) assert.throws(() => loop.installRestoreAdmission(value as RestorePolicy), denied)
 let calls = 0
 scoped.requireRestoreAdmission(); scoped.installRestoreAdmission(() => {calls++; throw Error('checkpoint denied')})
 assert.throws(() => loop.installRestoreAdmission(() => lease()), denied)
 f.ctx.emit('session/event', Session.create(SessionId('observed')), cold.events[0]!)
 await immediate(); assert.equal(calls, 0)
 await assert.rejects(f.ctx.agents.resume({resumeSessionId: cold.id, agentOptions: route}), denied)
 assert.equal(calls, 1); await f.unchanged(cold)
})

for (const identity of ['resumeSessionId', 'sessionId'] as const) {
 test(`Config.requireRestoreAdmission在构造器${identity}配置恢复前生效`, options, async t => {
  const f = await fixture(t), cold = await f.seed(), failed = deferred<unknown>()
  f.ctx.on('agent-loop/config-start-failed', payload => {assert.equal(payload.sessionId, cold.id); failed.resolve(payload.error)})
  const {loop} = await f.mount({requireRestoreAdmission: true, agents: [{id: 'configured-restore', [identity]: cold.id, ...route}]})
  assert.match(String(await failed.promise), denied)
  assert.equal(Reflect.get(loop.config, 'requireRestoreAdmission'), true)
  await f.unchanged(cold)
 })
}

for (const cause of ['caller', 'owner', 'factory'] as const) {
 test(`policy自然等待期间${cause}取消及时结算并释放真实writer，迟到lease不能复活`, options, async t => {
  const f = await fixture(t), cold = await f.seed(), {loop, fiber} = await f.mount()
  const ownerReady = deferred<Context>()
  const owner = f.ctx.plugin({inject: ['agents'], apply(ctx: Context) {ownerReady.resolve(ctx)}})
  const ownerCtx = await ownerReady.promise
  const controller = new AbortController(), entered = deferred<RestoreRequest>(), release = deferred<RestoreLease>()
  let lateAssertions = 0, storageCandidate: RestoreRequest | undefined, storageSignal: AbortSignal | undefined
  const open = f.persistence.openWithAdmission.bind(f.persistence)
  f.persistence.openWithAdmission = (id, admission, options) => {
   storageSignal = options?.signal
   return open(id, candidate => {storageCandidate = candidate; return admission(candidate)}, options)
  }
  loop.requireRestoreAdmission(); loop.installRestoreAdmission(candidate => {entered.resolve(candidate); return release.promise})
  const restoring = ownerCtx.agents.resume({resumeSessionId: cold.id, agentOptions: route, signal: controller.signal})
  const rejected = assert.rejects(restoring, /cancel restore|owner disposed|not active/)
  const candidate = await entered.promise
  assert.equal(candidate, storageCandidate); assert.equal(candidate.signal, storageSignal)
  assert.notEqual(candidate.signal, controller.signal)
  await assert.rejects(f.ctx.sessionPersistence.open(cold.id, 'write'), f.ownedError)
  assert.deepEqual(await readFile(cold.path), cold.bytes); assert.equal(f.created.length, 0)
  const disposing = cause === 'owner' ? owner.dispose() : cause === 'factory' ? fiber.dispose() : undefined
  if (cause === 'caller') controller.abort(Error('cancel restore'))
  await rejected; await disposing
  assert.equal(candidate.signal.aborted, true)
  release.resolve(Object.freeze({assertCurrent() {lateAssertions++; return undefined}}))
  await immediate(); assert.equal(lateAssertions, 0); await f.unchanged(cold)
 })
}

for (const target of ['next-turn', 'next-step'] as const) {
 test(`可信独立async策略放行${target}；真实Loop读取pending后使用deterministic模型`, options, async t => {
  const f = await fixture(t), cold = await f.seed(target, 'step', true), {loop} = await f.mount()
  const entered = deferred<void>(), release = deferred<void>()
  let current = true, assertions = 0
  loop.requireRestoreAdmission(); loop.installRestoreAdmission(async candidate => {
   assert.equal(candidate.sessionId, cold.id); assert.deepEqual(candidate.header, cold.header)
   assert.deepEqual(candidate.events, cold.events); assert.equal(candidate.inheritedEventCount, cold.inheritedEventCount)
   entered.resolve(); await release.promise
   // 独立可信policy的确定性checkpoint；不冒充持久签名或业务受理授权。
   return Object.freeze({assertCurrent() {assert.ok(current, 'checkpoint revoked'); candidate.signal.throwIfAborted(); assertions++; return undefined}})
  })
  f.ctx.on('agent/created', ({agent}) => {agent.steer(createUserMessage({source: {kind: 'user'}, content: [{type: 'text', text: 'wake restored pending'}]})); return undefined})
  const restoring = f.ctx.agents.resume({resumeSessionId: cold.id, agentOptions: route})
  await entered.promise
  assert.equal(f.adapter.requests.length, 0); assert.equal(f.created.length, 0)
  assert.deepEqual(await readFile(cold.path), cold.bytes)
  await assert.rejects(f.ctx.sessionPersistence.open(cold.id, 'write'), f.ownedError)
  release.resolve(); const handle = await restoring; await handle.agent.whenIdle()
  assert.equal(f.created.length, 1); assert.equal(f.adapter.requests.length, 1); assert.ok(assertions > 5)
  assert.match(JSON.stringify(f.adapter.requests[0]!.messages), new RegExp('persisted pending ' + target))
  assert.equal(handle.agent.inbox.nextTurn.length + handle.agent.inbox.nextStep.length, 0)
  assert.equal(handle.agent.session.snapshotEvents().filter(event => event.type === 'turn/end').length, 2)
  // 接缝完成后不把lease当永久热执行许可证；后续模型调用仍由原热准入负责。
  current = false
  handle.agent.followup(createUserMessage({source: {kind: 'user'}, content: [{type: 'text', text: 'later Free work'}]}))
  await handle.agent.whenIdle(); assert.equal(f.adapter.requests.length, 2)
  handle.agent.inject(createUserMessage({source: {kind: 'user'}, content: [{type: 'text', text: 'cancel after successful restore'}]}))
  await handle.dispose()
  const afterDispose = await f.readBack(cold)
  assert.deepEqual(afterDispose.inbox, {'next-turn': [], 'next-step': []})
  assert.equal(afterDispose.events.filter(event => event.type === 'agent/inbox/spliced' && event.data.outcome === 'canceled').length, 1)
  assert.equal(f.adapter.requests.length, 2)
 })
}

for (const original of [true, false]) {
 test(`${original ? '原官方' : '补口未require未policy'}Free保留恢复closer、pending与模型行为`, options, async t => {
  const f = await fixture(t, original), cold = await f.seed(), {loop} = await f.mount()
  if (!original) assert.equal(Reflect.get(loop.config, 'requireRestoreAdmission'), false)
  const handle = await f.ctx.agents.resume({resumeSessionId: cold.id, agentOptions: route})
  assert.deepEqual(handle.agent.inbox.nextTurn.map(message => message.id), [cold.message.id])
  const events = handle.agent.session.snapshotEvents()
  assert.deepEqual(events.slice(0, cold.events.length), cold.events)
  assert.deepEqual(events.slice(cold.events.length).map(event => event.type), ['step/end', 'turn/end', 'session/end-seed'])
  assert.equal(f.adapter.requests.length, 0)
  handle.agent.steer(createUserMessage({source: {kind: 'user'}, content: [{type: 'text', text: 'Free wake'}]}))
  await handle.agent.whenIdle(); assert.equal(f.adapter.requests.length, 1)
  assert.match(JSON.stringify(f.adapter.requests[0]!.messages), /persisted pending next-turn/)
  handle.agent.inject(createUserMessage({source: {kind: 'user'}, content: [{type: 'text', text: 'Free dispose pending'}]}))
  await handle.dispose()
  const disposed = await f.readBack(cold)
  assert.deepEqual(disposed.inbox, {'next-turn': [], 'next-step': []})
  assert.equal(disposed.events.filter(event => event.type === 'agent/inbox/spliced' && event.data.outcome === 'canceled').length, 1)
  // 未启用恢复准入的失败清理也保留官方Free行为，不能全局改成keepInbox。
  const free = await fixture(t, original), rejectedCold = await free.seed('next-turn', 'step', false, true)
  await free.mount()
  free.ctx.on('agent/created', () => {throw Error('Free publication rejected')})
  await assert.rejects(free.ctx.agents.resume({resumeSessionId: rejectedCold.id, agentOptions: route}), /Free publication rejected/)
  const rejectedState = await free.readBack(rejectedCold)
  assert.deepEqual(rejectedState.inbox, {'next-turn': [], 'next-step': []})
  assert.equal(rejectedState.events.filter(event => event.type === 'agent/inbox/spliced' && event.data.outcome === 'canceled').length, 2)
  assert.equal(free.adapter.requests.length, 0)
 })
}

for (const window of ['closer-append', 'suffix-append', 'setup', 'setup-commit', 'session-publish', 'agent-publish', 'publish-microtask'] as const) {
 test(`已授权后在${window}窗口撤销：完整重建原Inbox、阻止模型并释放writer`, options, async t => {
  const f = await fixture(t), cold = await f.seed('next-turn', 'step', false, true), {loop} = await f.mount()
  const originalInbox = f.ctx.sessionProjections.stateOf(Session.create(cold.id, cold.events, cold.header, cold.inheritedEventCount), 'inbox')!
  const publishedWakes: UserMessage[] = []
  let current = true, commits = 0
  const entered = deferred<void>(), release = deferred<void>()
  const pause = async () => {entered.resolve(); await release.promise}
  loop.installRestoreAdmission(() => Object.freeze({assertCurrent() {if (!current) throw Error('checkpoint revoked'); return undefined}}))
  let setup: ResumeAgentOptions['setup']
  if (window === 'closer-append' || window === 'suffix-append') {
   const open = f.persistence.openWithAdmission.bind(f.persistence)
   let appends = 0
   f.persistence.openWithAdmission = async (...args) => {
    const handle = await open(...args), append = handle.append.bind(handle)
    handle.append = async (...args) => {await append(...args); if (++appends === (window === 'closer-append' ? 1 : 2)) await pause()}
    return handle
   }
  }
  if (window === 'setup' || window === 'setup-commit') setup = async (_ctx, agent) => {
   agent.steer(createUserMessage({source: {kind: 'user'}, content: [{type: 'text', text: 'latched wake'}]}))
   if (window === 'setup') await pause()
   return {commit() {commits++; if (window === 'setup-commit') current = false}}
  }
  if (window === 'session-publish') f.ctx.on('session/created', () => {current = false})
  f.ctx.on('agent/created', async ({agent}) => {
   const wake = createUserMessage({source: {kind: 'user'}, content: [{type: 'text', text: 'publication wake'}]})
   publishedWakes.push(wake); agent.steer(wake)
   if (window === 'agent-publish') await pause()
   if (window === 'publish-microtask') queueMicrotask(() => {current = false})
  })
  const restoring = f.ctx.agents.resume({resumeSessionId: cold.id, agentOptions: route, ...setup ? {setup} : {}})
  const rejected = assert.rejects(restoring, denied)
  if (window === 'closer-append' || window === 'suffix-append' || window === 'setup' || window === 'agent-publish') {
   await entered.promise; assert.equal(f.adapter.requests.length, 0); current = false; release.resolve()
  }
  await rejected; await immediate()
  assert.equal(f.adapter.requests.length, 0); assert.equal(f.ctx.agents.get(cold.id), undefined); assert.equal(f.store.get(cold.id), undefined)
  if (window === 'setup') assert.equal(commits, 0)
  if (window === 'closer-append' || window === 'suffix-append') assert.equal(f.created.length, 0)
  const restored = await f.readBack(cold)
  assert.deepEqual(restored.events.slice(0, cold.events.length), cold.events)
  assert.equal(restored.events.filter(event => event.type === 'agent/inbox/spliced' && (event.data.removedCount ?? 0) > 0).length, 0)
  assert.deepEqual(restored.inbox, {'next-turn': originalInbox['next-turn'], 'next-step': [...originalInbox['next-step'], ...publishedWakes]})
 })
}

test('冷read先由官方JSONL校验；损坏事件不会交给policy，也不改原字节', options, async t => {
 const f = await fixture(t), cold = await f.seed(), {loop} = await f.mount()
 let calls = 0
 loop.requireRestoreAdmission(); loop.installRestoreAdmission(() => {calls++; return lease()})
 const rows = cold.bytes.toString('utf8').split('\n')
 rows[1] = '{"type":"unknown-required-event","seq":0,"time":1,"data":{}}'
 const corrupt = Buffer.from(rows.join('\n'))
 await writeFile(cold.path, corrupt)
 await assert.rejects(f.ctx.agents.resume({resumeSessionId: cold.id, agentOptions: route}))
 assert.equal(calls, 0); assert.equal(f.created.length, 0); assert.equal(f.adapter.requests.length, 0)
 assert.deepEqual(await readFile(cold.path), corrupt)
 // 还原本测试的损坏样本后能重新获得writer，证明读取失败也释放所有权。
 await writeFile(cold.path, cold.bytes); await f.unchanged(cold)
})

test('进入恢复前已abort：零policy、无Agent、JSONL不变', options, async t => {
 const f = await fixture(t), cold = await f.seed(), {loop} = await f.mount()
 let calls = 0
 loop.installRestoreAdmission(() => {calls++; return lease()})
 await assert.rejects(f.ctx.agents.resume({resumeSessionId: cold.id, agentOptions: route, signal: AbortSignal.abort(Error('already aborted'))}), /already aborted/)
 assert.equal(calls, 0); await f.unchanged(cold)
})

const restoreWriteWindows = ['closer', 'seed-suffix', 'setup-suffix'] as const
for (const window of restoreWriteWindows) for (const side of ['before', 'after'] as const) for (const cause of ['caller', 'owner', 'factory'] as const) {
 test(`${window}官方append ${side}自然等待时${cause}取消：不等release、writer重开、迟到结果无副作用`, options, async t => {
  const release = deferred<void>(); t.after(() => release.resolve())
  const f = await fixture(t), cold = await f.seed('next-turn', 'step', false, true), {loop, fiber} = await f.mount()
  const originalInbox = (await f.readBack(cold)).inbox
  const verifier = cause === 'factory' ? await fixture(t) : f
  if (verifier !== f) await verifier.mount()
  const ownerReady = deferred<Context>()
  const owner = f.ctx.plugin({inject: ['agents'], apply(ctx: Context) {ownerReady.resolve(ctx)}})
  const ownerCtx = await ownerReady.promise, controller = new AbortController(), entered = deferred<void>(), finished = deferred<void>()
  const wake = createUserMessage({source: {kind: 'user'}, content: [{type: 'text', text: 'unpublished setup pending'}]})
  let policySignal: AbortSignal | undefined, appendCalls = 0
  const committed: SessionEvent[] = [], lateErrors: unknown[] = []
  loop.requireRestoreAdmission(); loop.installRestoreAdmission(candidate => {policySignal = candidate.signal; return lease()})
  const open = f.persistence.openWithAdmission.bind(f.persistence)
  f.persistence.openWithAdmission = async (...args) => {
   const handle = await open(...args), append = handle.append.bind(handle)
   handle.append = async (events, appendOptions) => {
    const targeted = ++appendCalls === restoreWriteWindows.indexOf(window) + 1
    assert.ok(appendOptions?.signal, '必须实际向SDK append传递取消signal')
    assert.equal(appendOptions.signal, policySignal, '三种写入都使用候选的官方fused signal')
    try {
     if (targeted && side === 'before') {entered.resolve(); await release.promise}
     await append(events, appendOptions)
     committed.push(...events)
     if (targeted && side === 'after') {entered.resolve(); await release.promise}
    } catch (error) {
     if (targeted) lateErrors.push(error)
     throw error
    } finally {if (targeted) finished.resolve()}
   }
   return handle
  }
  const restoring = ownerCtx.agents.resume({resumeSessionId: cold.id, agentOptions: route, signal: controller.signal,
   ...(window === 'setup-suffix' ? {setup: async (_ctx: Context, agent: Agent) => {agent.steer(wake)}} : {}),
  })
  const rejected = assert.rejects(restoring, /cancel restore|owner disposed|not active|lifecycle disposed/)
  await entered.promise
  assert.equal(f.created.length, 0); assert.equal(f.adapter.requests.length, 0)
  await assert.rejects(f.ctx.sessionPersistence.open(cold.id, 'write'), f.ownedError)
  const disposing = cause === 'owner' ? owner.dispose() : cause === 'factory' ? fiber.dispose() : undefined
  if (cause === 'caller') controller.abort(Error('cancel restore'))
  // 必须在释放适配器Promise之前完成拒绝、卸载和安全close，不以超时替代取消。
  await rejected; await disposing
  assert.equal(policySignal?.aborted, true)
  const restored = await f.readBack(cold, verifier.ctx.sessionProjections), bytes = await readFile(cold.path)
  assert.deepEqual(restored.events, [...cold.events, ...committed])
  assert.deepEqual(restored.inbox, {'next-turn': originalInbox['next-turn'],
   'next-step': [...originalInbox['next-step'], ...(window === 'setup-suffix' && side === 'after' ? [wake] : [])],
  })
  const callsBeforeRelease = appendCalls
  release.resolve(); await finished.promise; await immediate()
  assert.equal(lateErrors.length, side === 'before' ? 1 : 0)
  assert.equal(appendCalls, callsBeforeRelease)
  assert.deepEqual(await readFile(cold.path), bytes, '迟到append不得产生任何额外JSONL写入')
  assert.equal(f.ctx.agents.get(cold.id), undefined); assert.equal(f.store.get(cold.id), undefined)
  assert.equal(f.created.length, 0); assert.equal(f.sessions.length, 0); assert.equal(f.adapter.requests.length, 0)
 })
}

test('真实SDK在append入队后观察传入signal，未写入时返回原abort原因而非靠close阻断', options, async t => {
 const f = await fixture(t), cold = await f.seed(), {loop} = await f.mount()
 const controller = new AbortController(), reason = Error('cancel at SDK queue'), sdkResult = deferred<unknown>()
 let policySignal: AbortSignal | undefined
 loop.installRestoreAdmission(candidate => {policySignal = candidate.signal; return lease()})
 const open = f.persistence.openWithAdmission.bind(f.persistence)
 f.persistence.openWithAdmission = async (...args) => {
  const handle = await open(...args), append = handle.append.bind(handle)
  handle.append = (events, appendOptions) => {
   assert.equal(appendOptions?.signal, policySignal)
   const pending = append(events, appendOptions)
   controller.abort(reason)
   pending.then(() => sdkResult.resolve(undefined), error => sdkResult.resolve(error))
   return pending
  }
  return handle
 }
 await assert.rejects(f.ctx.agents.resume({resumeSessionId: cold.id, agentOptions: route, signal: controller.signal}), error => error === reason)
 assert.equal(await sdkResult.promise, reason, '官方append必须实际消费signal；缺失signal会写入并成功')
 await f.unchanged(cold)
})

for (const window of restoreWriteWindows) {
 test(`${window}已进入官方持久化队列：取消仍等真实写完成才close，不提前释放writer或回滚`, options, async t => {
  const release = deferred<void>(); t.after(() => release.resolve())
  const f = await fixture(t), cold = await f.seed('next-turn', 'step', false, true), {loop} = await f.mount()
  const originalInbox = (await f.readBack(cold)).inbox
  const controller = new AbortController(), entered = deferred<void>(), closing = deferred<void>()
  const wake = createUserMessage({source: {kind: 'user'}, content: [{type: 'text', text: 'setup write already in flight'}]})
  loop.installRestoreAdmission(() => lease())
  const open = f.persistence.openWithAdmission.bind(f.persistence), committed: SessionEvent[] = []
  let batches = 0, settled = false
  f.persistence.openWithAdmission = async (...args) => {
   const handle = await open(...args)
   const persist = (Reflect.get(handle, 'persistContiguous') as (events: readonly SessionEvent[]) => Promise<void>).bind(handle)
   const close = handle.close.bind(handle)
   // 此屏障位于官方append的mutation chain内部；依然调用原始真实JSONL持久化。
   Reflect.set(handle, 'persistContiguous', async (events: readonly SessionEvent[]) => {
    if (++batches === restoreWriteWindows.indexOf(window) + 1) {entered.resolve(); await release.promise}
    await persist(events); committed.push(...events)
   })
   handle.close = () => {const pending = close(); closing.resolve(); return pending}
   return handle
  }
  const restoring = f.ctx.agents.resume({resumeSessionId: cold.id, agentOptions: route, signal: controller.signal,
   ...(window === 'setup-suffix' ? {setup: async (_ctx: Context, agent: Agent) => {agent.steer(wake)}} : {}),
  })
  restoring.then(() => {settled = true}, () => {settled = true})
  const rejected = assert.rejects(restoring, /cancel in-flight append/)
  await entered.promise; controller.abort(Error('cancel in-flight append')); await closing.promise; await immediate()
  assert.equal(settled, false)
  await assert.rejects(f.ctx.sessionPersistence.open(cold.id, 'write'), f.ownedError)
  release.resolve(); await rejected
  const restored = await f.readBack(cold)
  assert.deepEqual(restored.events, [...cold.events, ...committed])
  assert.deepEqual(restored.inbox, {'next-turn': originalInbox['next-turn'], 'next-step': [...originalInbox['next-step'], ...(window === 'setup-suffix' ? [wake] : [])]})
  assert.equal(f.created.length, 0); assert.equal(f.adapter.requests.length, 0)
 })
}

test('未启用准入的Free仍直接等待append，保持原SDK调用选项与取消时序', options, async t => {
 for (const original of [true, false]) {
  const release = deferred<void>(); t.after(() => release.resolve())
  const f = await fixture(t, original), cold = await f.seed(); await f.mount()
  const controller = new AbortController(), entered = deferred<void>()
  const open = f.ctx.sessionPersistence.open.bind(f.ctx.sessionPersistence)
  let settled = false
  f.ctx.sessionPersistence.open = async (...args) => {
   const handle = await open(...args), append = handle.append.bind(handle)
   handle.append = async (events, appendOptions) => {
    assert.equal(appendOptions, undefined)
    await append(events, appendOptions); entered.resolve(); await release.promise
   }
   return handle
  }
  const restoring = f.ctx.agents.resume({resumeSessionId: cold.id, agentOptions: route, signal: controller.signal})
  restoring.then(() => {settled = true}, () => {settled = true})
  const rejected = assert.rejects(restoring, /cancel Free restore/)
  await entered.promise; controller.abort(Error('cancel Free restore')); await immediate()
  assert.equal(settled, false)
  await assert.rejects(f.ctx.sessionPersistence.open(cold.id, 'write'), f.ownedError)
  release.resolve(); await rejected
  await f.readBack(cold); assert.equal(f.adapter.requests.length, 0)
 }
})

for (const window of ['setup', 'publish'] as const) for (const cause of ['caller', 'owner', 'factory'] as const) {
 test(`${window}自然等待中${cause}取消，无需Observation超时即可结束并重开writer`, options, async t => {
  const f = await fixture(t), cold = await f.seed('next-turn', 'step', false, true), {loop, fiber} = await f.mount()
  const originalInbox = f.ctx.sessionProjections.stateOf(Session.create(cold.id, cold.events, cold.header, cold.inheritedEventCount), 'inbox')!
  // 被测factory卸载会注销其投影；另建纯重放上下文验读，不重启被测恢复流程。
  const verifier = cause === 'factory' ? await fixture(t) : f
  if (verifier !== f) await verifier.mount()
  const wake = createUserMessage({source: {kind: 'user'}, content: [{type: 'text', text: 'pending during cancellation'}]})
  const ownerReady = deferred<Context>()
  const owner = f.ctx.plugin({inject: ['agents'], apply(ctx: Context) {ownerReady.resolve(ctx)}})
  const ownerCtx = await ownerReady.promise, controller = new AbortController(), entered = deferred<void>(), release = deferred<void>()
  loop.installRestoreAdmission(() => lease())
  const pause = async (agent: Agent) => {
   agent.steer(wake)
   entered.resolve(); await release.promise
  }
  if (window === 'publish') f.ctx.on('agent/created', async ({agent}) => {await pause(agent)})
  const restoring = ownerCtx.agents.resume({resumeSessionId: cold.id, agentOptions: route, signal: controller.signal,
   ...(window === 'setup' ? {setup: async (_ctx: Context, agent: Agent) => {await pause(agent)}} : {}),
  })
  const rejected = assert.rejects(restoring, /cancel restore|owner disposed|not active|lifecycle disposed/)
  await entered.promise
  const disposing = cause === 'owner' ? owner.dispose() : cause === 'factory' ? fiber.dispose() : undefined
  if (cause === 'caller') controller.abort(Error('cancel restore'))
  await rejected; await disposing
  assert.equal(f.adapter.requests.length, 0)
  const restored = await f.readBack(cold, verifier.ctx.sessionProjections)
  assert.equal(restored.events.filter(event => event.type === 'agent/inbox/spliced' && (event.data.removedCount ?? 0) > 0).length, 0)
  assert.deepEqual(restored.inbox, {'next-turn': originalInbox['next-turn'], 'next-step': [...originalInbox['next-step'], ...window === 'publish' ? [wake] : []]})
  release.resolve(); await immediate()
  assert.equal(f.ctx.agents.get(cold.id), undefined); assert.equal(f.adapter.requests.length, 0)
 })
}

test('补丁声明可编译：deep readonly候选、可async策略、同步assertCurrent、布尔默认false', options, async t => {
 const f = await fixture(t), pkg = f.pkg!
 const ConfigSchema = pkg.namespace.AgentLoop.Config as unknown as (value: unknown) => {requireRestoreAdmission: boolean}
 assert.equal(ConfigSchema({agents: []}).requireRestoreAdmission, false)
 assert.equal(ConfigSchema({agents: [], requireRestoreAdmission: true}).requireRestoreAdmission, true)
 assert.throws(() => ConfigSchema({agents: [], requireRestoreAdmission: 'true'}))
 const path = join(pkg.root, 'restore-type-contract.ts')
 await writeFile(path, `import {AgentLoop, type Config, type AgentLoopRestoreAdmission} from './lib/types/index.js'
declare const loop: AgentLoop
const config: Partial<Config> = {requireRestoreAdmission: true}
// @ts-expect-error Config only accepts boolean
config.requireRestoreAdmission = 1
const policy: AgentLoopRestoreAdmission = async candidate => {
 candidate.signal.throwIfAborted()
 // @ts-expect-error readonly header
 candidate.header.id = candidate.sessionId
 // @ts-expect-error readonly event list
 candidate.events.push(candidate.events[0]!)
 const event = candidate.events[0]
 if (event?.type === 'agent/inbox/spliced') {
  // @ts-expect-error deep readonly event payload
  event.data.inserted.push(event.data.inserted[0]!)
 }
 return Object.freeze({assertCurrent() {return undefined}})
}
loop.requireRestoreAdmission()
loop.installRestoreAdmission(policy)
// @ts-expect-error async assertions are not leases
loop.installRestoreAdmission(() => Object.freeze({async assertCurrent() {}}))
// @ts-expect-error no public dispatch capability
loop.dispatchRestoreAdmission({})
`)
 const program = ts.createProgram([path], {noEmit: true, strict: true, skipLibCheck: true,
  module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler, target: ts.ScriptTarget.ES2022,
  typeRoots: [fileURLToPath(new URL('../../../node_modules/@types', import.meta.url))],
 })
 const diagnostics = ts.getPreEmitDiagnostics(program)
 assert.deepEqual(diagnostics.map(diagnostic => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')), [])
})
