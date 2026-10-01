import {randomBytes} from 'node:crypto'
import {readFile,writeFile,chmod} from 'node:fs/promises'

async function readPassword(path){
  const value=(await readFile(path,'utf8')).trim()
  if(!/^[a-f0-9]{64}$/.test(value))throw Error('容器数据库口令格式无效；请恢复原口令，不要重置已有数据卷。')
  return value
}

export async function prepareContainerSecret(path){
  try{await writeFile(path,randomBytes(32).toString('hex'),{flag:'wx',mode:0o440})}
  catch(error){if(error.code!=='EEXIST')throw error}
  await readPassword(path)
  await chmod(path,0o440)
}

export async function writeContainerDatabase(secretPath,configPath){
  const password=await readPassword(secretPath)
  await writeFile(configPath,JSON.stringify({connectionString:'postgresql://teloa:'+password+'@db:5432/teloa'})+'\n',{mode:0o600})
  await chmod(configPath,0o600)
}
