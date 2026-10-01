// 源自 dsh-im-gateway（https://github.com/zhuiyueya/dsh-im-gateway，commit c907dd5，MIT，Copyright (c) 2026 zhuiyueya）。
// Teloa 修改：锁位置由 `${dshHome}/dsh-im-gateway/instance.lock` 参数化为显式 lockPath；函数改名 acquireInstanceLock，存活冲突抛 InstanceLockHeldError{pid}；回收陈旧锁先 rename 到唯一临时名、核对仍是判定陈旧的那把再删，否则放回并放弃抢锁（上游直接 unlink，判定与删除之间可能删掉别人刚抢到的新锁）；对外错误改为 WorkError('teloa/dependency-unavailable') 固定文案，不含锁路径与 PID。许可全文见 packages/im-gateway/licenses/dsh-im-gateway.LICENSE，来源记录见 provenance/dsh-im-gateway.md。
import { randomUUID } from 'node:crypto'
import { closeSync, fsyncSync, linkSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { WorkError } from '@teloa/contract'

interface LockOwner {
  pid: number
  token: string
  acquiredAt: string
}

export interface InstanceLock {
  readonly path: string
  release(): void
}

export interface InstanceLockOptions {
  pid?: number
  token?: string
  acquiredAt?: string
  isProcessAlive?: (pid: number) => boolean
}

const lockUnavailableMessage = 'IM 通道已由本机另一个 Teloa 进程连接；同一运行目录只允许一个进程连接 IM 渠道。'

/** 另一存活进程持有实例锁。对外即 teloa/dependency-unavailable；文案固定，不含锁路径；PID 只留在 pid 字段供日志。 */
export class InstanceLockHeldError extends WorkError {
  readonly pid: number
  constructor(pid: number) {
    super('teloa/dependency-unavailable', lockUnavailableMessage)
    this.name = 'InstanceLockHeldError'
    this.pid = pid
  }
}

export function acquireInstanceLock(
  lockPath: string,
  options: InstanceLockOptions = {},
): InstanceLock {
  const pid = options.pid ?? process.pid
  const token = options.token ?? randomUUID()
  const owner: LockOwner = {
    pid,
    token,
    acquiredAt: options.acquiredAt ?? new Date().toISOString(),
  }
  const isProcessAlive = options.isProcessAlive ?? processIsAlive
  const path = resolve(lockPath)
  const lockDir = dirname(path)
  const tempPath = join(lockDir, `.${basename(path)}.${pid}.${token}.tmp`)
  const stalePath = join(lockDir, `.${basename(path)}.${pid}.${token}.stale`)
  mkdirSync(lockDir, { recursive: true, mode: 0o700 })
  writeOwnerFile(tempPath, owner)

  try {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        linkSync(tempPath, path)
        unlinkSync(tempPath)
        return {
          path,
          release: () => releaseOwnedLock(path, owner),
        }
      } catch (error) {
        if (!isNodeError(error) || error.code !== 'EEXIST') throw error
      }

      const current = readOwner(path)
      if (current && isProcessAlive(current.pid)) {
        throw new InstanceLockHeldError(current.pid)
      }
      try {
        renameSync(path, stalePath)
      } catch (error) {
        if (!isNodeError(error) || error.code !== 'ENOENT') throw error
        continue
      }
      const moved = readOwner(stalePath)
      if (moved?.pid !== current?.pid || moved?.token !== current?.token) {
        // 判定陈旧后锁已被别人换新：放回原处并放弃抢锁（放回失败说明又有新锁落地，丢弃挪走的这把）。
        try {
          linkSync(stalePath, path)
        } catch (error) {
          if (!isNodeError(error) || error.code !== 'EEXIST') throw error
        }
        unlinkSync(stalePath)
        if (moved) throw new InstanceLockHeldError(moved.pid)
        break
      }
      unlinkSync(stalePath)
    }
    throw new WorkError('teloa/dependency-unavailable', lockUnavailableMessage)
  } finally {
    try {
      unlinkSync(tempPath)
    } catch (error) {
      if (!isNodeError(error) || error.code !== 'ENOENT') throw error
    }
  }
}

function writeOwnerFile(path: string, owner: LockOwner): void {
  const fd = openSync(path, 'wx', 0o600)
  try {
    writeFileSync(fd, `${JSON.stringify(owner)}\n`)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

function releaseOwnedLock(path: string, owner: LockOwner): void {
  const current = readOwner(path)
  if (!current || current.pid !== owner.pid || current.token !== owner.token) return
  try {
    unlinkSync(path)
  } catch (error) {
    if (!isNodeError(error) || error.code !== 'ENOENT') throw error
  }
}

function readOwner(path: string): LockOwner | undefined {
  try {
    const value = JSON.parse(readFileSync(path, 'utf8')) as Partial<LockOwner>
    if (!Number.isInteger(value.pid) || typeof value.token !== 'string' || typeof value.acquiredAt !== 'string') {
      return undefined
    }
    return value as LockOwner
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return undefined
    if (error instanceof SyntaxError) return undefined
    throw error
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return isNodeError(error) && error.code === 'EPERM'
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error
}
