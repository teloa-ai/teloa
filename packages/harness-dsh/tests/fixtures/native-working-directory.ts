import type {Context} from '@deepseek-ai/cordis'
import {LocalFileSystem} from '@deepseek-ai/dsh-fs-local'
import {WorkingDirectoryService} from '@deepseek-ai/dsh-working-directory'

const fileSystemMethods=['watch','resolve','processPath','processPathFromHostPath','fileUrl','contains','stat','lstat','readText','streamText','readBytes','readByteRange','listDir','writeText','editText'] as const

/** 测试图重用已有官方文件系统；只在缺失时补本地提供方，不因类来自另一模块图而降级沙箱。 */
export async function installNativeWorkingDirectory(ctx:Context,directory=process.cwd()):Promise<void>{
 const fs=ctx.get('fs')
 if(fs===undefined)await ctx.plugin(LocalFileSystem,{cwd:directory})
 else{
  const missing=fileSystemMethods.filter(name=>typeof fs?.[name]!=='function')
  if(missing.length)throw Error('测试图既有 fs 不满足官方 FileSystem 接口：'+missing.join(', '))
 }
 if(!ctx.get('workingDirectory'))await ctx.plugin(WorkingDirectoryService,{defaultDirectory:directory})
}
