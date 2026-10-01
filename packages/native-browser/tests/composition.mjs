import assert from 'node:assert/strict'
import {existsSync, readFileSync} from 'node:fs'
import {createRequire} from 'node:module'
import {resolve} from 'node:path'
import {fileURLToPath} from 'node:url'

export const projectRoot=fileURLToPath(new URL('../../../',import.meta.url))
const rootRequire=createRequire(resolve(projectRoot,'package.json'))
const dshRequire=createRequire(rootRequire.resolve('@deepseek-ai/dsh/package.json'))
export const {composeEntries,loadOverlayPatches,bundlePatchPaths}=await import(dshRequire.resolve('@deepseek-ai/dsh-app-boot'))

export const baseline=[{insert:[
  {id:'sandbox-policy',name:'@deepseek-ai/dsh-sandbox-policy',config:{mode:'workspace-write',workspaceRoot:'/isolated/work'}},
  {id:'approval',name:'@deepseek-ai/dsh-user-approval',config:{policy:'ask'}},
  {id:'permission',name:'@deepseek-ai/dsh-permission-presets',config:{presets:{'workspace-write':{sandbox:'workspace-write',approval:'ask'}}}},
  {id:'tools',name:'@deepseek-ai/dsh-tools',config:{mode:'native'}},
]}]

export function readPackage(directory){
  const path=resolve(directory,'package.json')
  assert.ok(existsSync(path),'可选能力应提供可读取的包清单')
  return JSON.parse(readFileSync(path,'utf8'))
}

export function bundle(directory){
  const manifest=readPackage(directory)
  assert.ok(manifest.dsh?.bundle,'原生插件管理必须能识别真实 bundle')
  return {manifest,patches:bundlePatchPaths(directory,manifest.dsh.bundle).flatMap(path=>loadOverlayPatches('native capability test',path))}
}

export function shippedLayers(){
  return ['dsh-base','dsh-headless'].flatMap(name=>{
    const path=dshRequire.resolve('@deepseek-ai/'+name+'/package.json')
    const directory=resolve(path,'..'),manifest=JSON.parse(readFileSync(path,'utf8'))
    return bundlePatchPaths(directory,manifest.dsh.bundle).map(file=>loadOverlayPatches('native remote test',file))
  })
}
