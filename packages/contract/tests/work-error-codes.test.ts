import test from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { workErrorCodes } from '../src/work-error.ts'

const officialWorkErrorCodes = [
  'teloa/invalid-input',
  'teloa/forbidden',
  'teloa/version-conflict',
  'teloa/conflict',
  'teloa/dependency-unavailable',
  'teloa/storage-corrupt',
  'teloa/source-unavailable',
  'teloa/invalid-host-response',
] as const

test('workErrorCodes 前八项逐字等于八个正式码', () => {
  assert.deepEqual(workErrorCodes.slice(0, 8), officialWorkErrorCodes)
})

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url))

/** 递归收集某目录下所有文件路径，跳过 lib/ 与 tests/ 子目录。 */
function collectFiles(dir: string): string[] {
  const entries = (() => { try { return readdirSync(dir, { withFileTypes: true }) } catch { return [] } })()
  const files: string[] = []
  for (const entry of entries) {
    if (entry.name === 'lib' || entry.name === 'tests' || entry.name === 'node_modules') continue
    const path = join(dir, entry.name)
    if (entry.isDirectory()) files.push(...collectFiles(path))
    else if (entry.isFile() && /\.(ts|tsx)$/.test(entry.name)) files.push(path)
  }
  return files
}

function packageSrcDirs(): string[] {
  const dirs: string[] = []
  const packagesRoot = join(repoRoot, 'packages')
  for (const name of readdirSync(packagesRoot)) {
    const pkgPath = join(packagesRoot, name)
    if (!statSync(pkgPath).isDirectory()) continue
    const srcPath = join(pkgPath, 'src')
    try {
      if (statSync(srcPath).isDirectory()) dirs.push(srcPath)
    } catch {
      // 没有 src 目录（例如带子包的 client/），继续检查其子目录
      for (const sub of readdirSync(pkgPath)) {
        const subSrcPath = join(pkgPath, sub, 'src')
        try {
          if (statSync(subSrcPath).isDirectory()) dirs.push(subSrcPath)
        } catch {
          // 忽略
        }
      }
    }
  }
  return dirs
}

test('生产代码中经 new WorkError(...) 构造的字面量码，均已收录在 workErrorCodes 内', () => {
  const known = new Set<string>(workErrorCodes)
  const offenders: string[] = []
  for (const dir of packageSrcDirs()) {
    for (const file of collectFiles(dir)) {
      const text = readFileSync(file, 'utf8')
      const re = /new WorkError\(\s*'(teloa\/[a-z-]+)'/g
      let match: RegExpExecArray | null
      while ((match = re.exec(text))) {
        const code = match[1]!
        if (!known.has(code)) offenders.push(`${file}: ${code}`)
      }
    }
  }
  assert.deepEqual(offenders, [])
})

test('i18n 错误码词典（errors.ts）里的 teloa/* 键均已收录在 workErrorCodes 内', () => {
  const known = new Set<string>(workErrorCodes)
  const errorsFile = join(repoRoot, 'packages/client/ui-workbench/src/client/i18n/errors.ts')
  const text = readFileSync(errorsFile, 'utf8')
  const re = /'(teloa\/[a-z-]+)'\s*:/g
  const offenders: string[] = []
  let match: RegExpExecArray | null
  while ((match = re.exec(text))) {
    const code = match[1]!
    if (!known.has(code)) offenders.push(code)
  }
  assert.deepEqual(offenders, [])
})
