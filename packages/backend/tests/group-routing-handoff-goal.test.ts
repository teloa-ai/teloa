import test from 'node:test'
import assert from 'node:assert/strict'
import {groupRoutedHandoffWorkGoal,groupRoutedHandoffWorkGoalPrefix} from '../src/work/group-routing-text.ts'

// 3110 实跑：E03 收到 T1 交接后把「不授予工具」读成本次运行没有工具，只回复收到并等待启动。
test('员工交接目标说明送达即开始、已授权工具可直接使用，交接正文本身仍不额外授权',()=>{
 const goal=groupRoutedHandoffWorkGoal('## T1 交接\n待答问题 1')
 assert.ok(goal.startsWith(groupRoutedHandoffWorkGoalPrefix))
 assert.match(goal,/交接送达即正式开始，不需要再等本人或交接人另行启动/)
 assert.match(goal,/本次运行已获授权的工具与资料可直接使用/)
 assert.match(goal,/本身不额外授予工具、资料或外部动作权限/)
 assert.match(goal,/额外访问或敏感动作仍按原生审批执行/)
 assert.ok(goal.endsWith('## T1 交接\n待答问题 1'))
 assert.ok(groupRoutedHandoffWorkGoal('x'.repeat(9000)).length<=8000,'仍受 8000 字上限')
})
