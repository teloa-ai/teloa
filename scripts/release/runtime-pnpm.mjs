// 运行时包管理器独立于旧依赖模板钉住；11.23.0 包含 pnpm#13226 的 worker 退出修复。
export const runtimePnpmVersion='11.23.0'
const runtimePnpmPackage={
 version:runtimePnpmVersion,
 resolved:'https://registry.npmjs.org/pnpm/-/pnpm-11.23.0.tgz',
 integrity:'sha512-8ACC5bKDoZm3Tgedoo0VXACP4jL0TIoG6n3foBTs9xn8Ni95DsxnsoEG3awq+yTEmpoHkVnaVgss59Hpjv0Rrw==',
 license:'MIT',
 bin:{pn:'bin/pnpm.mjs',pnpm:'bin/pnpm.mjs',pnpx:'bin/pnpx.mjs',pnx:'bin/pnpx.mjs'},
 engines:{node:'>=22.13'},
 funding:{url:'https://opencollective.com/pnpm'},
}

/** 同步包与 npm 锁中的唯一 pnpm 叶；不改 DSH 闭包，也不依赖本机全局命令。 */
export function pinRuntimePnpm(manifest,lock){
 const root=lock.packages?.[''],current=manifest.dependencies?.pnpm,installed=lock.packages?.['node_modules/pnpm']
 if(!current||root?.dependencies?.pnpm!==current||installed?.version!==current||
  Object.keys(lock.packages).some(path=>path.endsWith('/node_modules/pnpm'))||
  Object.keys(installed.dependencies??{}).length||Object.keys(installed.optionalDependencies??{}).length)
  throw Error('发行模板的 pnpm 依赖与锁不一致，拒绝覆盖未知依赖图。')
 manifest.dependencies={...manifest.dependencies,pnpm:runtimePnpmVersion}
 lock.packages['']={...root,dependencies:{...root.dependencies,pnpm:runtimePnpmVersion}}
 lock.packages['node_modules/pnpm']=structuredClone(runtimePnpmPackage)
}
