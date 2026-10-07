import test, {type TestContext} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp, readFile, readdir, rm, writeFile} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {fileURLToPath} from 'node:url'
import ts from 'typescript'
import {Context} from '@deepseek-ai/cordis'
import {createUserMessage} from '@deepseek-ai/dsh-llm'
import {foldConsumedWork} from '@deepseek-ai/dsh-agent'
import {Session, SessionStore, SessionId, SessionSeq, SessionLogOffset, type SessionEvent} from '@deepseek-ai/dsh-session'
import {SessionProjectionRegistry, type ProjectionDefinition} from '@deepseek-ai/dsh-session-projection'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import {patchedNativePackage} from './fixtures/native-patched-package.ts'

type LoopPackage = typeof import('@deepseek-ai/dsh-agent-loop') & {
 inboxProjectionDefinition: ProjectionDefinition<'inbox'> & {wire: NonNullable<ProjectionDefinition<'inbox'>['wire']>}
}

async function fixture(t: TestContext, compression: 'none' | 'zstd' = 'none') {
 const pkg = await patchedNativePackage<LoopPackage>(t, {
  packageName: '@deepseek-ai/dsh-agent-loop', compatBasename: 'dsh-agent-loop-0.2.0-rc.2-work-admission',
 })
 const root = await mkdtemp(join(tmpdir(), 'teloa-inbox-maintenance-')), ctx = new Context()
 t.after(async () => {await ctx.fiber.dispose(); await rm(root, {recursive: true, force: true})})
 await ctx.plugin(SessionStore)
 await ctx.plugin(SessionProjectionRegistry)
 await ctx.plugin(JsonlSessionPersistence, {root, compression})
 const dispose = ctx.sessionProjections.register(pkg.namespace.inboxProjectionDefinition)
 const sessions = ctx.get('sessions')
 assert.ok(sessions instanceof SessionStore)
 // 维护上下文只有官方存储和投影；不构造 Loop/Agent，也没有模型或工具服务。
 for (const key of ['agentLoop', 'agents', 'llm', 'tools', 'sessionController']) assert.equal(ctx.get(key), undefined)
 assert.equal(sessions.list().length, 0)
 return {ctx, root, pkg, dispose, sessions}
}

for (const compression of ['none', 'zstd'] as const) {
 test('公开原 Inbox 定义支持纯存储取消两队列并保留完整原前缀：' + compression, {timeout: 15000}, async t => {
  const f = await fixture(t, compression), id = SessionId('maintenance-' + compression)
  const root = createUserMessage({source: {kind: 'user', rpcId: 'source-request'}, content: [{type: 'text', text: '原安装未执行输入'}]})
  const context = createUserMessage({source: {kind: 'tool', callId: 'source-tool-call' as never}, content: [{type: 'text', text: '原日志中的派生上下文'}]})
  const prefix: SessionEvent[] = [
   {type: 'agent/inbox/spliced', seq: SessionSeq(0), time: 1, data: {target: 'next-turn', start: 0, inserted: [root]}},
   {type: 'agent/inbox/spliced', seq: SessionSeq(1), time: 2, data: {target: 'next-step', start: 0, inserted: [context]}},
   {type: 'session/end-seed', seq: SessionSeq(2), time: 3, data: {inherited: true}},
   {type: 'turn/start', seq: SessionSeq(3), time: 4, data: {turn: 1}},
   {type: 'step/start', seq: SessionSeq(4), time: 5, data: {turn: 1, step: 1}},
  ]
  const header = {...Session.create(id).header, delegationDepth: 0, isSeeded: true, parentSession: SessionId('original-parent')}
  const inheritedEventCount = SessionLogOffset(2)
  const created = await f.ctx.sessionPersistence.create(header, {inheritedEventCount})
  try {await created.append(prefix); await created.flush()} finally {await created.close()}
  const files = (await readdir(f.root, {recursive: true})).filter(path => path.endsWith(compression === 'none' ? '.jsonl' : '.jsonl.zstd'))
  assert.equal(files.length, 1)
  const physicalPath = join(f.root, files[0]!), originalBytes = await readFile(physicalPath)
  const writer = await f.ctx.sessionPersistence.open(id, 'write')
  try {
   const original = await writer.read()
   assert.deepEqual(original.events, prefix)
   const projected = f.ctx.sessionProjections.restore({}, original.events, SessionLogOffset(0), writer.header, writer.inheritedEventCount)
   assert.equal(projected.snapshot.asOfSeq, prefix.length - 1)
   const inbox = projected.snapshot.values.inbox
   assert.ok(inbox); assert.deepEqual(inbox, {'next-turn': [root], 'next-step': [context]})
   // 与官方 clear() 顺序一致；只记录未执行取消，不生成 turn/end、工具结果或新受理。
   const suffix: SessionEvent<'agent/inbox/spliced'>[] = (['next-step', 'next-turn'] as const).map((target, index) => ({
    type: 'agent/inbox/spliced', seq: SessionSeq(prefix.length + index), time: 6 + index,
    data: {target, start: 0, removedCount: inbox[target].length, inserted: [], outcome: 'canceled'},
   }))
   const planned = f.ctx.sessionProjections.restore({}, [...original.events, ...suffix], SessionLogOffset(0), writer.header, writer.inheritedEventCount)
   assert.deepEqual(planned.snapshot.values.inbox, {'next-turn': [], 'next-step': []})
   await writer.append(suffix); await writer.flush()
   const stored = await writer.read()
   assert.deepEqual(stored.events.slice(0, prefix.length), prefix)
   assert.deepEqual(stored.events.slice(prefix.length), suffix)
   assert.deepEqual(writer.header, header); assert.equal(writer.inheritedEventCount, inheritedEventCount)
   const final = f.ctx.sessionProjections.restore({}, stored.events, SessionLogOffset(0), writer.header, writer.inheritedEventCount)
   assert.deepEqual(final.snapshot.values.inbox, {'next-turn': [], 'next-step': []})
   assert.equal(final.snapshot.asOfSeq, prefix.length + suffix.length - 1)
   assert.deepEqual(foldConsumedWork(stored.events), {droppedUnrun: true})
   assert.equal(f.sessions.list().length, 0)
   for (const key of ['agentLoop', 'agents', 'llm', 'tools', 'sessionController']) assert.equal(f.ctx.get(key), undefined)
  } finally {await writer.close()}
  // 编码由官方 JSONL 后端处理；当前格式追加不改原始文件前缀，包括 zstd 帧。
  assert.deepEqual((await readFile(physicalPath)).subarray(0, originalBytes.length), originalBytes)
  const reader = await f.ctx.sessionPersistence.open(id, 'read')
  try {
   const stored = await reader.read()
   assert.equal(stored.events.length, prefix.length + 2)
   assert.deepEqual(f.ctx.sessionProjections.restore({}, stored.events, SessionLogOffset(0), reader.header, reader.inheritedEventCount).snapshot.values.inbox, {'next-turn': [], 'next-step': []})
  } finally {await reader.close()}
 })
}

