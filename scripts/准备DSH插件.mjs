import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath,pathToFileURL } from 'node:url'
import { compositionSnapshot, compositionViolations } from '../packages/harness-dsh/src/composition-safety.ts'
import { projectRoot, verifyDshPackages } from './核对DSH依赖.mjs'
import {optionalNativeBundleSpecs,withTeloaRequiredBundles} from './runtime/profile.mjs'
// rc.1 保留已有禁用选择；仍兼容市场历史 pending 记录，使用与安装适配器相同的压制函数。
import { rewriteProfileBundles, suppressPendingBundles } from '../packages/harness-dsh/src/pending-plugins.ts'

const dshHome=resolve(process.env.TELOA_DSH_HOME||resolve(projectRoot,'.runtime/dsh'))
const profileName=process.env.TELOA_DSH_PROFILE||'teloa'
// TELOA_PROJECT_ROOT 与启动器一致：宿主的 cwd 是工作区，组合补丁里的仓库内路径按它解析。
const env={...process.env,DSH_HOME:dshHome,TELOA_PROJECT_ROOT:projectRoot}
function run(args,{capture=false}={}) {
  return new Promise((done,fail)=>{
    const child=spawn(process.execPath,args,{cwd:projectRoot,env,stdio:capture?['ignore','pipe','pipe']:'inherit'})
    let stdout='',stderr=''
    if(capture){
      child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8')
      child.stdout.on('data',chunk=>{stdout+=chunk})
      child.stderr.on('data',chunk=>{stderr+=chunk})
    }
    child.once('error',fail)
    child.once('exit',code=>code===0?done({stdout,stderr}):fail(Error('DSH 插件准备失败，退出码 '+code+(stderr?'：'+stderr.trim():''))))
  })
}

