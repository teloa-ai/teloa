// 仅提升固定模板中已有的同版叶；不下载或重解其它依赖。
export function pinRuntimeFastSha256(manifest,lock,contract,sourceLock){
 const name='fast-sha256',version=contract.dependencies?.[name],root=lock.packages?.[''],entry=lock.packages?.['node_modules/'+name]
 const matches=[...sourceLock.matchAll(/^  fast-sha256@([^:\s]+):\r?\n    resolution: \{integrity: (sha512-[A-Za-z0-9+/=]+)\}\r?$/gm)]
 if(version!=='1.3.0'||matches.length!==1||matches[0][1]!==version||!root||entry?.version!==version||
  entry.resolved!==`https://registry.npmjs.org/fast-sha256/-/fast-sha256-${version}.tgz`||entry.integrity!==matches[0][2]||
  Object.keys(entry.dependencies??{}).length||Object.keys(entry.optionalDependencies??{}).length||
  (manifest.dependencies?.[name]!==undefined&&manifest.dependencies[name]!==version)||
  (root.dependencies?.[name]!==undefined&&root.dependencies[name]!==version))
  throw Error('发行模板的 fast-sha256 固定叶与源码锁不一致，拒绝生成或下载替代依赖。')
 manifest.dependencies={...manifest.dependencies,[name]:version}
 lock.packages['']={...root,dependencies:{...root.dependencies,[name]:version}}
}
