"""Parser/policy tests, separate from the real linked CI negative controls."""
from pathlib import Path
import struct
import tempfile
import unittest

from bundle_libraries import pe_imports, validate_windows


def pe_fixture(names, plus=True, delayed=False):
    data = bytearray(2048)
    data[:2] = b"MZ"
    def put(fmt, offset, *values):
        struct.pack_into("<" + fmt, data, offset, *values)
    put("I", 0x3c, 0x80)
    data[0x80:0x84] = b"PE\0\0"
    put("H", 0x86, 1)
    optional, optional_size = 0x98, 240 if plus else 224
    put("H", 0x94, optional_size)
    put("H", optional, 0x20b if plus else 0x10b)
    put("Q" if plus else "I", optional + (24 if plus else 28), 0x400000)
    put("I", optional + 60, 512)
    directories = optional + (112 if plus else 96)
    put("I", directories - 4, 16)
    stride, index = (32, 13) if delayed else (20, 1)
    put("II", directories + index * 8, 0x1000, (len(names) + 1) * stride)
    put("IIII", optional + optional_size + 8, 1536, 0x1000, 1536, 512)
    for i, name in enumerate(names):
        at, name_at = 512 + i * stride, 1024 + i * 128
        fields = [0] * (stride // 4)
        if delayed:
            fields[0], fields[1] = 1, 0x1000 + name_at - 512
        else:
            fields[3] = 0x1000 + name_at - 512
        put("I" * len(fields), at, *fields)
        encoded = name.encode("ascii") + b"\0"
        data[name_at:name_at + len(encoded)] = encoded
    return data


class LibraryTests(unittest.TestCase):
    def test_reads_pe32_pe64_and_delay_imports(self):
        with tempfile.TemporaryDirectory() as root:
            file = Path(root) / "probe.dll"
            for plus in (False, True):
                for delayed in (False, True):
                    with self.subTest(plus=plus, delayed=delayed):
                        file.write_bytes(pe_fixture(["KERNEL32.dll", "outside.dll"], plus, delayed))
                        self.assertEqual(pe_imports(file), ["KERNEL32.dll", "outside.dll"])

    def test_rejects_truncated_or_unmapped_pe(self):
        with tempfile.TemporaryDirectory() as root:
            file = Path(root) / "probe.exe"
            for content in (b"MZ", pe_fixture(["outside.dll"])[:600]):
                file.write_bytes(content)
                with self.assertRaises(ValueError):
                    pe_imports(file)

    def test_outside_dll_refused_then_bundled_dll_accepted(self):
        with tempfile.TemporaryDirectory() as root:
            root = Path(root)
            bundle, system = root / "bundle", root / "system"
            (bundle / "bin").mkdir(parents=True)
            system.mkdir()
            (system / "KERNEL32.dll").write_bytes(b"system fixture")
            (bundle / "bin/probe.exe").write_bytes(pe_fixture(["KERNEL32.dll", "outside.dll"]))
            with self.assertRaisesRegex(ValueError, "Windows dependency outside bundle"):
                validate_windows(bundle, system)
            (bundle / "bin/outside.dll").write_bytes(pe_fixture([]))
            validate_windows(bundle, system)


if __name__ == "__main__":
    unittest.main()
