import test from 'node:test'
import assert from 'node:assert/strict'
import {speechSegments} from '../src/speech-segments.ts'
test('首句即可合成，长回复逐字有界分段，空白与emoji保持完整',()=>{
 for(const text of ['第一句。第二句！尾句','“你好。” 接着说明。\n','a'.repeat(159)+'😀'+'b'.repeat(200),'中文'.repeat(9000)]){
  const segments=speechSegments(text)
  assert.equal(segments.join(''),text)
  assert.ok(segments.every(segment=>segment.trim().length>0&&segment.length<=160))
  assert.ok(segments.every(segment=>!/[\uD800-\uDBFF]$/.test(segment)&&!/^([\uDC00-\uDFFF])/.test(segment)))
 }
 assert.deepEqual(speechSegments('第一句。第二句。'),['第一句。','第二句。'])
})
test('双向TTS合并短句并限制长文批次，保留标点、尾文与emoji',()=>{
 assert.deepEqual(speechSegments('第一句。第二句！还有尾文','continuous'),['第一句。第二句！还有尾文'])
 for(const text of ['这是短首句，后文不要重复。下一句也要完整。','中文。'.repeat(900),'a'.repeat(479)+'😀'+'b'.repeat(600),'正文。'+' '.repeat(1200)]){
  const segments=speechSegments(text,'continuous')
  assert.equal(segments.join(''),text)
  assert.ok(segments.every(segment=>segment.length<=480))
  assert.ok(segments.every(segment=>!/[\uD800-\uDBFF]$/.test(segment)&&!/^([\uDC00-\uDFFF])/.test(segment)))
 }
 assert.deepEqual(speechSegments('第一句。第二句。'),['第一句。','第二句。'],'HTTP路径仍逐句合成')
})
