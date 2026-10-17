import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path


class NativeProtocolTests(unittest.TestCase):
    def test_capture_identity_and_playback_tokens(self):
        root = Path(__file__).resolve().parents[2]
        compiler = shutil.which('clang++') or shutil.which('g++')
        self.assertIsNotNone(compiler)
        with tempfile.TemporaryDirectory() as tmp:
            output = Path(tmp) / 'state-test'
            subprocess.run([compiler, '-std=c++17', '-Wall', '-Wextra', '-Werror', '-pthread',
                            '-I', str(root / 'main/teloa'), str(Path(__file__).with_name('teloa_state_test.cc')),
                            str(root / 'main/teloa/teloa_state.cc'), '-o', str(output)], check=True)
            subprocess.run([str(output)], check=True)

    def test_firmware_only_accepts_finite_host_controls(self):
        root = Path(__file__).resolve().parents[2]
        cjson = root / 'managed_components/espressif__cjson/cJSON'
        if not (cjson / 'cJSON.c').is_file():
            self.skipTest('先按固定组件锁配置 ESP-IDF，再验证原生 JSON 控制解析')
        compiler = shutil.which('clang++') or shutil.which('g++')
        c_compiler = shutil.which('clang') or shutil.which('gcc')
        self.assertIsNotNone(compiler)
        self.assertIsNotNone(c_compiler)
        with tempfile.TemporaryDirectory() as tmp:
            obj, output = Path(tmp) / 'cjson.o', Path(tmp) / 'control-test'
            subprocess.run([c_compiler, '-std=c99', '-c', str(cjson / 'cJSON.c'), '-o', str(obj)], check=True)
            subprocess.run([compiler, '-std=c++17', '-Wall', '-Wextra', '-Werror',
                            '-I', str(cjson), '-I', str(root / 'main/teloa'),
                            str(Path(__file__).with_name('teloa_control_test.cc')),
                            str(root / 'main/teloa/teloa_control.cc'), str(obj), '-o', str(output)], check=True)
            subprocess.run([str(output)], check=True)

    def test_firmware_frame_codec_and_stream_rejection(self):
        root = Path(__file__).resolve().parents[2]
        compiler = shutil.which('clang++') or shutil.which('g++')
        self.assertIsNotNone(compiler, '需要本机 C++ 编译器验证固件的独立协议实现')
        with tempfile.TemporaryDirectory() as tmp:
            output = Path(tmp) / 'protocol-test'
            (Path(tmp) / 'esp_system.h').write_text('#pragma once\n#include <cstdlib>\n[[noreturn]] inline void esp_system_abort(const char*) { std::abort(); }\n')
            subprocess.run([compiler, '-std=c++17', '-Wall', '-Wextra', '-Werror',
                            '-I', tmp, '-I', str(root / 'main/audio'), '-I', str(root / 'main/teloa'), str(Path(__file__).with_name('teloa_frame_test.cc')),
                            str(root / 'main/teloa/teloa_frame.cc'), '-o', str(output)], check=True)
            subprocess.run([str(output)], check=True)


if __name__ == '__main__':
    unittest.main()
