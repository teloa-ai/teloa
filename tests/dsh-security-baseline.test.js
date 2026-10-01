import assert from 'node:assert/strict'
import {test} from 'node:test'
import {createRequire} from 'node:module'
import {dirname} from 'node:path'
import {pathToFileURL} from 'node:url'

const rootRequire=createRequire(import.meta.url)
const dshManifest=rootRequire.resolve('@deepseek-ai/dsh/package.json')
const instructionsManifest=createRequire(dshManifest).resolve('@deepseek-ai/dsh-agent-instructions/package.json')
const instructions=await import(pathToFileURL(dirname(instructionsManifest)+'/lib/index.js'))

test('DSH 项目根标记探测遇到权限错误时停止，不向上读取其他项目指令',async()=>{
  const denied=Object.assign(new Error('permission denied'),{code:'EACCES'})
  const fileSystem={
    resolve:async path=>path,
    stat:async()=>{throw denied},
  }
  await assert.rejects(
    instructions.loadBaselineInstructions({
      cwd:'/sandbox/project',
      projectRootMarkers:['.git'],
      instructionFileCandidates:['AGENTS.md'],
      localInstructionFileCandidates:[],
      maxBytes:1024,
    },fileSystem),
    error=>error===denied,
  )
})
