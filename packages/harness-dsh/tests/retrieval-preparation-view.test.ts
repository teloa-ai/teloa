import test from 'node:test'
import assert from 'node:assert/strict'
import {readEmbeddingProvider} from '../src/local-retrieval.ts'
import {retrievalPreparationDetails} from '../../local-embedding/src/preparation-details.ts'
test('扩展固定 manifest 准备详情通过公开 snapshot 进入宿主视图；破损信息拒绝转发',()=>{
 const preparationDetails=retrievalPreparationDetails('fp32','/host/models','/host/runtime')
 const provider={id:'qwen3-embedding-0.6b',location:'host-local',catalogId:'teloa.model.qwen3-embedding-0-6b',catalogVersion:'1.0.0',profileHash:'a'.repeat(64),variant:'fp32',totalMemoryBytes:8*1024**3,memoryRisk:true,preparation:{phase:'unprepared'},preparationDetails}
 assert.deepEqual(readEmbeddingProvider({providers:[provider]},provider.id)?.preparationDetails,preparationDetails)
 assert.throws(()=>readEmbeddingProvider({providers:[{...provider,preparationDetails:{...preparationDetails,license:''}}]},provider.id))
})
