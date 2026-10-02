import test from 'node:test'
import assert from 'node:assert/strict'
import {sanitizeProductEvent,productEventNames} from '../src/product-analytics.ts'

test('产品事件仅保留固定名称、时间、枚举、布尔及受限耗时',()=>{
 const value={eventName:'send_button_click',timestamp:1234,body:'private text',attributes:{session_id:'private-session',user_id:'account',device_id:'device',input_value:'/private/path',model_name:'private-model',error_reason:'secret',run_mode:'plan',msg_type:'queue',is_success:true,duration:42}}
 assert.deepEqual(sanitizeProductEvent(value),{eventName:'send_button_click',timestamp:1234,attributes:{run_mode:'plan',msg_type:'queue',is_success:true,duration:42}})
 assert.equal(sanitizeProductEvent({...value,eventName:'unknown'}),undefined)
 assert.equal(sanitizeProductEvent({...value,timestamp:NaN}),undefined)
 assert.deepEqual(sanitizeProductEvent({...value,attributes:{run_mode:'user text',duration:Infinity}})?.attributes,{})
 assert.equal(new Set(productEventNames).size,productEventNames.length)
})
