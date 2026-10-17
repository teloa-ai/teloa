import hashlib
import importlib.util
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace


class HardwareBackupTests(unittest.TestCase):
    def setUp(self):
        spec = importlib.util.spec_from_file_location('teloa_firmware', Path(__file__).parents[1] / 'teloa.py')
        self.tool = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.tool)
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.image = b'factory-image' * 100
        self.backup = self.root / 'factory.bin'
        self.backup.write_bytes(self.image)
        self.backup.chmod(0o600)
        self.profile = {
            'schema': 1, 'port': '/dev/cu.test',
            'probe': {'chip': 'esp32s3', 'flashBytes': len(self.image), 'deviceDigest': 'a' * 64,
                      'secureBoot': False, 'flashEncryption': False, 'downloadRestricted': False},
            'board': {'id': 'teloa-bubble', 'pcb': 'esp-vocat-v1.2', 'psramBytes': 16 * 1024 * 1024,
                      'peripheralsConfirmed': True},
            'backup': {'path': str(self.backup), 'size': len(self.image),
                       'sha256': hashlib.sha256(self.image).hexdigest(), 'verified': True},
        }

    def test_unknown_board_or_missing_psram_cannot_pass_install_gate(self):
        self.profile['board']['pcb'] = 'unverified-pcb'
        with self.assertRaises(self.tool.FirmwareError):
            self.tool.validate_recovery(self.profile)
        self.profile['board'] = None
        with self.assertRaises(self.tool.FirmwareError):
            self.tool.validate_recovery(self.profile)

    def test_missing_or_corrupt_backup_cannot_pass_install_gate(self):
        self.backup.write_bytes(b'corrupt')
        with self.assertRaises(self.tool.FirmwareError):
            self.tool.validate_recovery(self.profile)
        self.profile['backup'] = None
        with self.assertRaises(self.tool.FirmwareError):
            self.tool.validate_recovery(self.profile)

    def test_full_flash_capacity_and_two_read_verification_are_required(self):
        self.profile['probe']['flashBytes'] += 1
        with self.assertRaises(self.tool.FirmwareError):
            self.tool.validate_recovery(self.profile)
        self.profile['probe']['flashBytes'] -= 1
        self.profile['backup']['verified'] = False
        with self.assertRaises(self.tool.FirmwareError):
            self.tool.validate_recovery(self.profile)

    def test_existing_security_restrictions_refuse_install_without_bypass(self):
        for field in ('secureBoot', 'flashEncryption', 'downloadRestricted'):
            with self.subTest(field=field):
                self.profile['probe'][field] = True
                with self.assertRaises(self.tool.FirmwareError):
                    self.tool.validate_recovery(self.profile)
                self.profile['probe'][field] = False

    def test_unknown_security_is_not_treated_as_disabled(self):
        self.profile['probe']['secureBoot'] = None
        with self.assertRaises(self.tool.FirmwareError):
            self.tool.validate_recovery(self.profile)

    def test_verified_full_backup_passes_recovery_gate(self):
        self.tool.validate_recovery(self.profile)

    def test_unlisted_serial_path_never_reaches_device(self):
        with self.assertRaises(self.tool.FirmwareError):
            self.tool.select_port('/tmp/foreign', [{'port': '/dev/cu.test'}])
        self.assertEqual(self.tool.select_port(None, [{'port': '/dev/cu.test'}]), '/dev/cu.test')

    def test_inconsistent_double_read_leaves_no_trusted_backup(self):
        readings = iter([self.image, b'x' * len(self.image)])
        target = self.root / 'new-factory.bin'
        with self.assertRaises(self.tool.FirmwareError):
            self.tool.backup_flash(lambda size: next(readings), len(self.image), target)
        self.assertFalse(target.exists())

    def test_backup_is_private_and_never_overwrites_existing_recovery(self):
        target = self.root / 'new-factory.bin'
        result = self.tool.backup_flash(lambda size: self.image, len(self.image), target)
        self.assertEqual(result['sha256'], hashlib.sha256(self.image).hexdigest())
        self.assertEqual(target.stat().st_mode & 0o777, 0o600)
        with self.assertRaises(self.tool.FirmwareError):
            self.tool.backup_flash(lambda size: self.image, len(self.image), target)
        self.assertEqual(target.read_bytes(), self.image)

    def test_probe_uses_sdk_chip_identity_and_does_not_guess_board(self):
        reader = self.tool.EspReader('/dev/cu.test')
        reader.esptool = SimpleNamespace(cmds=SimpleNamespace(detect_flash_size=lambda esp: '32MB'))
        reader.device = SimpleNamespace(
            CHIP_NAME='ESP32-S3', IMAGE_CHIP_ID=9, secure_download_mode=False,
            get_security_info=lambda: {'parsed_flags': {'SECURE_BOOT_EN': False}, 'flash_crypt_cnt': 0},
            flash_id=lambda: 0x3980c2, read_mac=lambda: b'123456',
            get_chip_description=lambda: 'ESP32-S3', get_chip_features=lambda: ['test'],
        )
        probe = reader.probe()
        self.assertEqual(probe['chip'], 'esp32s3')
        self.assertEqual(probe['flashBytes'], 32 * 1024 * 1024)
        self.assertNotIn('psramBytes', probe)
        self.assertNotIn('mac', probe)


if __name__ == '__main__':
    unittest.main()
