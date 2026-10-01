import {homedir} from 'node:os'
import {join} from 'node:path'

/**
 * 数据库用例共用的容器运行时配置：显式 `DOCKER_HOST` 优先；未设时默认 OrbStack 套接字，
 * 避免本机 Docker Desktop 套接字失效时整套 PG 用例以「找不到容器运行时」失败而被误判为代码回归。
 */
export function useLocalContainerRuntime():void{
 process.env.DOCKER_HOST??='unix://'+join(homedir(),'.orbstack/run/docker.sock')
 process.env.TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE??='/var/run/docker.sock'
}
