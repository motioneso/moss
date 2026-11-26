"""Parser/policy tests, separate from the real linked CI negative controls."""
import os
import importlib.util
from pathlib import Path
import struct
import subprocess
import tempfile
import unittest
from unittest.mock import patch

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
    def test_extension_imports_bundled_postgres_exe(self):
        with tempfile.TemporaryDirectory() as root:
            root = Path(root)
            bundle, system = root / "bundle", root / "system"
            (bundle / "bin").mkdir(parents=True)
            (bundle / "lib").mkdir()
            system.mkdir()
            (bundle / "lib/vector.dll").write_bytes(pe_fixture(["postgres.exe"]))
            with self.assertRaisesRegex(ValueError, "Windows dependency outside bundle"):
                validate_windows(bundle, system)
            (bundle / "bin/postgres.exe").write_bytes(pe_fixture([]))
            validate_windows(bundle, system)

    @unittest.skipIf(os.name == "nt", "Mach-O dependency paths use POSIX syntax")
    def test_mac_copies_loader_relative_sibling_from_original_directory(self):
        spec = importlib.util.spec_from_file_location("builder", Path(__file__).with_name("build-pg-bundle.py"))
        builder = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(builder)
        with tempfile.TemporaryDirectory() as root:
            root = Path(root)
            bundle, original = root / "bundle", root / "icu"
            (bundle / "bin").mkdir(parents=True)
            (bundle / "lib").mkdir()
            original.mkdir()
            (bundle / "bin/initdb").write_bytes(b"executable fixture")
            (original / "libicuuc.dylib").write_bytes(b"icu fixture")
            (original / "libicudata.dylib").write_bytes(b"icu data fixture")

            def otool(args, **kwargs):
                file = Path(args[-1])
                dep = {"initdb": str(original / "libicuuc.dylib"),
                       "libicuuc.dylib": "@loader_path/libicudata.dylib"}.get(file.name)
                output = str(file) + ":\n" + (f"\t{dep} (compatibility version 1.0.0)\n" if dep else "")
                return subprocess.CompletedProcess(args, 0, stdout=output)

            with patch.object(builder.subprocess, "run", side_effect=otool), patch.object(builder, "run"):
                builder.relocate_mac(bundle)
            self.assertEqual((bundle / "lib/libicudata.dylib").read_bytes(), b"icu data fixture")

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

    def test_optional_runtime_in_system32_still_requires_bundle_copy(self):
        with tempfile.TemporaryDirectory() as root:
            root = Path(root)
            bundle, system = root / "bundle", root / "system"
            (bundle / "bin").mkdir(parents=True)
            system.mkdir()
            (system / "VCRUNTIME140.dll").write_bytes(b"runner runtime fixture")
            (bundle / "bin/probe.exe").write_bytes(pe_fixture(["VCRUNTIME140.dll"]))
            with self.assertRaisesRegex(ValueError, "Windows dependency outside bundle"):
                validate_windows(bundle, system)
            (bundle / "bin/VCRUNTIME140.dll").write_bytes(pe_fixture([]))
            validate_windows(bundle, system)

    @unittest.skipIf(os.name == "nt", "Creating Windows symlinks needs extra privileges")
    def test_bundle_with_symlinked_parent_is_normalized(self):
        with tempfile.TemporaryDirectory() as root:
            root = Path(root)
            real, alias = root / "real", root / "alias"
            (real / "bin").mkdir(parents=True)
            alias.symlink_to(real, target_is_directory=True)
            (real / "bin/probe.exe").write_bytes(pe_fixture([]))
            validate_windows(alias, root)


if __name__ == "__main__":
    unittest.main()