test('独立注册复用标准坏日志拒绝规则，卸载后不会把能力缺失当空 Inbox', {timeout: 15000}, async t => {
 const f = await fixture(t), id = SessionId('maintenance-invalid'), header = Session.create(id).header
 const message = createUserMessage({source: {kind: 'user'}, content: [{type: 'text', text: 'pending'}]})
 const insert: SessionEvent<'agent/inbox/spliced'> = {type: 'agent/inbox/spliced', seq: SessionSeq(0), time: 1, data: {target: 'next-turn', start: 0, inserted: [message]}}
 const restore = (events: readonly SessionEvent[]) => f.ctx.sessionProjections.restore({}, events, SessionLogOffset(0), header, SessionLogOffset(0))
 assert.deepEqual(restore([insert]).snapshot.values.inbox, {'next-turn': [message], 'next-step': []})
 for (const data of [
  {target: 'next-turn' as const, start: -1, inserted: []},
  {target: 'next-turn' as const, start: 0, removedCount: 2, inserted: []},
  {target: 'next-step' as const, start: 0, inserted: [message]},
 ]) assert.throws(() => restore([insert, {type: 'agent/inbox/spliced', seq: SessionSeq(1), time: 2, data}]), /invalid persisted inbox splice/)
 assert.throws(() => restore([{...insert, seq: SessionSeq(1)}]), /missing seq/)
 assert.equal(Reflect.get(f.pkg.namespace, 'ReactLoopInbox'), undefined)
 f.dispose()
 assert.equal(restore([insert]).snapshot.values.inbox, undefined)
})

test('补丁公开类型入口直接复用官方 Inbox declaration，可注册到官方 registry', {timeout: 15000}, async t => {
 const f = await fixture(t), path = join(f.pkg.root, 'inbox-maintenance-type-contract.ts')
 await writeFile(path, `import {inboxProjectionDefinition} from './lib/types/index.js'
import {inboxProjectionDefinition as originalDefinition} from './lib/types/inbox.js'
import {SessionProjectionRegistry} from '@deepseek-ai/dsh-session-projection'
declare const registry: SessionProjectionRegistry
const originalType: typeof originalDefinition = inboxProjectionDefinition
const exportedType: typeof inboxProjectionDefinition = originalDefinition
registry.register(originalType)
registry.register(exportedType)
// @ts-expect-error the official key is exactly inbox
const key: 'other' = inboxProjectionDefinition.key
// @ts-expect-error a projection definition is not an Inbox mutation command
inboxProjectionDefinition.clear()
`)
 const program = ts.createProgram([path], {noEmit: true, strict: true, skipLibCheck: true,
  module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler, target: ts.ScriptTarget.ES2022,
  typeRoots: [fileURLToPath(new URL('../../../node_modules/@types', import.meta.url))],
 })
 assert.deepEqual(ts.getPreEmitDiagnostics(program).map(diagnostic => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')), [])
})
