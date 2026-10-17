import test from 'node:test'
import assert from 'node:assert/strict'
import {execFileSync} from 'node:child_process'
import {readFile,writeFile,access,symlink,mkdir} from 'node:fs/promises'
import {join} from 'node:path'
import {nativePtcToolPath} from './fixtures/native-ptc-tool-path.ts'
import {official} from '../../../tests/native-auto-review-fixture.mjs'

const output=(message:{content:readonly {type:string;text?:string}[]})=>message.content.flatMap(block=>block.type==='text'?[block.text??'']:[]).join('\n')
test('原可选 create_worktree 真工具从本地提交创建、保留原稿，重复/取消/链接越界不变目录',{timeout:30000},async t=>{
 const f=await nativePtcToolPath(t),agent=await f.create('ptc')
 assert.equal(f.ctx.tools.get('create_worktree',agent),undefined,'默认不开放可选 Worktree')
 const git=(args:string[])=>execFileSync('git',['-c','core.hooksPath=/dev/null',...args],{cwd:f.workspace,encoding:'utf8',env:{...process.env,GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_NOSYSTEM:'1'}}).trim()
 git(['init','--quiet']);await writeFile(join(f.workspace,'tracked.txt'),'committed\n');await writeFile(join(f.workspace,'.gitignore'),'ignored.txt\n.agents/\n');git(['add','--','tracked.txt','.gitignore']);git(['-c','user.name=Teloa Test','-c','user.email=test@example.invalid','commit','--quiet','-m','isolated baseline'])
 const commit=git(['rev-parse','HEAD']);await writeFile(join(f.workspace,'tracked.txt'),'owner draft\n');await writeFile(join(f.workspace,'untracked.txt'),'owner untracked\n');await writeFile(join(f.workspace,'ignored.txt'),'owner ignored\n')
 const {default:WorktreeRuntime}=await official('dsh-experimental-worktree')
 await f.ctx.plugin(WorktreeRuntime,{})
 const worktrees:unknown=Reflect.get(f.ctx,'worktrees');assert.ok(worktrees instanceof WorktreeRuntime)
 await f.ctx.plugin(await official('dsh-experimental-tool-worktree'))
 const created=await f.run(agent,'console.log(JSON.stringify(await tools.create_worktree({name:"review-work"})))')
 assert.notEqual(created.isError,true,output(created));const value=JSON.parse(output(created)) as {path:string;branch:string;baseCommit:string;repositoryRoot:string}
 assert.equal(value.baseCommit,commit);assert.equal(value.branch,'review-work');assert.equal(value.repositoryRoot,f.workspace)
 assert.equal(value.path,join(f.workspace,'.agents','worktrees','review-work'));assert.equal(f.ctx.workingDirectory.get(agent.session),value.path)
 assert.equal(await readFile(join(value.path,'tracked.txt'),'utf8'),'committed\n');for(const file of ['untracked.txt','ignored.txt'])await assert.rejects(access(join(value.path,file)))
 assert.equal(await readFile(join(f.workspace,'tracked.txt'),'utf8'),'owner draft\n');assert.equal(await readFile(join(f.workspace,'untracked.txt'),'utf8'),'owner untracked\n')
 const duplicated=await f.run(agent,'console.log(await tools.create_worktree({name:"review-work"}))');assert.equal(duplicated.isError,true);assert.equal(f.ctx.workingDirectory.get(agent.session),value.path)
 agent.cancel({kind:'user'});assert.equal(await readFile(join(value.path,'tracked.txt'),'utf8'),'committed\n','停止保留真实检出')
 await f.ctx.workingDirectory.set(agent,f.workspace);assert.equal(f.ctx.workingDirectory.get(agent.session),f.workspace)
 const cancelled=new AbortController();cancelled.abort(Error('test pre-cancel'))
 await assert.rejects(worktrees.create(agent,{name:'cancelled-work'},cancelled.signal));await assert.rejects(access(join(f.workspace,'.agents','worktrees','cancelled-work')))
 const outside=join(f.root,'outside');await mkdir(outside);await symlink(outside,join(f.workspace,'escape'),'dir')
 const isolated=f.ctx.isolate('worktrees');await isolated.plugin(WorktreeRuntime,{directory:'escape/worktrees'})
 const isolatedWorktrees:unknown=Reflect.get(isolated,'worktrees');assert.ok(isolatedWorktrees instanceof WorktreeRuntime)
 await assert.rejects(isolatedWorktrees.create(agent,{name:'escape-work'}));await assert.rejects(access(join(outside,'worktrees','escape-work')))
 assert.equal(f.ctx.workingDirectory.get(agent.session),f.workspace);assert.equal(agent.session.header.cwd,f.workspace)
})
