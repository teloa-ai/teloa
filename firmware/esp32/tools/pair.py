"""受限应用 USB 配对助手。默认预检；不会刷写固件或进入下载模式。"""
import argparse
import json
import socket
import stat
import os
import time
from pathlib import Path
from teloa import FirmwareError, enumerate_ports, select_port


def ipc_call(path, request):
    path=Path(path).absolute()
    parent=path.parent.lstat();entry=path.lstat()
    if not stat.S_ISDIR(parent.st_mode) or parent.st_uid!=os.geteuid() or parent.st_mode&0o077 or not stat.S_ISSOCK(entry.st_mode) or entry.st_uid!=os.geteuid() or entry.st_mode&0o077:
        raise FirmwareError('请使用本实例本人专用的配对 socket。')
    with socket.socket(socket.AF_UNIX,socket.SOCK_STREAM) as client:
        client.settimeout(5);client.connect(str(path));client.sendall((json.dumps(request,separators=(',',':'))+'\n').encode())
        result=bytearray()
        while not result.endswith(b'\n'):
            part=client.recv(4096)
            if not part or len(result)+len(part)>32768:raise FirmwareError('本机配对响应不完整。')
            result.extend(part)
    row=json.loads(result)
    if row.get('ok') is not True:raise FirmwareError('原配对作业已失效，请在 Teloa 核对。')
    return row['value']


def exchange(serial, request):
    serial.write(('@TELOA '+json.dumps(request,separators=(',',':'))+'\n').encode());serial.flush()
    deadline=time.monotonic()+3
    while time.monotonic()<deadline:
        line=serial.readline(32769)
        if len(line)>32768:raise FirmwareError('USB 响应超出限制。')
        if line.startswith(b'@TELOA '):
            value=json.loads(line[7:])
            if not isinstance(value,dict) or value.get('type')=='pair.error':raise FirmwareError('设备拒绝配置或配置校验失败。')
            return value
    raise FirmwareError('未收到 Teloa 固件的应用 USB 响应；不会自动刷机。')


def pair(intent_id, ipc, serial, clock=time.monotonic, sleep=time.sleep):
    original=ipc({'operation':'status','id':intent_id})
    if original['state']=='paired':return {'state':'paired'}
    status=exchange(serial,{'type':'pair.status'})
    if status.get('deviceId')==intent_id and status.get('configDigest'):
        value=ipc({'operation':'complete','id':intent_id,'digest':status['configDigest']})
        return {'state':value['state']}
    exchange(serial,{'type':'pair.begin','intentId':intent_id,'host':original['host'],'serverName':original['serverName']})
    deadline=clock()+60
    while clock()<deadline:
        current=ipc({'operation':'status','id':intent_id})
        if current['state']=='cancelled' or current['expiresAt']<=time.time()*1000:raise FirmwareError('配对已取消或到期。')
        status=exchange(serial,{'type':'pair.status'})
        if status.get('intentId')==intent_id and status.get('confirmed') is True:
            provision=ipc({'operation':'provision','id':intent_id,'nonce':status['nonce'],'confirmed':True})
            try:
                response=exchange(serial,{'type':'pair.configure','intentId':intent_id,'nonce':status['nonce'],**provision})
                digest=response.get('digest')
            except FirmwareError:
                # 写入回包丢失只查同一设备配置，不生成第二份凭据。
                digest=exchange(serial,{'type':'pair.status'}).get('configDigest')
            if digest!=provision['digest']:raise FirmwareError('设备配置摘要无法核对，请查询原作业。')
            result=ipc({'operation':'complete','id':intent_id,'digest':digest})
            return {'state':result['state']}
        sleep(.25)
    raise FirmwareError('设备物理确认已超时，未写入配置。')


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--intent',required=True);parser.add_argument('--socket',required=True);parser.add_argument('--port');parser.add_argument('--write-usb-config',action='store_true')
    args=parser.parse_args()
    if not args.write_usb_config:
        print('预检模式：未打开串口、未写设备。确认本人配对意图后，显式添加 --write-usb-config 配置已安装 Teloa 的设备。');return
    ports=[row for row in enumerate_ports() if row['vid']==0x303a and row['pid']==0x1001]
    selected=select_port(args.port,ports)
    import serial
    port=serial.Serial(port=None,baudrate=115200,timeout=.2,write_timeout=3,dsrdtr=False,rtscts=False)
    port.dtr=False;port.rts=False;port.port=selected
    with port:
        print(json.dumps(pair(args.intent,lambda value:ipc_call(args.socket,value),port),ensure_ascii=False))


if __name__=='__main__':
    try:main()
    except (FirmwareError,OSError,ValueError):
        raise SystemExit('USB 配对尚未完成，请保留原作业并在 Teloa 查看状态。秘密不会输出。')
