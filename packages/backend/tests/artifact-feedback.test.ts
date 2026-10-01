import test,{before,after} from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {homedir} from 'node:os'
import {join} from 'node:path'
import {Pool} from 'pg'
import {PostgreSqlContainer,type StartedPostgreSqlContainer} from '@testcontainers/postgresql'
import {ArtifactService,initializeArtifacts} from '../src/work/artifacts.ts'
import {initializeArtifactSnapshots} from '../src/work/artifact-snapshots.ts'
import {ArtifactFeedbackService,initializeArtifactFeedback} from '../src/work/artifact-feedback.ts'
let container:StartedPostgreSqlContainer,pool:Pool
const identity={id:randomUUID,now:()=>new Date().toISOString()}
before(async()=>{process.env.DOCKER_HOST='unix://'+join(homedir(),'.orbstack/run/docker.sock');process.env.TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE='/var/run/docker.sock';container=await new PostgreSqlContainer('postgres:17-alpine').start();pool=new Pool({connectionString:container.getConnectionUri()});await initializeArtifactSnapshots(pool);await initializeArtifacts(pool);await initializeArtifactFeedback(pool)})
after(async()=>{await pool?.end();await container?.stop()})
test('反馈固定历史段落，并发及丢回包重试不重复；不能伪造作者或另一成果来源',async()=>{
 const owner=randomUUID(),source={kind:'session' as const,id:randomUUID(),scope:'general',version:'binding',title:'来源'},artifacts=new ArtifactService(pool,identity,async()=>({source,sessionIds:[]})),feedback=new ArtifactFeedbackService(pool,identity)
 const artifact=await artifacts.create(owner,{requestId:randomUUID(),source,content:{title:'成果',sections:[{id:'p1',title:'正文',text:'原文'}],snapshotIds:[],note:'保存'}})
 const input={requestId:randomUUID(),artifactId:artifact.artifactId,version:1,sectionId:'p1',text:'补充依据',source}
 const [a,b]=await Promise.all([feedback.add(owner,input),feedback.add(owner,input)]);assert.deepEqual(a,b)
 await assert.rejects(artifacts.revise(owner,{artifactId:artifact.artifactId,expectedVersion:1,source,content:{...artifact.content,note:'未修改正文',feedbackId:a.id}}),{code:'teloa/invalid-input'})
 await artifacts.revise(owner,{artifactId:artifact.artifactId,expectedVersion:1,source,content:{...artifact.content,sections:[{id:'p1',title:'正文',text:'新正文'}],note:'修订',feedbackId:a.id}})
 assert.deepEqual(await feedback.add(owner,input),a);assert.equal((await feedback.list(owner,{artifactId:artifact.artifactId})).length,1);assert.equal(a.version,1)
 await assert.rejects(feedback.add(owner,{...input,text:'不同内容'}),{code:'teloa/conflict'})
 await assert.rejects(feedback.add(owner,{...input,requestId:randomUUID(),sectionId:'missing'}),{code:'teloa/invalid-input'})
 await assert.rejects(feedback.add(owner,{...input,ownerId:'other'}),{code:'teloa/invalid-input'})
 await assert.rejects(feedback.list('other',{artifactId:artifact.artifactId}),{code:'teloa/forbidden'})
 assert.equal((await artifacts.list(owner,{artifactId:artifact.artifactId})).length,2)
 assert.equal((await artifacts.list(owner,{artifactId:artifact.artifactId}))[1]!.content.feedbackId,a.id)
})
