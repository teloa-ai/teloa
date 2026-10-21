import test from 'node:test'
import assert from 'node:assert/strict'
import {businessMoreActions} from '../src/client/business-more-actions.ts'

test('业务更多沿用原型九项顺序，通用工作不出现业务配置动作',()=>{
 assert.deepEqual(businessMoreActions('SOC'),['adjustment','connector','sources','manual-definition','share','completed','work','changes','team'])
 assert.deepEqual(businessMoreActions('自定义业务'),businessMoreActions('SOC'))
 assert.deepEqual(businessMoreActions('general'),['work','completed','automations'])
})