/** 使用官方 CLI 同源包管理实现，安装可选组合时明确不把新包加入启用列表。 */
export async function installOptionalNativeBundles({profileDir,profileName,installAnchor,specs=optionalNativeBundleSpecs(projectRoot),operation}){
 const execute=operation??(await import(pathToFileURL(createRequire(installAnchor).resolve('@deepseek-ai/dsh-plugin-manager/operations')).href)).runPluginCommand
 try{
  const result=await execute({profile:profileName,dir:profileDir,installAnchor,cwd:projectRoot},['add',...Object.values(specs)],{
   execution:'cli',activateNewBundles:false,outputBytes:16384,lockWaitMs:120000,lookupTimeoutMs:120000,env,
   onOutput:(text,stream)=>process[stream].write(text),
  })
  if(result.exitCode!==0)throw Error('DSH 可选插件准备失败，退出码 '+result.exitCode+'。')
 }finally{await suppressPendingBundles(profileDir)}
}
export function verifyConfig(source) {
  const rows=new Map()
  let current
  for(const line of source.split('\n')){
    const match=line.match(/^- id: (.+)$/)
    if(match){
      current={id:match[1],lines:[line]}
      const found=rows.get(current.id)??[]
      found.push(current); rows.set(current.id,found)
    }else if(current)current.lines.push(line)
  }
  const expected={
    'ui-layout': ["name: '@deepseek-ai/dsh-client-ui-layout'",'disabled: true'],
    'ui-sidebar': ["name: '@deepseek-ai/dsh-client-ui-sidebar'",'disabled: true'],
    'ui-settings-general': ["name: '@deepseek-ai/dsh-client-ui-settings-general'",'disabled: true'],
    'ui-settings-plugins': ["name: '@deepseek-ai/dsh-client-ui-settings-plugins'",'disabled: true'],
    'client-hmr': ["name: '@deepseek-ai/dsh-client-hmr'",'disabled: true'],
    'connection': ["name: '@deepseek-ai/dsh-client-connection'",'- webRuntime','- webServer'],
    'session-telemetry-otel': ["name: '@deepseek-ai/dsh-session-telemetry-otel'",'mode: DISABLED'],
    'sandbox-policy': ["name: '@deepseek-ai/dsh-sandbox-policy'",'mode: workspace-write'],
    'approval': ["name: '@deepseek-ai/dsh-user-approval'",'policy: ask'],
    'tools': ["name: '@deepseek-ai/dsh-tools'",'mode: native'],
    // 宿主平面这两行本就被上游关着；模型可见面由 Agent 预设平面决定（见下面的 teloa-agent-preset）。
    'tool-workflow': ["name: '@deepseek-ai/dsh-tool-workflow'",'disabled: true'],
    'tool-ralph': ["name: '@deepseek-ai/dsh-tool-ralph'",'disabled: true'],
    // 部署默认保持 Teloa，官方四种预设开放；plugins 正文由下方摘要复验。
    'agent-preset-registry': ["name: '@deepseek-ai/dsh-agent-preset-registry'",'default: teloa-standard'],
    'teloa-agent-preset': ["name: '@deepseek-ai/dsh-agent-preset'",'id: teloa-standard'],
    'preset-standard': ["name: '@deepseek-ai/dsh-agent-preset'",'disabled: false'],
    'preset-ptc': ["name: '@deepseek-ai/dsh-agent-preset'",'disabled: false'],
    'preset-minimal': ["name: '@deepseek-ai/dsh-agent-preset'",'disabled: false'],
    'preset-cordis': ["name: '@deepseek-ai/dsh-agent-preset'",'disabled: false'],
    'session-query-sqlite': ["name: '@deepseek-ai/dsh-session-query-sqlite'",'openAt: first-search','session-search.sqlite'],
    'teloa-ui-workbench': ["name: '@teloa/client-ui-workbench'"],
    'teloa-harness-dsh': ["name: '@teloa/harness-dsh'"],
    // maxInstructionBytes 是 MCP instructions 进系统提示的上限，上游默认 32768，这里收窄为基线 2048。
    'teloa-reference-mcp': ["name: '@deepseek-ai/dsh-mcp-client'",'serverName: teloa_reference','process.env.TELOA_PROJECT_ROOT','failOnStartupError: true','maxInstructionBytes: 2048'],
  }
  for(const [id,fragments] of Object.entries(expected)){
    const matches=rows.get(id)??[]
    if(matches.length!==1)throw Error('DSH 组合配置中的 '+id+' 应唯一存在，实际 '+matches.length+' 项。')
    const block=matches[0].lines.join('\n')
    for(const fragment of fragments)if(!block.includes(fragment))throw Error('DSH 组合配置中的 '+id+' 未保留 '+fragment+'。')
  }
  // 使用与宿主相同的声明判据；片段匹配无法发现嵌套插件被改、额外预设或同名声明。
  const { parse }=createRequire(resolve(projectRoot,'packages/harness-dsh/package.json'))('yaml')
  const document=parse(source,{customTags:[{tag:'tag:yaml.org,2002:js',resolve:expression=>({__jsExpr:expression})}]})
  if(!Array.isArray(document))throw Error('DSH 组合配置不是插件行列表。')
  const effectiveRows=document.map(row=>({...row,disabled:row.disabled===true}))
  const violations=compositionViolations(compositionSnapshot(effectiveRows)).filter(pin=>pin==='agentPresets'||pin==='tools')
  if(violations.length)throw Error('DSH 原生预设声明或工具配置未通过装配安全复验。')
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
try {
  verifyDshPackages()
  const path=resolve(dshHome,'profiles',profileName,'package.json')
  // 同一启动器通过当前 DSH 随附模板负责首次 profile 创建；配置转储不启动应用或端口。
  try { await readFile(path,'utf8') }
  catch(error){
    if(error.code!=='ENOENT')throw error
    const initial=await run([resolve(projectRoot,'scripts/启动DSH.mjs'),'--dump-config'],{capture:true})
    if(initial.stderr.trim())throw Error('DSH profile 初始化存在诊断：'+initial.stderr.trim())
  }
  const manifest=createRequire(resolve(projectRoot,'package.json')).resolve('@deepseek-ai/dsh/package.json')
  const profileDir=resolve(dshHome,'profiles',profileName)
  try{
   await run([resolve(dirname(manifest),'lib/bin.js'),'plugin','--profile',profileName,'add',
     'link:'+resolve(projectRoot,'packages/bundle'),
     'link:'+resolve(projectRoot,'packages/client/ui-workbench'),
     'link:'+resolve(projectRoot,'packages/harness-dsh'),
   ])
  }finally{await suppressPendingBundles(profileDir)}
  await installOptionalNativeBundles({profileDir,profileName,installAnchor:manifest})
  const profile=JSON.parse(await readFile(path,'utf8'))
  const bundles=profile.dsh?.profile?.bundles
  if(!Array.isArray(bundles))throw Error('独立 profile 缺少已知的 bundles 列表。')
  // 与适配器同一把 profile 级互斥与同一套原子写：清单不会被截断成半份。
  await rewriteProfileBundles(profileDir,withTeloaRequiredBundles)
  const dump=await run([resolve(projectRoot,'scripts/启动DSH.mjs'),'--dump-config'],{capture:true})
  if(dump.stderr.trim())throw Error('DSH 组合配置存在未命中的补丁或诊断：'+dump.stderr.trim())
  verifyConfig(dump.stdout)
  console.log('Teloa 插件已接入独立 profile；重启本项目 DSH 后生效。')
}catch(error){console.error(error.message);process.exitCode=1}
}
