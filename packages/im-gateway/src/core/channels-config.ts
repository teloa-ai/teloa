/**
 * 渠道配置存储 `<dir>/channels.json`（目录 0o700、文件 0o600）：只记渠道种类、启用状态与创建时间。
 * 凭据只在 ctx.credentials，本文件不含任何凭据值。
 */
import {join} from 'node:path'
import {imChannelKinds,imStubChannelKind,type ImChannelKind} from '@teloa/contract'
import {createJsonStore} from './store.ts'

export type ImChannelConfig={channelId:string;kind:ImChannelKind;enabled:boolean;createdAt:string}

const knownKinds:readonly string[]=[...imChannelKinds,imStubChannelKind]

function parseChannel(value:unknown):ImChannelConfig{
 const row=typeof value==='object'&&value!==null?value as Record<string,unknown>:{}
 if(typeof row.channelId!=='string'||!knownKinds.includes(row.kind as string)||typeof row.enabled!=='boolean'||typeof row.createdAt!=='string')throw new Error('bad shape')
 return {channelId:row.channelId,kind:row.kind as ImChannelKind,enabled:row.enabled,createdAt:row.createdAt}
}

function parseChannels(value:unknown):{channels:ImChannelConfig[]}{
 const channels=typeof value==='object'&&value!==null?(value as {channels?:unknown}).channels:undefined
 if(!Array.isArray(channels))throw new Error('bad shape')
 return {channels:channels.map(parseChannel)}
}

export function createChannelConfigStore(dir:string){
 const file=createJsonStore(join(dir,'channels.json'),parseChannels,{channels:[]})
 return {
  async list():Promise<ImChannelConfig[]>{
   return (await file.read()).channels
  },
  /** 按 channelId 新增或整行覆盖（保持原位置）。 */
  async upsert(row:ImChannelConfig):Promise<void>{
   const next={channelId:row.channelId,kind:row.kind,enabled:row.enabled,createdAt:row.createdAt}
   await file.update(cur=>({channels:cur.channels.some(c=>c.channelId===row.channelId)?cur.channels.map(c=>c.channelId===row.channelId?next:c):[...cur.channels,next]}))
  },
  /** 不存在时无操作（删除渠道可重试）。 */
  async remove(channelId:string):Promise<void>{
   await file.update(cur=>({channels:cur.channels.filter(c=>c.channelId!==channelId)}))
  },
 }
}
