import test from 'node:test'
import assert from 'node:assert/strict'
import { producedFilePath,producedPaths } from '../src/client/produced-files.ts'
test('只投影本轮截止序号之前的原生产出事实并去重',()=>{
 assert.deepEqual(producedPaths({produced:[{seq:4,path:'a.py'},{seq:6,path:'a.py'},{seq:9,path:'later.png'},{seq:5,path:'b.png'}]},7),['a.py','b.png'])
 assert.deepEqual(producedPaths(undefined,7),[])
 assert.deepEqual(producedPaths({produced:[{seq:'4',path:'bad.py'}]},7),[])
})
test('成果路径不能越出当前会话工作区或读取运行资料',()=>{
 assert.equal(producedFilePath('/work/team/output/a.py','/work/team'),'output/a.py')
 assert.equal(producedFilePath('./output/a.py','/work/team'),'output/a.py')
 for(const path of ['/work/team2/a.py','../a.py','/work/team/.runtime/key','file:///work/team/a.py','/work/team/out/../../a.py'])assert.equal(producedFilePath(path,'/work/team'),null)
})
