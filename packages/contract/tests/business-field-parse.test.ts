import test from 'node:test'
import assert from 'node:assert/strict'
import {parseDurationSeconds,parseBooleanValue} from '../src/business-field-parse.ts'

test('duration：ISO 8601 时长与纯秒数都归一为秒',()=>{
 assert.equal(parseDurationSeconds('PT4H30M'),16200)
 assert.equal(parseDurationSeconds('P1DT2H'),93600)
 assert.equal(parseDurationSeconds('P2W'),1209600)
 assert.equal(parseDurationSeconds('PT0.5S'),0.5)
 assert.equal(parseDurationSeconds('PT90S'),90)
 assert.equal(parseDurationSeconds('270'),270)
 assert.equal(parseDurationSeconds('270.5'),270.5)
 assert.equal(parseDurationSeconds('0'),0)
 assert.equal(parseDurationSeconds('1000000000000'),1e12,'恰好 1e12 秒仍可用')
})

test('duration：月、负数、越界、前后空白与残缺写法一律解析不出',()=>{
 for(const raw of ['P1M','P1Y','-PT1H','PT-1H','1e400','1e12','1000000000001','P','PT','T1H','PT1H\n',' PT1H','PT1H ','P1W1D','PT1.5H','abc','','NaN','Infinity','+270','.5','270.'])
  assert.equal(parseDurationSeconds(raw),undefined,JSON.stringify(raw)+' 应解析不出')
})

test('boolean：大小写不敏感 true/false、是/否、1/0，其余解析不出',()=>{
 assert.equal(parseBooleanValue('TRUE'),true)
 assert.equal(parseBooleanValue('true'),true)
 assert.equal(parseBooleanValue('True'),true)
 assert.equal(parseBooleanValue('是'),true)
 assert.equal(parseBooleanValue('1'),true)
 assert.equal(parseBooleanValue('FALSE'),false)
 assert.equal(parseBooleanValue('否'),false)
 assert.equal(parseBooleanValue('0'),false)
 for(const raw of ['yes','no','y','n','on','off',' true','true ','01','1.0','t','f','','真','假','T','F'])
  assert.equal(parseBooleanValue(raw),undefined,JSON.stringify(raw)+' 应解析不出')
})
