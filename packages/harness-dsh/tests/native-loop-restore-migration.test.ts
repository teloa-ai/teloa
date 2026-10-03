import test, {type TestContext} from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import {mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {syncBuiltinESMExports} from 'node:module'
import {fileURLToPath} from 'node:url'
import {zstdCompressSync, constants} from 'node:zlib'
import ts from 'typescript'
import {Context} from '@deepseek-ai/cordis'
import {AgentLoop} from '@deepseek-ai/dsh-agent-loop'
import {AgentRegistry, type Agent} from '@deepseek-ai/dsh-agent'
import {Session, SessionStore, SessionId, SessionSeq, SessionLogOffset, type SessionHeader, type SessionEvent} from '@deepseek-ai/dsh-session'
import {SessionProjectionRegistry} from '@deepseek-ai/dsh-session-projection'
import Persistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import {type SessionPersistence, type SessionHandle, type SessionPersistenceOpenOptions} from '@deepseek-ai/dsh-session-persistence'
import {releasedV3SessionFormatCodec, releasedV4SessionFormatCodec} from '@deepseek-ai/dsh-session-format-v3-to-v4'
import {SystemPrompt} from '@deepseek-ai/dsh-system-prompt'
import {ToolRuntime} from '@deepseek-ai/dsh-tools'
import {LlmRuntime, LlmAdapter, createUserMessage, type GenerateOptions, type StreamChunk} from '@deepseek-ai/dsh-llm'
import {patchedNativePackage} from './fixtures/native-patched-package.ts'
import {deferred} from './fixtures/native-subagent-admission.ts'

type ReadonlyJson<T> = T extends string | number | boolean | null | undefined ? T : {readonly [K in keyof T]: ReadonlyJson<T[K]>}
type Candidate = Readonly<{sessionId: SessionId; header: ReadonlyJson<SessionHeader>; events: readonly ReadonlyJson<SessionEvent>[]; inheritedEventCount: SessionLogOffset; signal: AbortSignal}>
type Lease = Readonly<{assertCurrent(): undefined}>
type Policy = (input: Candidate) => Lease | PromiseLike<Lease>
type AdmissionPersistence = SessionPersistence & {openWithAdmission(id: SessionId, admission: Policy, options?: SessionPersistenceOpenOptions): Promise<SessionHandle>}
type RestoreLoop = AgentLoop & {requireRestoreAdmission(): void; installRestoreAdmission(policy: Policy): void}
type PersistenceModule = typeof import('@deepseek-ai/dsh-session-persistence') & {SessionAdmissionUnsupportedError: new () => Error}
const options = {timeout: 15000}, route = {provider: 'migration-deterministic', model: 'fixed-output'}
const immediate = () => new Promise<void>(resolve => setImmediate(resolve))
const lease = (): Lease => Object.freeze({assertCurrent() {return undefined}})
const denied = /checkpoint denied|checkpoint revoked|restore admission/

/** Deterministic adapter only: no external model call or model-quality claim. */
class DeterministicMigrationModel extends LlmAdapter {
 readonly requests: GenerateOptions[] = []
 async resolveModel(provider: string, model: string) {return {provider, id: model, name: model, inputModalities: ['text'] as const}}
 async *stream(request: GenerateOptions): AsyncIterable<StreamChunk> {
  this.requests.push(request)
  yield {type: 'block-start', index: 0, blockType: 'text'}
  yield {type: 'text-delta', index: 0, text: 'deterministic migrated pending'}
  yield {type: 'block-end', index: 0, block: {type: 'text', text: 'deterministic migrated pending'}}
  yield {type: 'finish', reason: {kind: 'stop'}}
 }
}

async function fixture(t: TestContext, compression: 'none' | 'zstd' = 'none', originalBackend = false) {
 const seam = await patchedNativePackage<PersistenceModule>(t, {
  packageName: '@deepseek-ai/dsh-session-persistence', compatBasename: 'dsh-session-persistence-0.2.0-rc.2-open-admission',
 })
 const overrides = {'@deepseek-ai/dsh-session-persistence': seam.root}
 const backend = await patchedNativePackage<typeof import('@deepseek-ai/dsh-session-persistence-jsonl')>(t, {
  packageName: '@deepseek-ai/dsh-session-persistence-jsonl', compatBasename: 'dsh-session-persistence-jsonl-0.2.0-rc.2-open-admission', overrides,
 })
 const loopPackage = await patchedNativePackage<typeof import('@deepseek-ai/dsh-agent-loop')>(t, {
  packageName: '@deepseek-ai/dsh-agent-loop', compatBasename: 'dsh-agent-loop-0.2.0-rc.2-work-admission', overrides,
 })
 const root = await mkdtemp(join(tmpdir(), 'teloa-restore-migration-')), ctx = new Context()
 t.after(async () => {await ctx.fiber.dispose(); await rm(root, {recursive: true, force: true})})
 for (const plugin of [LlmRuntime, SessionStore, SessionProjectionRegistry, SystemPrompt, ToolRuntime, AgentRegistry]) await ctx.plugin(plugin)
 const backendFiber = ctx.plugin(originalBackend ? Persistence : backend.namespace.default, {root, compression})
 await backendFiber
 const persistence = ctx.sessionPersistence as AdmissionPersistence, store = Reflect.get(ctx, 'sessions') as unknown as SessionStore
 const adapter = new DeterministicMigrationModel(); ctx.llm.registerAdapter([route.provider], adapter)
 const created: Agent[] = [], sessions: Session[] = []
 ctx.on('agent/created', ({agent}) => {created.push(agent); return undefined})
 ctx.on('session/created', session => {sessions.push(session)})
 const mount = async (required = true) => {
  const config = {agents: [], requireRestoreAdmission: required}
  const fiber = ctx.plugin(loopPackage.namespace.AgentLoop, config)
  await fiber
  return {loop: ctx.agentLoop as RestoreLoop, fiber}
 }
 const encode = (line: string) => compression === 'none' ? Buffer.from(line) : zstdCompressSync(Buffer.from(line), {params: {[constants.ZSTD_c_checksumFlag]: 1}})
 async function seed(version: 3 | 4 = 3, inherited = false, torn = false) {
  const id = SessionId('migration-cold'), dir = join(root, '_no-cwd', id), suffix = compression === 'none' ? '.jsonl' : '.jsonl.zstd'
  const messages = ['next-turn', 'next-step'].map(target => createUserMessage({source: {kind: 'user', rpcId: target}, content: [{type: 'text', text: 'pending ' + target}]}))
  const events: SessionEvent[] = messages.map((message, index) => ({type: 'agent/inbox/spliced', seq: SessionSeq(index), time: index + 1,
   data: {target: index === 0 ? 'next-turn' : 'next-step', start: 0, removedCount: 0, inserted: [message]},
  }))
  if (inherited) events.push({type: 'session/end-seed', seq: SessionSeq(events.length), time: 3, data: {inherited: true}})
  events.push({type: 'turn/start', seq: SessionSeq(events.length), time: 4, data: {turn: 1}})
  events.push({type: 'step/start', seq: SessionSeq(events.length), time: 5, data: {turn: 1, step: 1}})
  const header = {...Session.create(id).header, createdAt: 1000, delegationDepth: 0,
   ...(inherited ? {isSeeded: true, parentSession: SessionId('migration-parent')} : {}),
  }
  const count = SessionLogOffset(inherited ? 2 : 0), codec = version === 3 ? releasedV3SessionFormatCodec : releasedV4SessionFormatCodec
  const lines = [codec.encodeHeader({...header, version}, count), ...events.map(event => codec.encodeEvent(event as Parameters<typeof codec.encodeEvent>[0]))]
  await mkdir(dir, {recursive: true})
  const path = join(dir, `session.v${version}${suffix}`)
  const tail = torn ? compression === 'none' ? Buffer.from('{"type":"agent/inbox') : encode('{"type":').subarray(0, 6) : Buffer.alloc(0)
  await writeFile(path, Buffer.concat([...lines.map(line => encode(JSON.stringify(line) + '\n')), tail]))
  // Keep an older immutable generation too: denial must preserve every log, not just the selected source.
  if (version === 3) await writeFile(join(dir, 'session.v2' + suffix), encode(JSON.stringify({type: 'session', version: 2, id, createdAt: 1000, isSeeded: false, delegationDepth: 0}) + '\n'))
  const files = async () => {
   const names = (await readdir(dir)).filter(name => /\.jsonl(?:\.zstd)?$|\.tmp$/.test(name)).sort()
   return Promise.all(names.map(async name => [name, await readFile(join(dir, name))] as const))
  }
  const before = await files()
  return {id, header, events, count, dir, path, current: join(dir, 'session.v4' + suffix), files, before,
   get inbox() {
    const inbox = ctx.sessionProjections.stateOf(Session.fromRestore(id, events, header, count, 'detached'), 'inbox')
    assert.ok(inbox, '挂载官方Loop后由其Inbox投影重建')
    return inbox
   },
   async unchanged() {assert.deepEqual(await files(), before, '所有历史generation及torn字节保持不变，未产生v4或临时stage')},
  }
 }
 const peer = async () => {
  const other = new Context(); t.after(() => other.fiber.dispose())
  await other.plugin(SessionStore); await other.plugin(backend.namespace.default, {root, compression})
  return other.sessionPersistence as AdmissionPersistence
 }
 return {ctx, persistence, store, adapter, created, sessions, root, seam, backend, backendFiber, loopPackage, mount, seed, peer,
  async rejected(cold: Awaited<ReturnType<typeof seed>>) {
   await cold.unchanged(); assert.equal(created.length, 0); assert.equal(sessions.length, 0); assert.equal(adapter.requests.length, 0)
   assert.equal(ctx.agents.get(cold.id), undefined); assert.equal(store.get(cold.id), undefined)
   // A new independent backend can take the OS lease, then refuse without migrating.
   const other = await peer(), reached = Error('writer reopened without publication')
   await assert.rejects(other.openWithAdmission(cold.id, () => {throw reached}), error => error === reached)
   await cold.unchanged()
  },
  async inbox(cold: Awaited<ReturnType<typeof seed>>) {
   const handle = await persistence.open(cold.id, 'write')
   try {
    const read = await handle.read()
    const session = Session.fromRestore(cold.id, read.events, handle.header, handle.inheritedEventCount, read.eventState)
    return ctx.sessionProjections.stateOf(session, 'inbox')
   } finally {await handle.close()}
  },
 }
}

function assertFrozen(value: unknown) {
 if (value === null || typeof value !== 'object') return
 assert.ok(Object.isFrozen(value))
 for (const child of Object.values(value)) assertFrozen(child)
}

for (const version of [3, 4] as const) for (const compression of ['none', 'zstd'] as const)
 for (const inherited of [false, true]) for (const torn of [false, true]) {
 test(`v${version}/${compression}/inherited=${inherited}/torn=${torn}: read-only候选异步拒绝保持所有日志字节`, options, async t => {
  const f = await fixture(t, compression), cold = await f.seed(version, inherited, torn), {loop} = await f.mount()
  let calls = 0
  loop.installRestoreAdmission(async candidate => {
   calls++; assert.ok(Object.isFrozen(candidate)); assertFrozen(candidate.header); assertFrozen(candidate.events)
   assert.deepEqual(Object.keys(candidate).sort(), ['events', 'header', 'inheritedEventCount', 'sessionId', 'signal'])
   assert.equal(candidate.sessionId, cold.id); assert.deepEqual(candidate.header, cold.header)
   assert.deepEqual(candidate.events, cold.events); assert.equal(candidate.inheritedEventCount, cold.count)
   assert.ok(candidate.signal instanceof AbortSignal); assert.equal(Object.isFrozen(candidate.signal), false)
   await cold.unchanged(); await immediate(); throw Error('checkpoint denied')
  })
  await assert.rejects(f.ctx.agents.resume({resumeSessionId: cold.id, agentOptions: route}), denied)
  assert.equal(calls, 1); await f.rejected(cold)
 })
}

for (const compression of ['none', 'zstd'] as const) {
 test(`v3/${compression}: required缺provider不发布v4`, options, async t => {
  const f = await fixture(t, compression), cold = await f.seed(3, true, true); await f.mount()
  await assert.rejects(f.ctx.agents.resume({resumeSessionId: cold.id, agentOptions: route}), denied)
  await f.rejected(cold)
 })
 for (const cause of ['caller', 'owner', 'factory'] as const) {
  test(`v3/${compression}: never-resolve policy期间${cause}取消，单一OSlease及时释放`, options, async t => {
   const f = await fixture(t, compression), cold = await f.seed(3, true, true), {loop, fiber} = await f.mount(), other = await f.peer()
   const ready = deferred<Context>(), owner = f.ctx.plugin({inject: ['agents'], apply(ctx: Context) {ready.resolve(ctx)}}), ownerCtx = await ready.promise
   const entered = deferred<Candidate>(), late = deferred<Lease>(), controller = new AbortController()
   let assertions = 0
   loop.installRestoreAdmission(candidate => {entered.resolve(candidate); return late.promise})
   const restoring = ownerCtx.agents.resume({resumeSessionId: cold.id, agentOptions: route, signal: controller.signal})
   const rejected = assert.rejects(restoring, /cancel migration|owner disposed|not active/)
   const candidate = await entered.promise
   await assert.rejects(other.open(cold.id, 'write'), f.seam.namespace.SessionAlreadyOwnedError)
   await cold.unchanged(); assert.equal(f.created.length, 0); assert.equal(f.adapter.requests.length, 0)
   const disposing = cause === 'owner' ? owner.dispose() : cause === 'factory' ? fiber.dispose() : undefined
   if (cause === 'caller') controller.abort(Error('cancel migration'))
   await rejected; await disposing
   assert.equal(candidate.signal.aborted, true); await f.rejected(cold)
   late.resolve(Object.freeze({assertCurrent() {assertions++; return undefined}})); await immediate()
   assert.equal(assertions, 0); await f.rejected(cold)
  })
 }
}

for (const version of [3, 4] as const) for (const compression of ['none', 'zstd'] as const) {
 test(`v${version}/${compression}: 合法继承+torn可准入，精确历史保留且pending到成功返回才进入deterministic模型`, options, async t => {
  const f = await fixture(t, compression), cold = await f.seed(version, true, true), {loop} = await f.mount()
  const entered = deferred<void>(), permit = deferred<Lease>()
  loop.installRestoreAdmission(candidate => {
   assert.deepEqual(candidate.events, cold.events); assert.equal(candidate.inheritedEventCount, cold.count)
   entered.resolve(); return permit.promise
  })
  f.ctx.on('agent/created', ({agent}) => {agent.steer(createUserMessage({source: {kind: 'user'}, content: [{type: 'text', text: 'wake migrated pending'}]})); return undefined})
  const restoring = f.ctx.agents.resume({resumeSessionId: cold.id, agentOptions: route})
  await entered.promise; await cold.unchanged(); assert.equal(f.adapter.requests.length, 0)
  permit.resolve(lease()); const handle = await restoring; await handle.agent.whenIdle()
  assert.equal(f.adapter.requests.length, 1); assert.equal(handle.agent.session.inheritedEventCount, cold.count)
  assert.match(JSON.stringify(f.adapter.requests[0]!.messages), /pending next-turn/)
  assert.match(JSON.stringify(f.adapter.requests[0]!.messages), /pending next-step/)
  assert.deepEqual(handle.agent.session.snapshotEvents().slice(0, cold.events.length), cold.events)
  if (version === 3) for (const [name, bytes] of cold.before) assert.deepEqual(await readFile(join(cold.dir, name)), bytes)
  assert.ok((await readFile(cold.current)).length > 0)
  await handle.dispose()
 })
}

for (const original of [false, true]) {
 test(`普通Free open保留合法v3迁移，originalBackend=${original}`, options, async t => {
  const f = await fixture(t, 'none', original), cold = await f.seed(3, true, true)
  const writer = await f.persistence.open(cold.id, 'write')
  assert.deepEqual((await writer.read()).events, cold.events); assert.equal(writer.inheritedEventCount, cold.count)
  await writer.close(); assert.ok((await readFile(cold.current)).length > 0)
  for (const [name, bytes] of cold.before) assert.deepEqual(await readFile(join(cold.dir, name)), bytes)
 })
}

test('同一backend与唯一policy拒绝后可重新准入合法v3，不永久封死迁移', options, async t => {
 const f = await fixture(t), cold = await f.seed(3, true, true), {loop} = await f.mount()
 let permitted = false, calls = 0
 loop.installRestoreAdmission(candidate => {
  calls++; assert.deepEqual(candidate.events, cold.events); assert.equal(candidate.inheritedEventCount, cold.count)
  if (!permitted) throw Error('checkpoint denied')
  return lease()
 })
 await assert.rejects(f.ctx.agents.resume({resumeSessionId: cold.id, agentOptions: route}), denied)
 await cold.unchanged(); permitted = true
 const restored = await f.ctx.agents.resume({resumeSessionId: cold.id, agentOptions: route})
 assert.equal(calls, 2); assert.ok((await readFile(cold.current)).length > 0)
 assert.deepEqual(f.ctx.sessionProjections.stateOf(restored.agent.session, 'inbox'), cold.inbox)
 assert.equal(f.adapter.requests.length, 0)
 await restored.dispose()
})

test('public基类明确unsupported fail closed，不调用普通open；旧backend启用Loop准入也拒绝', options, async t => {
 const f = await fixture(t, 'none', true), cold = await f.seed()
 const Base = f.seam.namespace.SessionPersistence as unknown as new (ctx: Context) => AdmissionPersistence
 let opens = 0
 const ctx = new Context(); t.after(() => ctx.fiber.dispose()); await ctx.plugin(Base)
 const unsupported = ctx.sessionPersistence as AdmissionPersistence
 unsupported.open = async () => {opens++; throw Error('ordinary open must never be called')}
 await assert.rejects(unsupported.openWithAdmission(cold.id, () => lease()), f.seam.namespace.SessionAdmissionUnsupportedError)
 assert.equal(opens, 0)
 const {loop} = await f.mount(); loop.installRestoreAdmission(() => lease())
 await assert.rejects(f.ctx.agents.resume({resumeSessionId: cold.id, agentOptions: route}), /requires session persistence openWithAdmission/)
 await cold.unchanged(); assert.equal(f.created.length, 0); assert.equal(f.adapter.requests.length, 0)
})

test('public JSONL API未传signal时backend卸载仍取消无限policy并释放OSlease', options, async t => {
 const f = await fixture(t), cold = await f.seed(), other = await f.peer(), entered = deferred<Candidate>(), late = deferred<Lease>()
 let assertions = 0
 const opening = f.persistence.openWithAdmission(cold.id, candidate => {entered.resolve(candidate); return late.promise})
 const rejected = assert.rejects(opening, /admission owner disposed/)
 const candidate = await entered.promise
 await assert.rejects(other.open(cold.id, 'write'), f.seam.namespace.SessionAlreadyOwnedError)
 const disposing = f.backendFiber.dispose()
 await rejected; await disposing; assert.equal(candidate.signal.aborted, true)
 const reached = Error('independent writer reopened')
 await assert.rejects(other.openWithAdmission(cold.id, () => {throw reached}), error => error === reached)
 await cold.unchanged()
 late.resolve(Object.freeze({assertCurrent() {assertions++; return undefined}})); await immediate()
 assert.equal(assertions, 0); await cold.unchanged()
})

for (const invalid of ['mutable', 'getter', 'promise', 'thenable', 'value'] as const) {
 test(`public JSONL API拒绝无效${invalid}lease，不能迁移`, options, async t => {
  const f = await fixture(t), cold = await f.seed()
  const policy = (() => {
   if (invalid === 'mutable') return {assertCurrent() {return undefined}}
   if (invalid === 'getter') return Object.freeze({get assertCurrent() {return () => undefined}})
   return Object.freeze({assertCurrent() {
    if (invalid === 'promise') return Promise.reject(Error('invalid async assertion'))
    if (invalid === 'thenable') return {then(_resolve: unknown, reject: (error: Error) => void) {reject(Error('invalid thenable assertion'))}}
    return true
   }})
  }) as Policy
  await assert.rejects(f.persistence.openWithAdmission(cold.id, policy), /admission/)
  await immediate(); await f.rejected(cold)
 })
}

for (const window of ['stage-open', 'committed-link'] as const) for (const cause of ['abort', 'revoke'] as const) {
 test(`迁移${window}真实fs操作后的等待中${cause}：保留writer并安全收尾，已commit不假回滚`, options, async t => {
  const release = deferred<void>(), entered = deferred<void>()
  const realOpen = fs.promises.open, realLink = fs.promises.link
  // Wrap real public filesystem operations, without reflection into backend private state.
  fs.promises.open = async (...args) => {
   const handle = await realOpen(...args)
   if (window === 'stage-open' && String(args[0]).includes('session.migration.')) {entered.resolve(); await release.promise}
   return handle
  }
  fs.promises.link = async (...args) => {
   await realLink(...args)
   if (window === 'committed-link' && String(args[1]).endsWith('session.v4.jsonl')) {entered.resolve(); await release.promise}
  }
  syncBuiltinESMExports()
  t.after(() => {release.resolve(); fs.promises.open = realOpen; fs.promises.link = realLink; syncBuiltinESMExports()})
  const f = await fixture(t), cold = await f.seed(), {loop} = await f.mount(), other = await f.peer(), controller = new AbortController()
  let current = true, settled = false
  loop.installRestoreAdmission(() => Object.freeze({assertCurrent() {if (!current) throw Error('checkpoint revoked'); return undefined}}))
  const restoring = f.ctx.agents.resume({resumeSessionId: cold.id, agentOptions: route, signal: controller.signal})
  restoring.then(() => {settled = true}, () => {settled = true})
  const rejected = assert.rejects(restoring, /checkpoint revoked|cancel physical migration/)
  await entered.promise
  if (cause === 'abort') controller.abort(Error('cancel physical migration')); else current = false
  await immediate(); assert.equal(settled, false, '不能绕过正在进行的真实持久化和lock清理')
  await assert.rejects(other.open(cold.id, 'write'), f.seam.namespace.SessionAlreadyOwnedError)
  release.resolve(); await rejected
  for (const [name, bytes] of cold.before) assert.deepEqual(await readFile(join(cold.dir, name)), bytes)
  if (window === 'stage-open') await cold.unchanged()
  else {
   assert.ok((await readFile(cold.current)).length > 0, '实际commit必须保留')
   assert.deepEqual(await f.inbox(cold), cold.inbox)
  }
  assert.equal((await readdir(cold.dir)).some(name => name.endsWith('.tmp')), false)
  const reached = Error('released writer')
  await assert.rejects(other.openWithAdmission(cold.id, () => {throw reached}), error => error === reached)
  assert.equal(f.created.length, 0); assert.equal(f.sessions.length, 0); assert.equal(f.adapter.requests.length, 0)
 })
}

test('迁移后的agent publish微任务撤销仍阻止模型，精确重建两个原Inbox', options, async t => {
 const f = await fixture(t), cold = await f.seed(3, true, true), {loop} = await f.mount()
 let current = true
 loop.installRestoreAdmission(() => Object.freeze({assertCurrent() {if (!current) throw Error('checkpoint revoked'); return undefined}}))
 f.ctx.on('agent/created', () => {queueMicrotask(() => {current = false}); return undefined})
 await assert.rejects(f.ctx.agents.resume({resumeSessionId: cold.id, agentOptions: route}), denied)
 assert.deepEqual(await f.inbox(cold), cold.inbox); assert.equal(f.adapter.requests.length, 0)
 assert.equal(f.ctx.agents.get(cold.id), undefined); assert.equal(f.store.get(cold.id), undefined)
 for (const [name, bytes] of cold.before) assert.deepEqual(await readFile(join(cold.dir, name)), bytes)
})

test('公开JS/types契约：ES2022深只读候选、异步策略、同步lease与unsupported基类', options, async t => {
 const f = await fixture(t), path = join(f.root, 'api-contract.ts')
 const seamRoot = await realpath(f.seam.root), backendRoot = await realpath(f.backend.root), loopRoot = await realpath(f.loopPackage.root)
 await writeFile(path, `
import {SessionPersistence, SessionAdmissionUnsupportedError, type SessionOpenAdmission, type SessionOpenAdmissionInput, type SessionOpenAdmissionLease} from ${JSON.stringify(join(seamRoot, 'lib/types/index.js'))}
import Jsonl from ${JSON.stringify(join(backendRoot, 'lib/types/index.js'))}
import type {AgentLoopRestoreAdmission} from ${JSON.stringify(join(loopRoot, 'lib/types/index.js'))}
declare const restorePolicy: AgentLoopRestoreAdmission
const compatiblePolicy: SessionOpenAdmission = restorePolicy
declare const input: SessionOpenAdmissionInput
declare const storage: SessionPersistence
declare const jsonl: Jsonl
const lease: SessionOpenAdmissionLease = Object.freeze({assertCurrent() {return undefined}})
const policy: SessionOpenAdmission = async candidate => {
 // @ts-expect-error candidate header must be deeply readonly
 candidate.header.createdAt = 0
 // @ts-expect-error validated history must be readonly
 candidate.events.push({})
 // @ts-expect-error event internals are deeply readonly
 candidate.events[0].time = 0
 return lease
}
// @ts-expect-error Promise assertion cannot satisfy synchronous undefined
const invalid: SessionOpenAdmissionLease = {async assertCurrent() {}}
storage.openWithAdmission(input.sessionId, policy, {signal: input.signal})
jsonl.openWithAdmission(input.sessionId, policy)
const error: Error = new SessionAdmissionUnsupportedError()
`)
 const program = ts.createProgram([path], {noEmit: true, strict: true, skipLibCheck: true, target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler,
  typeRoots: [fileURLToPath(new URL('../../../node_modules/@types', import.meta.url))]})
 const diagnostics = ts.getPreEmitDiagnostics(program)
 assert.deepEqual(diagnostics.map(diagnostic => `${diagnostic.file?.fileName}:${diagnostic.file && diagnostic.start !== undefined ? diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start).line + 1 : ''}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')}`), [])
})
