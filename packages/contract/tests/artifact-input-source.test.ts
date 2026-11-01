import assert from 'node:assert/strict'
import test from 'node:test'
import {artifactInputSourceMarker,readArtifactInputSourceMarker} from '../src/index.ts'

test('成果输入来源标记只接受固定身份/版本的完整单行，不能由相似正文授予引用',()=>{
 const source={artifactId:'adf81f0e-5078-4461-8a16-d4eafab1c557',version:4}
 const marker=artifactInputSourceMarker(source)
 assert.equal(marker,'[teloa-artifact-source:adf81f0e-5078-4461-8a16-d4eafab1c557:v4]')
 assert.deepEqual(readArtifactInputSourceMarker(marker),source)
 for(const value of [`说明 ${marker}`,`${marker}\n说明`,`${marker}\n`,`${marker}\r`,'[teloa-artifact-source:bad:v4]',marker.replace(':v4',':v0'),marker.replace(':v4',':v9007199254740992')])assert.equal(readArtifactInputSourceMarker(value),null)
 assert.throws(()=>artifactInputSourceMarker({...source,version:0}))
 assert.throws(()=>artifactInputSourceMarker({...source,artifactId:'bad'}))
})
