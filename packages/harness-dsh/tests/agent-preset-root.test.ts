import test from 'node:test'
import assert from 'node:assert/strict'
import {createRequire} from 'node:module'
import {readFile} from 'node:fs/promises'
import {parse} from 'yaml'
import {entryListProblem} from '@deepseek-ai/dsh-agent-preset-registry'
import {teloaAgentPresetId} from '../src/composition-safety.ts'

const source=new URL('../../bundle/agent-presets/teloa-standard/agent.cordis.yml',import.meta.url)
const require=createRequire(import.meta.url)
const officialRequire=createRequire(require.resolve('@deepseek-ai/dsh/package.json'))
const rows=parse(await readFile(source,'utf8'),{customTags:[{tag:'tag:yaml.org,2002:js',resolve:(value:string)=>({__jsExpr:value})}]})
const declarations=rows.flatMap((row:{insert?:unknown[]})=>row.insert??[])

test('自带声明通过官方预设列表校验且所有插件模块均已随发行包安装',()=>{
 assert.equal(declarations.length,1)
 const declaration=declarations[0]
 assert.equal(declaration.name,'@deepseek-ai/dsh-agent-preset')
 assert.equal(declaration.config.id,teloaAgentPresetId)
 assert.equal(declaration.config.name,'Teloa 标准模式')
 assert.equal(entryListProblem(declaration.config.plugins),undefined)
 const check=(entries:Record<string,unknown>[])=>{
  for(const row of entries){
   if(typeof row.name==='string'&&!row.name.startsWith('cordis:'))assert.doesNotThrow(()=>officialRequire.resolve(row.name as string),String(row.name))
   if(Array.isArray(row.config))check(row.config)
  }
 }
 check(declaration.config.plugins)
})

test('非法嵌套插件不能通过官方声明校验',()=>{
 const plugins=structuredClone(declarations[0].config.plugins)
 plugins.push({id:'invalid',name:17})
 assert.notEqual(entryListProblem(plugins),undefined)
})
