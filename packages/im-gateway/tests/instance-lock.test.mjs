// 源自 dsh-im-gateway（https://github.com/zhuiyueya/dsh-im-gateway，commit c907dd5，MIT，Copyright (c) 2026 zhuiyueya）。
// Teloa 修改：import 改指源码 ../src/instance-lock.ts，acquireDshHomeInstanceLock → acquireInstanceLock(lockPath)，冲突断言 InstanceLockHeldError；withTempHome 改为直接传 lockPath；新增对外错误码与固定文案用例。许可全文见 packages/im-gateway/licenses/dsh-im-gateway.LICENSE，来源记录见 provenance/dsh-im-gateway.md。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { acquireInstanceLock, InstanceLockHeldError } from '../src/instance-lock.ts'
import { WorkError } from '@teloa/contract'

function withTempLock(run) {
  const root = mkdtempSync(join(tmpdir(), 'teloa-im-gateway-lock-'))
  try {
    return run(join(root, 'im-gateway', 'instance.lock'))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

test('同一锁路径拒绝第二个存活进程', () => withTempLock((lockPath) => {
  const first = acquireInstanceLock(lockPath, {
    pid: 101,
    token: 'first',
    acquiredAt: '2026-08-16T00:00:00.000Z',
    isProcessAlive: (pid) => pid === 101,
  })

  assert.throws(
    () => acquireInstanceLock(lockPath, {
      pid: 202,
      token: 'second',
      isProcessAlive: (pid) => pid === 101,
    }),
    (error) => error instanceof InstanceLockHeldError && error.pid === 101,
  )

  first.release()
  const second = acquireInstanceLock(lockPath, {
    pid: 202,
    token: 'second',
    isProcessAlive: () => false,
  })
  second.release()
}))

test('陈旧锁可回收，旧 owner 不能删除新锁', () => withTempLock((lockPath) => {
  const stale = acquireInstanceLock(lockPath, {
    pid: 303,
    token: 'stale',
    isProcessAlive: () => false,
  })
  const current = acquireInstanceLock(lockPath, {
    pid: 404,
    token: 'current',
    isProcessAlive: () => false,
  })

  stale.release()
  const owner = JSON.parse(readFileSync(current.path, 'utf8'))
  assert.equal(owner.pid, 404)
  assert.equal(owner.token, 'current')
  current.release()
}))

// ── Teloa 新增 ──

test('另一存活 PID 持锁：抛 InstanceLockHeldError 且 pid 正确，锁文件保持原 owner', () => withTempLock((lockPath) => {
  const holder = acquireInstanceLock(lockPath, { pid: 555, token: 'holder', isProcessAlive: () => true })
  let caught
  try {
    acquireInstanceLock(lockPath, { pid: 666, token: 'other', isProcessAlive: (pid) => pid === 555 })
  } catch (error) {
    caught = error
  }
  assert.ok(caught instanceof InstanceLockHeldError)
  assert.equal(caught.pid, 555)
  assert.equal(JSON.parse(readFileSync(lockPath, 'utf8')).pid, 555)
  holder.release()
}))

test('InstanceLockHeldError 对外即 WorkError teloa/dependency-unavailable，固定文案不含锁路径与 PID', () => withTempLock((lockPath) => {
  const holder = acquireInstanceLock(lockPath, { pid: 4242, token: 'holder', isProcessAlive: () => true })
  let caught
  try {
    acquireInstanceLock(lockPath, { pid: 4343, token: 'other', isProcessAlive: () => true })
  } catch (error) {
    caught = error
  }
  assert.ok(caught instanceof WorkError)
  assert.equal(caught.code, 'teloa/dependency-unavailable')
  assert.equal(caught.message, 'IM 通道已由本机另一个 Teloa 进程连接；同一运行目录只允许一个进程连接 IM 渠道。')
  assert.ok(!caught.message.includes(dirname(lockPath)) && !caught.message.includes('4242'))
  assert.equal(caught.pid, 4242)
  holder.release()
}))

test('死 PID 持锁：可接管，锁文件改为新 owner', () => withTempLock((lockPath) => {
  acquireInstanceLock(lockPath, { pid: 777, token: 'dead', isProcessAlive: () => true })
  const taken = acquireInstanceLock(lockPath, { pid: 888, token: 'alive', isProcessAlive: (pid) => pid !== 777 })
  assert.equal(taken.path, lockPath)
  const owner = JSON.parse(readFileSync(lockPath, 'utf8'))
  assert.equal(owner.pid, 888)
  assert.equal(owner.token, 'alive')
  taken.release()
}))

test('release() 后锁文件不存在', () => withTempLock((lockPath) => {
  const lock = acquireInstanceLock(lockPath, { pid: 999, token: 'solo' })
  assert.ok(existsSync(lockPath))
  lock.release()
  assert.ok(!existsSync(lockPath))
}))

test('M2：判定陈旧后、删除前另一进程已接管锁 → 不删新锁、放弃抢锁并报对方 PID', () => withTempLock((lockPath) => {
  acquireInstanceLock(lockPath, { pid: 1001, token: 'stale', isProcessAlive: () => true })
  let rival
  assert.throws(
    () => acquireInstanceLock(lockPath, {
      pid: 1002,
      token: 'late',
      isProcessAlive: (pid) => {
        if (pid === 1001 && !rival) {
          rival = acquireInstanceLock(lockPath, { pid: 1003, token: 'rival', isProcessAlive: (p) => p !== 1001 })
          return false
        }
        return pid === 1003
      },
    }),
    (error) => error instanceof InstanceLockHeldError && error.pid === 1003,
  )
  const owner = JSON.parse(readFileSync(lockPath, 'utf8'))
  assert.equal(owner.token, 'rival')
  assert.deepEqual(readdirSync(dirname(lockPath)), ['instance.lock'])
  rival.release()
}))
