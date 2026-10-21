import assert from 'node:assert/strict'
import test from 'node:test'
import {employeeCoworkers,employeeResults} from '../src/client/employee-work-presentation.ts'

test('合作统计按实际任务去重，排除本人、非员工和仅同业务的员工',()=>{
 const roles=[{id:'a',kind:'employee',name:'A'},{id:'b',kind:'employee',name:'B'},{id:'c',kind:'employee',name:'C'},{id:'self',kind:'twin',name:'Self'},{id:'unrelated',kind:'employee',name:'Other'}] as any
 const first={id:'one',authorId:'self',assigneeId:'b',assigneeHistory:['a','b','a']},second={id:'two',authorId:'a',assigneeId:'c',assigneeHistory:['b']}
 assert.deepEqual(employeeCoworkers('a',[first,first,second] as any,roles).map(({role,count})=>[role.id,count]),[['b',2],['c',1]])
})

test('成果不按标题或业务猜测归属，只接受任务来源或任务固定引用',()=>{
 const tasks=[{id:'one',artifact:{id:'linked'}},{id:'two'}] as any
 const asset=(id:string,source:any,at:string)=>({id,title:'相同标题',source,versions:[{at}]})
 const artifacts=[asset('wrong',{kind:'task',id:'other'},'2026-10-21'),asset('direct',{kind:'task',id:'one'},'2026-10-19'),asset('linked',{kind:'session',id:'session'},'2026-10-20'),{id:'empty',source:{kind:'task',id:'one'},versions:[]}] as any
 assert.deepEqual(employeeResults(tasks,artifacts).map(row=>[row.artifact.id,row.task.id]),[['linked','one'],['direct','one']])
})
