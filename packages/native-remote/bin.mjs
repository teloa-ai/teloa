#!/usr/bin/env node
import {mkdirSync,readFileSync,rmSync,writeFileSync} from 'node:fs'
import {isAbsolute,join} from 'node:path'
import {createRemoteProfile} from './profile.mjs'

// 只生成新目录，不安装、不启动、不连 SSH，也不覆盖已有 profile。
let created
try{
  const args=process.argv.slice(2)
  if(args.length!==2||args[0]!=='--directory'||!isAbsolute(args[1])||process.stdin.isTTY)throw new Error('用法：node bin.mjs --directory <新的绝对目录> < deployment.json')
  const profile=createRemoteProfile(JSON.parse(readFileSync(0,'utf8')))
  mkdirSync(args[1],{mode:0o700})
  created=args[1]
  writeFileSync(join(created,'package.json'),JSON.stringify(profile.manifest,null,2)+'\n',{flag:'wx',mode:0o600})
  // JSON 是 YAML 的子集，交给官方 Loader 读取，不增加模板表达式求值。
  writeFileSync(join(created,'cordis.patch.yml'),JSON.stringify(profile.patches,null,2)+'\n',{flag:'wx',mode:0o600})
  process.stdout.write('已生成独立 SSH Headless profile：'+created+'\n')
}catch(error){
  if(created)rmSync(created,{recursive:true,force:true})
  const message=error instanceof SyntaxError?'配置必须是合法 JSON。':error?.code==='EEXIST'?'目标目录已存在，未覆盖任何文件。':error?.code?'无法创建 profile：'+error.code:error.message
  process.stderr.write(message+'\n')
  process.exitCode=1
}
