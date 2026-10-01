import test from 'node:test'
import assert from 'node:assert/strict'
import {commandNames,parseCommand} from '../src/core/commands.ts'

test('2. parseCommand：/PAIR 123456 → pair；/同事 小王 → colleague query；hello → undefined；/pair abc → undefined',()=>{
 assert.deepEqual(parseCommand('/PAIR 123456'),{name:'pair',code:'123456'})
 assert.deepEqual(parseCommand('/同事 小王'),{name:'colleague',query:'小王'})
 assert.equal(parseCommand('hello'),undefined)
 assert.equal(parseCommand('/pair abc'),undefined)
 assert.equal(parseCommand('/pair'),undefined)
})

test('2a. 中英别名、大小写不敏感、首尾空白与 Telegram 群命令 @bot 后缀',()=>{
 assert.deepEqual(parseCommand(' /New '),{name:'new'})
 assert.deepEqual(parseCommand('/status'),{name:'status'})
 assert.deepEqual(parseCommand('/STOP'),{name:'stop'})
 assert.deepEqual(parseCommand('/colleague'),{name:'colleague'})
 assert.deepEqual(parseCommand('/同事'),{name:'colleague'})
 assert.deepEqual(parseCommand('/任务'),{name:'tasks'})
 assert.deepEqual(parseCommand('/Tasks'),{name:'tasks'})
 assert.deepEqual(parseCommand('/需要你'),{name:'attention'})
 assert.deepEqual(parseCommand('/attention'),{name:'attention'})
 assert.deepEqual(parseCommand('/help'),{name:'help'})
 assert.deepEqual(parseCommand('/new@teloa_bot'),{name:'new'})
 assert.equal(parseCommand('/workspace a'),undefined)
 assert.equal(parseCommand('新建 /new'),undefined)
})

test('3. commandNames 只含一期八条，不含 /workspace /bind /continue /file',()=>{
 assert.equal(commandNames.length,8)
 for(const name of ['/workspace','/bind','/continue','/file'])assert.ok(!commandNames.includes(name),name)
 for(const name of commandNames)assert.ok(parseCommand(name==='/pair'?'/pair 123456':name),name)
})
