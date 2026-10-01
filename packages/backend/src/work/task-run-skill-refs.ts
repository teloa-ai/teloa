import {createHash} from 'node:crypto'
import type {Pool,PoolClient} from 'pg'
import {WorkError} from '@teloa/contract'
import {readEnabledSkillInstallation,readInstalledSkillInstallation} from '../market/skill-installations.ts'
import {readManagedRunSkill,type ManagedRunSkillFile,type RunSkill} from './task-run-skills.ts'

const hex=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value)
const digest=(ownerId:string,runId:string,installationId:string,name:string,bundleHash:string,files:readonly ManagedRunSkillFile[])=>createHash('sha256').update(JSON.stringify([ownerId,runId,installationId,name,bundleHash,files])).digest('hex')
const corrupt=()=>new WorkError('teloa/storage-corrupt','执行技能安装引用损坏，已停止读取。')

export async function initializeTaskRunSkillRefs(pool:Pool){await pool.query(`create table if not exists teloa_task_run_skill_refs(
 owner_id text not null,run_id uuid not null references teloa_task_runs(id),installation_id uuid not null references teloa_skill_installations(id),
 name text not null,bundle_hash text not null check(bundle_hash ~ '^[a-f0-9]{64}$'),files jsonb not null check(jsonb_typeof(files)='array'),
 ref_digest text not null check(ref_digest ~ '^[a-f0-9]{64}$'),primary key(run_id,name)
)`)}

function assertInstallation(skill:RunSkill,installation:Awaited<ReturnType<typeof readInstalledSkillInstallation>>){
 if(!skill.managed||installation.id!==skill.managed.installationId||installation.bundleHash!==skill.managed.bundleHash||installation.native.name!==skill.name||installation.native.bodyHash!==skill.sha256)throw corrupt()
}

export async function writeTaskRunSkillRefs(db:PoolClient,ownerId:string,runId:string,skills:readonly RunSkill[]){
 for(const skill of skills){
  if(!skill.managed)continue
  const installation=await readEnabledSkillInstallation(db,ownerId,skill.managed.installationId);assertInstallation(skill,installation)
  const refDigest=digest(ownerId,runId,installation.id,skill.name,skill.managed.bundleHash,skill.managed.files)
  await db.query('insert into teloa_task_run_skill_refs(owner_id,run_id,installation_id,name,bundle_hash,files,ref_digest) values($1,$2,$3,$4,$5,$6,$7)',[ownerId,runId,installation.id,skill.name,skill.managed.bundleHash,JSON.stringify(skill.managed.files),refDigest])
 }
}

export async function verifyTaskRunSkillRefs(db:PoolClient,ownerId:string,runId:string,skills:readonly RunSkill[]){
 const managed=skills.filter(skill=>skill.managed!==undefined)
 const rows=(await db.query('select owner_id,run_id,installation_id,name,bundle_hash,files,ref_digest from teloa_task_run_skill_refs where run_id=$1 order by name',[runId])).rows
 if(rows.length!==managed.length)throw corrupt()
 const expected=new Map(managed.map(skill=>[skill.name,skill]))
 for(const row of rows){
  const skill=typeof row.name==='string'?expected.get(row.name):undefined
  if(!skill||row.owner_id!==ownerId||row.run_id!==runId||typeof row.installation_id!=='string'||!hex(row.bundle_hash)||!hex(row.ref_digest))throw corrupt()
  let fixed;try{fixed=readManagedRunSkill({installationId:row.installation_id,bundleHash:row.bundle_hash,files:row.files})}catch{throw corrupt()}
  if(JSON.stringify(fixed)!==JSON.stringify(skill.managed)||row.ref_digest!==digest(ownerId,runId,fixed.installationId,skill.name,fixed.bundleHash,fixed.files))throw corrupt()
  let installation;try{installation=await readInstalledSkillInstallation(db,ownerId,fixed.installationId)}catch(error){if(error instanceof WorkError&&error.code==='teloa/forbidden')throw corrupt();throw error}
  assertInstallation(skill,installation);expected.delete(skill.name)
 }
 if(expected.size)throw corrupt()
}
