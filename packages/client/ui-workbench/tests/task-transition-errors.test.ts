import test from 'node:test'
import assert from 'node:assert/strict'
import {localizeWorkError} from '../lib/types/client/i18n/errors.js'

test('任务还有工作未收口时说明停止路径，不误报版本冲突或展示服务端原文',()=>{
 const error={code:'teloa/conflict',message:'内部错误详情',details:{reason:'task-work-outstanding'}}
 assert.equal(localizeWorkError('zh-CN',error),'请先停止本轮工作，结束后再取消任务。')
 assert.equal(localizeWorkError('zh-Hant',error),'請先停止本輪工作，結束後再取消任務。')
 assert.equal(localizeWorkError('en',error),'Stop this run before cancelling the task.')
 assert.notEqual(localizeWorkError('zh-CN',{...error,details:{reason:'unknown'}}),localizeWorkError('zh-CN',error))
 assert.notEqual(localizeWorkError('zh-CN',{...error,code:'teloa/version-conflict'}),localizeWorkError('zh-CN',error))
})
