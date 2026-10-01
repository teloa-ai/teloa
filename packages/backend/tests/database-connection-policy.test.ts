import test from 'node:test'
import assert from 'node:assert/strict'
import * as database from '../src/capabilities/database.ts'

test('源码只用回环数据库；Compose 仅额外允许内网服务 db',()=>{
  for(const [url,deployment,allowed] of [
    ['postgresql://teloa:example@127.0.0.1:5432/teloa',undefined,true],
    ['postgresql://teloa:example@db:5432/teloa',undefined,false],
    ['postgresql://teloa:example@db:5432/teloa','compose',true],
    ['postgresql://teloa:example@outside.example:5432/teloa','compose',false],
    ['postgresql://teloa:example@db:5432/other','compose',false],
    ['https://db/teloa','compose',false],
    ['not a url','compose',false],
  ] as const)assert.equal(database.databaseConnectionAllowed(url,deployment),allowed)
})
