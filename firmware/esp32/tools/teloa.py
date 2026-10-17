"""Teloa 固件的只读探测与出厂备份。此阶段不提供擦除或写入命令。"""

import argparse
import contextlib
import hashlib
import io
import json
import os
import stat
import sys
from pathlib import Path


class FirmwareError(Exception):
    pass


def digest(data):
    return hashlib.sha256(data).hexdigest()


def select_port(requested, ports):
    available = [row['port'] for row in ports]
    if requested is not None:
        if requested not in available:
            raise FirmwareError('请选择实际枚举到的 USB 数据串口。')
        return requested
    if len(available) != 1:
        raise FirmwareError('未发现唯一 USB 数据串口，请连接设备或用 --port 选择已列出的串口。')
    return available[0]


def enumerate_ports():
    try:
        from serial.tools.list_ports import comports
    except ImportError:
        raise FirmwareError('请在独立工具环境安装锁定的 esptool 依赖。') from None
    return [{'port': p.device, 'vid': p.vid, 'pid': p.pid} for p in comports() if p.vid is not None]


def private_parent(path):
    path = Path(path).absolute()
    parent = path.parent
    if not parent.is_dir() or parent.is_symlink():
        raise FirmwareError('记录和备份必须放在本人专用的 0700 目录。')
    parent = parent.resolve()
    info = parent.stat()
    if info.st_mode & 0o077 or info.st_uid != os.geteuid():
        raise FirmwareError('记录和备份必须放在本人专用的 0700 目录。')
    return parent / path.name


def private_write(path, data):
    path = private_parent(path)
    try:
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    except OSError:
        raise FirmwareError('目标已经存在或不可安全创建，保留原文件。') from None
    with os.fdopen(fd, 'wb') as output:
        output.write(data)
        output.flush()
        os.fsync(output.fileno())


def read_profile(path):
    path = private_parent(path)
    try:
        info = path.lstat()
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_mode & 0o077:
            raise FirmwareError('设备记录必须是本人专用的普通文件。')
        profile = json.loads(path.read_text(encoding='utf-8'))
    except (OSError, ValueError):
        raise FirmwareError('设备记录无法读取，请保留原文件并重新核对。') from None
    if not isinstance(profile, dict) or profile.get('schema') != 1:
        raise FirmwareError('设备记录版本不兼容。')
    return profile


def validate_probe(profile):
    probe = profile.get('probe') or {}
    if probe.get('chip') != 'esp32s3' or not isinstance(probe.get('flashBytes'), int) or probe['flashBytes'] <= 0:
        raise FirmwareError('实际芯片或 Flash 容量尚未核实。')
    if not isinstance(probe.get('deviceDigest'), str) or len(probe['deviceDigest']) != 64:
        raise FirmwareError('设备身份摘要缺失。')
    return probe


def validate_recovery(profile):
    probe = validate_probe(profile)
    if any(probe.get(field) is not False for field in ('secureBoot', 'flashEncryption', 'downloadRestricted')):
        raise FirmwareError('设备有既有安全限制或状态未知，不能按普通开发设备安装。')
    board = profile.get('board') or {}
    if board.get('id') != 'teloa-bubble' or board.get('pcb') not in ('esp-vocat-v1.0', 'esp-vocat-v1.2') or not isinstance(board.get('psramBytes'), int) or board['psramBytes'] <= 0 or board.get('peripheralsConfirmed') is not True:
        raise FirmwareError('PCB、PSRAM 和外设尚未核实，不能准备安装。')
    backup = profile.get('backup') or {}
    if backup.get('verified') is not True or backup.get('size') != probe['flashBytes']:
        raise FirmwareError('缺少按实际容量读取并复核的完整出厂备份。')
    path = private_parent(backup.get('path', ''))
    try:
        info = path.lstat()
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_mode & 0o077 or info.st_size != probe['flashBytes'] or digest(path.read_bytes()) != backup.get('sha256'):
            raise FirmwareError('原固件备份的容量、权限或摘要不匹配。')
    except OSError:
        raise FirmwareError('原固件备份不可读，不能准备安装。') from None


def backup_flash(read, size, target):
    if not isinstance(size, int) or size <= 0 or size > 32 * 1024 * 1024:
        raise FirmwareError('不支持或未知的 Flash 容量。')
    target = private_parent(target)
    if target.exists() or target.is_symlink():
        raise FirmwareError('备份已经存在，不能覆盖原恢复来源。')
    first, second = read(size), read(size)
    if not isinstance(first, bytes) or not isinstance(second, bytes) or len(first) != size or len(second) != size or digest(first) != digest(second):
        raise FirmwareError('两次完整读取不一致，未创建可信备份。')
    private_write(target, first)
    if digest(target.read_bytes()) != digest(first):
        raise FirmwareError('备份落盘复核失败，不能使用。')
    return {'path': str(target), 'size': size, 'sha256': digest(first), 'verified': True}


