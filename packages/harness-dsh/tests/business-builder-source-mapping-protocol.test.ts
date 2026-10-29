import test from 'node:test'
import assert from 'node:assert/strict'
import {readBusinessConfigurationCandidateVersioned} from '@teloa/contract'
import type {BusinessConfigurationDraft} from '@teloa/backend'
import {businessBuilderSourceMappingProtocol} from '../src/business-builder-source-mapping-protocol.ts'
test('成果映射按固定任务工具写入，周期同步授权仅针对需要持续拉取的外部来源',()=>{
 const scope='business_0123456789abcdef0123456789abcdef'
 const draft={scope,candidate:readBusinessConfigurationCandidateVersioned({format:'teloa.business-configuration/v2',scope,title:'成果',sources:[{sourceId:'records',kind:'local-records'}],definitions:[],pages:[]})} as BusinessConfigurationDraft
 const protocol=businessBuilderSourceMappingProtocol(draft)!
 assert.match(protocol.sourceKinds['role-result'].rules,/已授权的固定任务通过 teloa_business_object_result_record 写入本地成果/)
 assert.match(protocol.sourceKinds['role-result'].rules,/不需要启用外部adapter或周期同步/)
 assert.match(protocol.schedule.rules,/role-result的schedule仅为声明兼容字段/)
 assert.match(protocol.schedule.rules,/不能引导本人为成果映射启用持续同步/)
 assert.match(protocol.schedule.rules,/只有mcp-tool或business-data-port等外部来源需要持续拉取时/)
 assert.doesNotMatch(protocol.schedule.rules,/采用后还须本人另行授权/)
})
