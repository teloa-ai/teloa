import test from 'node:test'
import assert from 'node:assert/strict'
import {marketPluginInstallSource} from '../src/client/market-plugin-source.ts'
import type {MarketItem} from '../src/client/market-preview.ts'

const item=(source?:MarketItem['pluginInstallSource']):MarketItem=>({id:'plugin',kind:'resource',resourceKind:'plugin',title:'plugin',version:'1.0.0',scope:'general',visibility:'public',summary:'',requirements:[],output:'',author:'',license:'',source:{kind:'github',url:'https://github.com/example/plugin',revision:'a'.repeat(40)},owner:'DSH',compatibility:'',components:[],...(source?{pluginInstallSource:source}:{})})

test('只有市场条目声明严格 npm 包名与精确版本时才产生插件安装来源',()=>{
 assert.equal(marketPluginInstallSource(item()),undefined)
 assert.equal(marketPluginInstallSource(item({registry:'npm',packageName:'@example/plugin',version:'latest'} as never)),undefined)
 assert.deepEqual(marketPluginInstallSource(item({registry:'npm',packageName:'@example/plugin',version:'1.2.3'})),{registry:'npm',packageName:'@example/plugin',version:'1.2.3'})
})