class EspReader:
    def __init__(self, port):
        self.port = port
        self.device = None

    def __enter__(self):
        try:
            import esptool
            if esptool.__version__ != '5.6.0':
                raise FirmwareError('请使用锁定的 esptool 5.6.0 工具环境。')
            self.esptool = esptool
            self.device = esptool.detect_chip(self.port, baud=115200)
            esptool.cmds.attach_flash(self.device)
            return self
        except BaseException:
            if self.device is not None:
                self.device._port.close()
            raise

    def probe(self):
        esp = self.device
        if esp.CHIP_NAME != 'ESP32-S3' or esp.IMAGE_CHIP_ID != 9:
            raise FirmwareError('实际芯片不是本次候选支持的 ESP32-S3，未进行任何 Flash 写入。')
        info = esp.get_security_info()
        flags = info['parsed_flags']
        # 复用 esptool 的 SFDP/JEDEC 探测，不能假定容量编码固定为 ID 高字节。
        capacity = self.esptool.cmds.detect_flash_size(esp)
        sizes = {str(1 << power) + 'MB': (1 << power) * 1024 * 1024 for power in range(6)}
        if capacity not in sizes:
            raise FirmwareError('无法核实受支持的 Flash 容量。')
        return {'chip': 'esp32s3', 'flashBytes': sizes[capacity],
                'deviceDigest': digest(bytes(esp.read_mac())),
                'secureBoot': bool(flags['SECURE_BOOT_EN']),
                'flashEncryption': bool(info['flash_crypt_cnt'].bit_count() % 2),
                'downloadRestricted': bool(esp.secure_download_mode),
                'description': esp.get_chip_description(), 'features': esp.get_chip_features()}

    def read(self, size):
        if not self.device.IS_STUB:
            self.device = self.device.run_stub()
            self.device.change_baud(921600)
        return self.esptool.cmds.read_flash(self.device, 0, size, no_progress=True)

    def __exit__(self, *_):
        try:
            self.device.hard_reset()
        finally:
            self.device._port.close()


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=['ports', 'probe', 'backup', 'verify'])
    parser.add_argument('--port')
    parser.add_argument('--profile', type=Path)
    parser.add_argument('--output', type=Path)
    args = parser.parse_args(argv)
    if args.command == 'ports':
        print(json.dumps(enumerate_ports(), ensure_ascii=False))
        return
    if args.profile is None:
        raise FirmwareError('请明确指定本机私密 --profile。')
    if args.command == 'verify':
        validate_recovery(read_profile(args.profile))
        print('出厂备份和硬件记录已核对；此检查不代表发布签名或实机恢复已经通过。')
        return
    if args.command == 'probe':
        port = select_port(args.port, enumerate_ports())
        private_parent(args.profile)
        if args.profile.exists():
            raise FirmwareError('设备记录已经存在，保留原记录。')
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()), EspReader(port) as device:
            profile = {'schema': 1, 'port': port, 'probe': device.probe(), 'board': None, 'backup': None}
        private_write(args.profile, (json.dumps(profile, ensure_ascii=False, indent=2) + '\n').encode())
        probe = profile['probe']
        print(json.dumps({key: probe[key] for key in ['chip', 'flashBytes', 'secureBoot', 'flashEncryption', 'downloadRestricted']}, ensure_ascii=False))
        return
    profile = read_profile(args.profile)
    original = validate_probe(profile)
    if profile.get('backup') is not None or args.output is None:
        raise FirmwareError('备份已登记或未指定私密 --output，保留原恢复来源。')
    port = select_port(args.port or profile.get('port'), enumerate_ports())
    with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()), EspReader(port) as device:
        current = device.probe()
        if any(current[key] != original[key] for key in ['chip', 'flashBytes', 'deviceDigest', 'secureBoot', 'flashEncryption', 'downloadRestricted']):
            raise FirmwareError('当前设备与原探测记录不同，未创建备份。')
        backup = backup_flash(device.read, original['flashBytes'], args.output)
    # 派生记录另存，不覆盖最初探测；中断后两份证据均可保留。
    profile['backup'] = backup
    saved = args.profile.with_name(args.profile.stem + '.backed-up.json')
    private_write(saved, (json.dumps(profile, ensure_ascii=False, indent=2) + '\n').encode())
    print(json.dumps({'backedUp': True, 'bytes': backup['size'], 'doubleReadVerified': True}, ensure_ascii=False))


if __name__ == '__main__':
    try:
        main()
    except FirmwareError as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
    except Exception:
        print('设备读取未完成，原固件未改写。请检查连接和下载模式后重试。', file=sys.stderr)
        sys.exit(1)
