import test from 'node:test'
import assert from 'node:assert/strict'
import {viewRootAction} from '../src/client/workbench-view-root.ts'

test('面包屑第二级：带选中态的页面回列表根，其余只切回视图本身',()=>{
 assert.deepEqual(viewRootAction('tasks'),{kind:'tasks'})
 assert.deepEqual(viewRootAction('team'),{kind:'team'})
 assert.deepEqual(viewRootAction('spaces'),{kind:'business-home'})
 assert.deepEqual(viewRootAction('market'),{kind:'market'})
 assert.deepEqual(viewRootAction('plans'),{kind:'plans'})
 assert.deepEqual(viewRootAction('attention'),{kind:'attention'})
 assert.deepEqual(viewRootAction('resources'),{kind:'resources'})
 for(const view of ['home','messages','capabilities','settings'] as const)assert.deepEqual(viewRootAction(view),{kind:'navigate',view})
})
