import test from 'node:test'
import assert from 'node:assert/strict'
import {compareSemver,parseTeloaRange,teloaRangeHasLowerBound,teloaRangeSatisfies} from '../src/semver-range.ts'

test('compareSemver：数字段按数值，预发布低于正式，预发布标识按段比较',()=>{
 assert.equal(compareSemver('0.2.0','0.2.0'),0)
 assert.equal(compareSemver('0.2.0-alpha.6','0.2.0'),-1)
 assert.equal(compareSemver('0.2.0-alpha.6','0.2.0-alpha.7'),-1)
 assert.equal(compareSemver('0.2.0-alpha.10','0.2.0-alpha.9'),1)
 assert.equal(compareSemver('0.2.0-beta.1','0.2.0-alpha.9'),1)
 assert.equal(compareSemver('0.10.0','0.9.9'),1)
 assert.equal(compareSemver('1.0.0+build.5','1.0.0'),0)
})

test('teloaRangeSatisfies：>=、区间、精确；语法错误返回 false',()=>{
 assert.equal(teloaRangeSatisfies('>=0.2.0-alpha.6','0.2.0-alpha.6'),true)
 assert.equal(teloaRangeSatisfies('>=0.2.0-alpha.7','0.2.0-alpha.6'),false)
 assert.equal(teloaRangeSatisfies('>=0.2.0-alpha.6 <0.3.0','0.2.5'),true)
 assert.equal(teloaRangeSatisfies('>=0.2.0-alpha.6 <0.3.0','0.3.0'),false)
 assert.equal(teloaRangeSatisfies('0.2.0-alpha.6','0.2.0-alpha.6'),true)
 assert.equal(teloaRangeSatisfies('*','0.0.1'),true)
 assert.equal(teloaRangeSatisfies('^0.2.0','0.2.1'),false)
 assert.throws(()=>parseTeloaRange('^0.2.0'),{code:'teloa/invalid-input'})
 assert.throws(()=>parseTeloaRange('>=0.2'),{code:'teloa/invalid-input'})
})

test('teloaRangeHasLowerBound：须有不低于最低版本的 >=、>、= 下界；* 与只有上界的范围不算',()=>{
 for(const range of ['>=0.2.0-alpha.7','>0.2.0-alpha.7','0.2.0-alpha.7','>=0.3.0 <0.4.0','<1.0.0 >=0.2.0-alpha.8'])assert.equal(teloaRangeHasLowerBound(range,'0.2.0-alpha.7'),true,range)
 for(const range of ['*','>=0.2.0-alpha.6','<=0.2.0-alpha.9','<0.3.0','>0.2.0-alpha.6'])assert.equal(teloaRangeHasLowerBound(range,'0.2.0-alpha.7'),false,range)
})
