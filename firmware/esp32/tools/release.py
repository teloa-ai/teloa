"""离线候选清单与恢复检查。不打开设备，也不提供刷写命令。"""
import argparse
import base64
import hashlib
import json
import re
from pathlib import Path
from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives import hashes,serialization
from cryptography.hazmat.primitives.asymmetric import padding,rsa
from teloa import FirmwareError,read_profile,validate_probe,validate_recovery,private_parent

FIELDS=('releaseId','boardId','chip','partitionSha256','configSchema','resourceVersion','appVersion','appSha256','appSize','sourceRevision')
SLOT_SIZE=0x3f0000
class ReleaseError(FirmwareError):pass

def sha(data):return hashlib.sha256(data).hexdigest()
def canonical(fields):
    if set(fields)!=set(FIELDS):raise ReleaseError('候选清单字段不兼容。')
    if fields['boardId']!='teloa-bubble' or fields['chip']!='esp32s3':raise ReleaseError('候选板型或芯片不兼容。')
    if type(fields['configSchema']) is not int or fields['configSchema']!=1 or type(fields['resourceVersion']) is not int or fields['resourceVersion']!=1:raise ReleaseError('配置或资源版本不兼容。')
    if type(fields['appSize']) is not int or not 24<=fields['appSize']<=SLOT_SIZE:raise ReleaseError('镜像超过实际应用槽。')
    for key in ('partitionSha256','appSha256','sourceRevision'):
        if not isinstance(fields[key],str) or not re.fullmatch('[a-f0-9]{'+('40' if key=='sourceRevision' else '64')+'}',fields[key]):raise ReleaseError('候选来源或摘要无法核对。')
    for key in ('releaseId','appVersion'):
        if not isinstance(fields[key],str) or not re.fullmatch('[a-zA-Z0-9][a-zA-Z0-9._-]{0,95}',fields[key]):raise ReleaseError('候选版本格式无效。')
    return json.dumps({key:fields[key] for key in FIELDS},ensure_ascii=False,separators=(',',':')).encode('utf-8')

def sign_manifest(fields,key):
    if not isinstance(key,rsa.RSAPrivateKey) or key.key_size!=3072:raise ReleaseError('开发候选需要独立 RSA-3072 签名密钥。')
    signature=key.sign(canonical(fields),padding.PSS(mgf=padding.MGF1(hashes.SHA256()),salt_length=32),hashes.SHA256())
    return {**fields,'signature':base64.b64encode(signature).decode('ascii')}

def verify_manifest(manifest,image,partition,key):
    if not isinstance(manifest,dict) or set(manifest)!=set(FIELDS)|{'signature'}:raise ReleaseError('清单字段不兼容。')
    fields={name:manifest[name] for name in FIELDS};data=canonical(fields)
    if len(image)!=fields['appSize'] or sha(image)!=fields['appSha256'] or sha(partition)!=fields['partitionSha256']:raise ReleaseError('候选镜像或分区摘要不匹配。')
    if image[0]!=0xe9 or int.from_bytes(image[12:14],'little')!=9:raise ReleaseError('镜像不是 ESP32-S3 应用。')
    if not isinstance(key,rsa.RSAPublicKey) or key.key_size!=3072:raise ReleaseError('公钥不兼容。')
    try:key.verify(base64.b64decode(manifest['signature'],validate=True),data,padding.PSS(mgf=padding.MGF1(hashes.SHA256()),salt_length=32),hashes.SHA256())
    except (InvalidSignature,ValueError,TypeError):raise ReleaseError('候选清单验签失败。') from None
    return True

def recovery_report(profile):
    probe=validate_probe(profile);backup=profile.get('backup') or {};path=private_parent(backup.get('path',''))
    if path.is_symlink() or path.stat().st_mode&0o077 or path.stat().st_size!=probe['flashBytes'] or sha(path.read_bytes())!=backup.get('sha256') or backup.get('verified') is not True:raise ReleaseError('出厂备份无法复核。')
    blockers=[]
    try:validate_recovery(profile)
    except FirmwareError as error:blockers.append(str(error))
    blockers.append('实体写入、首次安装及恢复必须另行取得用户明确确认。')
    return {'schema':1,'flashBytes':probe['flashBytes'],'backupSha256':backup['sha256'],'backupVerifiedOffline':True,'installable':False,'blockers':blockers,'restore':{'offset':0,'size':probe['flashBytes'],'source':'原设备完整出厂备份','requiresSameDevice':True,'requiresSecurityRecheck':True},'preserve':['原 NVS','原 assets','原分区布局','未使用的 Flash'],'notExecuted':['刷写','擦除','OTA','eFuse','USB 配置写入']}

def main():
    parser=argparse.ArgumentParser(description=__doc__);commands=parser.add_subparsers(dest='command',required=True)
    verify=commands.add_parser('verify');verify.add_argument('--manifest',type=Path,required=True);verify.add_argument('--app',type=Path,required=True);verify.add_argument('--partition',type=Path,required=True);verify.add_argument('--public-key',type=Path,required=True)
    recovery=commands.add_parser('recovery');recovery.add_argument('--profile',type=Path,required=True)
    args=parser.parse_args()
    if args.command=='verify':
        verify_manifest(json.loads(args.manifest.read_text()),args.app.read_bytes(),args.partition.read_bytes(),serialization.load_pem_public_key(args.public_key.read_bytes()));print('候选清单与镜像离线校验通过；不代表板型和实体设备验收通过。')
    else:print(json.dumps(recovery_report(read_profile(args.profile)),ensure_ascii=False,indent=2))


def extract_factory_app(backup,offset=0x20000,slot_size=SLOT_SIZE):
    """只读取已经复核的完整备份，提取可放入备用槽的原应用。"""
    import struct
    header=backup[offset:offset+24]
    if len(header)!=24 or header[0]!=0xe9 or not 1<=header[1]<=16 or int.from_bytes(header[12:14],'little')!=9 or header[23] not in (0,1):raise ReleaseError('原应用头无法核对。')
    at=offset+24;checksum=0xef
    for _ in range(header[1]):
        if at+8>min(len(backup),offset+slot_size):raise ReleaseError('原应用段表越界。')
        length=struct.unpack_from('<I',backup,at+4)[0];at+=8
        if at+length>min(len(backup),offset+slot_size):raise ReleaseError('原应用段越界。')
        for byte in backup[at:at+length]:checksum^=byte
        at+=length
    end=offset+((at-offset+16)//16)*16
    total=end+(32 if header[23] else 0)
    if total>min(len(backup),offset+slot_size) or backup[end-1]!=checksum:raise ReleaseError('原应用校验和不匹配。')
    if header[23] and hashlib.sha256(backup[offset:end]).digest()!=backup[end:total]:raise ReleaseError('原应用 SHA-256 不匹配。')
    return backup[offset:total]


def trial_otadata():
    """离线准备 slot0 试运行、slot1 原应用有效的双槽选择记录。"""
    import struct
    import zlib
    def sector(sequence,state):
        number=struct.pack('<I',sequence)
        return struct.pack('<I20sII',sequence,b'\xff'*20,state,zlib.crc32(number,0xffffffff))+b'\xff'*(4096-32)
    return sector(3,0)+sector(2,2)


if __name__=='__main__':
    try:main()
    except (FirmwareError,OSError,ValueError):raise SystemExit('离线校验未通过，请保留原文件并核对候选、来源与恢复记录。')
