import test from 'node:test'
import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {cp,mkdir,mkdtemp,readFile,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {fileURLToPath} from 'node:url'
import {build} from 'tsdown'
import {clientBundle} from '../../tsdown.preset.ts'

// 捕获关于页重新依赖私人 resource 目录、图片漏纳入源码或迁移改变扫码原图字节。
test('没有 resource 的源码副本仍能通过正式图片解析器内嵌四张关于页原图',async()=>{
  const temp=await mkdtemp(join(tmpdir(),'teloa-public-about-'))
  try{
    const packageRoot=join(temp,'packages/client/ui-workbench')
    await mkdir(packageRoot,{recursive:true})
    await cp(fileURLToPath(new URL('../src',import.meta.url)),join(packageRoot,'src'),{recursive:true})
    const entry=join(packageRoot,'src/client/CommunityAboutContacts.tsx')
    const config=clientBundle('@teloa/client-ui-workbench',entry)[1]!
    const isAsset=(id:string)=>/\.(?:module\.css|jpe?g|svg)$/i.test(id)
    // 只核对本组件的静态输入；其余业务模块保留外部引用，不加载宿主或浏览器。
    await build({
      ...config,
      config:false,
      cwd:packageRoot,
      outDir:join(packageRoot,'lib'),
      sourcemap:false,
      logLevel:'error',
      deps:{neverBundle:(id:string)=>!isAsset(id),alwaysBundle:isAsset},
    })
    const bundle=await readFile(join(packageRoot,'lib/client.js'),'utf8')
    const images=[...bundle.matchAll(/data:image\/jpeg;base64,([A-Za-z0-9+/=]+)/g)]
      .map(match=>Buffer.from(match[1]!,'base64'))
    assert.equal(images.length,4)
    for(const image of images)assert.deepEqual([...image.subarray(0,3)],[0xff,0xd8,0xff])
    assert.deepEqual(images.map(image=>createHash('sha256').update(image).digest('hex')).sort(),[
      '02d5d63ce6e0fc5d18966dbc0f189bdaf0fe7e0e640736c18225111002aa9db4',
      '797b3907198841b0a91f7d18305cb6ca1f1d422bdce4e7fdc2bca6c600f05f55',
      'f40dcc8c0d1dbb0d946f359cc92237ec9774471cc40efce0ff590c12945ff987',
      '31c9f0d7c489243c6f61209414fa9652b882ce825809f10aa62c3b4157baefba',
    ].sort())
  }finally{
    await rm(temp,{recursive:true,force:true})
  }
})
