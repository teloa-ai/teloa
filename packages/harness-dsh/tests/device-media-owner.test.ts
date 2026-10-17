import test from 'node:test'
import assert from 'node:assert/strict'
import {createDeviceMediaOwner} from '../src/device-media-owner.ts'

test('网页与设备同步预约同一媒体，释放只影响原句柄',()=>{
 const owner=createDeviceMediaOwner(),web=owner.acquire('web')
 assert.throws(()=>owner.acquire('device'))
 web.release();const device=owner.acquire('device')
 web.release();assert.throws(()=>owner.acquire('web'))
 device.release();owner.acquire('web').release()
})
