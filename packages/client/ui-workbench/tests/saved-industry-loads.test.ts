import test from 'node:test'
import assert from 'node:assert/strict'
import {mergeSavedIndustryLoad} from '../src/client/saved-industry-loads.ts'
import type {IndustryLoadRecord} from '../src/client/industry-load-api.ts'
const base={id:'12345678-1234-4234-8234-123456789012',ownerId:'owner',contentId:'22345678-1234-4234-8234-123456789012',contentHash:'a'.repeat(64),templateId:'template',templateVersion:'1.0.0',templateTitle:'模板',domain:'security',scope:'SOC',description:'说明',targetVersion:1,space:{id:'32345678-1234-4234-8234-123456789012',name:'新名称',version:2,scope:'space-32345678-1234-4234-8234-123456789012'},items:[],relations:[],entrypoints:[],createdAt:'2026-09-12T00:00:00.000Z',mappingHash:'b'.repeat(64),status:'active'} as IndustryLoadRecord
test('旧加载回执不降低空间现状并同步同空间全部加载',()=>{const old={...base,id:'42345678-1234-4234-8234-123456789012',space:{...base.space,name:'旧名称',version:1}},result=mergeSavedIndustryLoad([base],old);assert.equal(result.length,2);assert.ok(result.every(load=>load.space.version===2&&load.space.name==='新名称'))})
test('同一加载的旧恢复回执也不能降低已读空间版本',()=>{const old={...base,space:{...base.space,name:'旧名称',version:1}},result=mergeSavedIndustryLoad([base],old);assert.equal(result.length,1);assert.equal(result[0]?.space.version,2);assert.equal(result[0]?.space.name,'新名称')})
