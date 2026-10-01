import assert from 'node:assert/strict'
import test from 'node:test'
import {readFileSync} from 'node:fs'
import {createRequire} from 'node:module'
import {resolve} from 'node:path'

const root=resolve(import.meta.dirname,'..')
// 与 scripts/构建npm发行包.mjs 同源解析 YAML，不依赖 overrides 条目的引号写法
const {parse}=createRequire(resolve(root,'packages/harness-dsh/package.json'))('yaml')
const workspace=parse(readFileSync(resolve(root,'pnpm-workspace.yaml'),'utf8'))
const client=JSON.parse(readFileSync(resolve(root,'packages/client/ui-workbench/package.json'),'utf8'))
const baseline=JSON.parse(readFileSync(resolve(root,'config/dsh-baseline.json'),'utf8'))
const version=baseline.tag.replace(/^dsh-v/,'')
const added=['@deepseek-ai/dsh-client-ui-dockkit','@deepseek-ai/dsh-client-ui-primitives','@deepseek-ai/dsh-client-ui-sidebar-right']

test('右栏三个类型来源都被 overrides 钉到基线版本',()=>{
 for(const name of added)assert.equal(String(workspace.overrides[name]),version,name+' 缺 override 或版本不对')
})

test('客户端插件以 devDependency 精确声明三个包，只用于类型',()=>{
 for(const name of added)assert.equal(client.devDependencies[name],version,name+' 的 devDependency 版本不对')
 for(const name of added)assert.equal(client.dependencies[name],undefined,name+' 不应进运行期 dependencies')
})

// 0.1.7-rc.1 起版本基线沿所有工作区 dependencies+devDependencies 与 peers 遍历（scripts/核对DSH依赖.mjs dshDependencyRoots），
// dockkit 经客户端 devDependency、primitives 经 dsh 官方图进入基线；口径改为"与 @deepseek-ai/dsh 同版本"而非"不在图里"。
test('版本基线一致：三个包在基线里且与 @deepseek-ai/dsh 同版本',()=>{
 const versions=JSON.parse(readFileSync(resolve(root,'config/dsh-package-versions.json'),'utf8')).versions
 for(const name of added)assert.equal(versions[name],versions['@deepseek-ai/dsh'],name+' 与 @deepseek-ai/dsh 版本不一致')
})
