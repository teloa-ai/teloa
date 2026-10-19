import test from 'node:test'
import assert from 'node:assert/strict'
import {catalogEmployeeResourceState} from '../src/catalog-employee-install.ts'

const row=(state:string,entry:string|null,reason?:string)=>({itemInstanceId:'99999999-9999-4999-8999-999999999999',kind:'plugin',title:'工单插件',state,entry,...(reason?{reason}:{})})

test('目录员工安装按依赖应用的真实状态回报，不再一律记为处理中',()=>{
 assert.equal(catalogEmployeeResourceState(row('ready',null)),'done','已启用的应用算完成')
 assert.equal(catalogEmployeeResourceState(row('auto',null)),'pending','尚未准备的应用仍在处理')
 assert.equal(catalogEmployeeResourceState(row('pending',null)),'pending','正在安装')
 for(const reason of ['unverified','rejected','restart-required','drift','unreadable',undefined])assert.equal(catalogEmployeeResourceState(row('needs-user','plugin',reason)),'needs-user',String(reason)+'：交本人到扩展处理，不引导反复重试')
 assert.equal(catalogEmployeeResourceState(row('needs-user','plugin','failed')),'failed','安装失败如实记失败，可再添加重试')
 assert.equal(catalogEmployeeResourceState({...row('needs-user','connector-settings'),kind:'mcp'}),'needs-user','连接待授权口径不变')
})
