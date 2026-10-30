/** 只向原生 Host/Origin 栅栏增加显式配置的 authority；监听器仍保持回环。 */
export function trustedHostArguments(value){
 if(value===undefined||value.trim()==='')return []
 const hosts=value.split(',').map(host=>host.trim())
 for(const host of hosts){
  let url
  try{url=new URL('http://'+host)}catch{}
  if(!host||/[\s/*?#@\\]/.test(host)||host.includes('://')||!url||url.username||url.password||url.pathname!=='/'||!url.hostname||url.port==='0')throw Error('TELOA_DSH_TRUSTED_HOSTS 只接受逗号分隔的主机名或 IP，可附端口，不接受 URL、通配符或路径。')
 }
 return [...new Set(hosts)].flatMap(host=>['--trusted-host',host])
}
