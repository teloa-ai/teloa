import {Context} from '@deepseek-ai/cordis'
import type {PeerScope} from '@deepseek-ai/dsh-typert-protocol'
import {randomUUID} from 'node:crypto'
import type {TestContext} from 'node:test'

/** 无网络认证层的宿主集成测试显式持有本机 owner Peer；使用官方生命周期形状，不替换访问策略。 */
export function createNativeOwnerPeer(t:Pick<TestContext,'after'>):PeerScope{
 const ctx=new Context(),lifetime=new AbortController()
 const peer:PeerScope={id:randomUUID() as PeerScope['id'],ctx,principal:Object.freeze({kind:'owner'}),signal:lifetime.signal,interactions:'none',async dispose(){lifetime.abort();await ctx.fiber.dispose()}}
 t.after(()=>peer.dispose())
 return Object.freeze(peer)
}
