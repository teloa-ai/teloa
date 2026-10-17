import {test} from 'node:test'
import assert from 'node:assert/strict'
import {employeeComputerUrl,employeeComputerTarget,leaveEmployeeComputer} from '../src/client/employee-computer-navigation.ts'

test('独立电脑页面保留原入口路径，只携带员工引用，剔除认证和会话参数',()=>{
 const current='http://127.0.0.1:3100/app?auth=private&session=original&revision=old#sessions/work-1'
 assert.equal(employeeComputerUrl(current,'employee-1'),'http://127.0.0.1:3100/app?employeeComputer=employee-1')
 assert.equal(employeeComputerUrl(current,'employee-1',true),'http://127.0.0.1:3100/app?employeeComputer=employee-1&computerWindow=1')
})
test('URL 不能代替员工授权；无效引用拒绝，退出只移除电脑视图参数',()=>{
 assert.equal(employeeComputerTarget('http://localhost/?employeeComputer=employee-1'),'employee-1')
 assert.equal(employeeComputerTarget('http://localhost/?employeeComputer=../secret'),null)
 assert.equal(employeeComputerTarget('http://localhost/?employeeComputer='),null)
 assert.equal(leaveEmployeeComputer('http://localhost/?revision=current&employeeComputer=employee-1&computerWindow=1'),'http://localhost/?revision=current')
})
