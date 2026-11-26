"""Inspect native dependency metadata without loading runner-supplied libraries."""
import os
from pathlib import Path
import struct
import subprocess

MACHO = {b"\xfe\xed\xfa\xce", b"\xce\xfa\xed\xfe", b"\xfe\xed\xfa\xcf", b"\xcf\xfa\xed\xfe",
         b"\xca\xfe\xba\xbe", b"\xbe\xba\xfe\xca", b"\xca\xfe\xba\xbf", b"\xbf\xba\xfe\xca"}

# Windows components only. In particular, the optional Visual C++ redistributable
# is not an OS dependency even when the CI runner installed it in System32.
WINDOWS_SYSTEM_DLLS = frozenset("""
advapi32.dll bcrypt.dll bcryptprimitives.dll cabinet.dll cfgmgr32.dll comdlg32.dll
comctl32.dll crypt32.dll cryptbase.dll dbghelp.dll dnsapi.dll gdi32.dll imm32.dll
iphlpapi.dll kernel32.dll kernelbase.dll mpr.dll msimg32.dll msvcrt.dll ncrypt.dll
netapi32.dll normaliz.dll ntdll.dll ole32.dll oleaut32.dll powrprof.dll propsys.dll
psapi.dll rpcrt4.dll secur32.dll security.dll setupapi.dll shell32.dll shlwapi.dll
sspicli.dll ucrtbase.dll user32.dll userenv.dll usp10.dll version.dll winhttp.dll
wininet.dll winmm.dll winspool.drv wintrust.dll wldap32.dll ws2_32.dll wtsapi32.dll
""".split())


def validate_mac(bundle):
    bundle = bundle.resolve()
    for file in bundle.rglob("*"):
        if not file.is_file():
            continue
        with file.open("rb") as stream:
            magic = stream.read(4)
        if magic not in MACHO:
            continue
        if not file.resolve().is_relative_to(bundle):
            raise ValueError(f"Native file escapes bundle: {file.name}")
        result = subprocess.run(["otool", "-L", str(file)], capture_output=True, text=True, check=True)
        for line in result.stdout.splitlines():
            # Universal binaries have one unindented architecture heading per slice.
            if not line.startswith((" ", "\t")):
                continue
            dependency = line.strip().split(" (", 1)[0]
            if dependency.startswith("/") and not dependency.startswith(("/usr/lib/", "/System/")):
                raise ValueError(f"macOS dependency outside bundle for {file.name}: {dependency}")


def pe_imports(file):
    """Read normal and delay-loaded imports from PE32/PE32+ section tables."""
    data = file.read_bytes()
    def unpack(fmt, offset):
        try:
            return struct.unpack_from("<" + fmt, data, offset)
        except struct.error as error:
            raise ValueError(f"Truncated PE file: {file.name}") from error

    if data[:2] != b"MZ":
        raise ValueError(f"Not a PE binary: {file.name}")
    pe, = unpack("I", 0x3c)
    if data[pe:pe + 4] != b"PE\0\0":
        raise ValueError(f"Invalid PE signature: {file.name}")
    sections, = unpack("H", pe + 6)
    optional_size, = unpack("H", pe + 20)
    optional = pe + 24
    magic, = unpack("H", optional)
    if magic not in (0x10b, 0x20b):
        raise ValueError(f"Unsupported PE optional header: {file.name}")
    directories = optional + (96 if magic == 0x10b else 112)
    count, = unpack("I", directories - 4)
    image_base, = unpack("I" if magic == 0x10b else "Q", optional + (28 if magic == 0x10b else 24))
    headers_size, = unpack("I", optional + 60)
    table = optional + optional_size
    if table > len(data) or directories > table:
        raise ValueError(f"Invalid PE header size: {file.name}")
    mappings = [unpack("IIII", table + i * 40 + 8) for i in range(sections)]

    def offset(rva, size):
        if 0 <= rva < headers_size and rva + size <= min(headers_size, len(data)):
            return rva
        for _, start, raw_size, raw in mappings:
            delta = rva - start
            if 0 <= delta and delta + size <= raw_size and raw + delta + size <= len(data):
                return raw + delta
        raise ValueError(f"Unmapped PE import RVA: {file.name}")

    imports = []
    for index, stride, name_field in ((1, 20, 3), (13, 32, 1)):
        if count <= index:
            continue
        if directories + (index + 1) * 8 > table:
            raise ValueError(f"Truncated PE directory table: {file.name}")
        rva, size = unpack("II", directories + index * 8)
        if not rva:
            continue
        for at in range(0, size - stride + 1, stride):
            fields = unpack("I" * (stride // 4), offset(rva + at, stride))
            if not any(fields):
                break
            name_rva = fields[name_field]
            if index == 13 and not fields[0] & 1:
                name_rva -= image_base
            start = offset(name_rva, 1)
            end = data.find(b"\0", start, min(start + 4096, len(data)))
            if end < 0:
                raise ValueError(f"Unterminated PE import name: {file.name}")
            name = data[start:end].decode("ascii")
            if not name or any(c in name for c in "/\\:") or not name.lower().endswith(".dll"):
                raise ValueError(f"Invalid PE import name: {file.name}")
            imports.append(name)
        else:
            raise ValueError(f"Unterminated PE import table: {file.name}")
    return imports


def validate_windows(bundle, system=None):
    bundle = bundle.resolve()
    system = system or Path(os.environ["SystemRoot"]) / "System32"
    for file in bundle.rglob("*"):
        if not file.is_file() or file.suffix.lower() not in (".exe", ".dll"):
            continue
        if not file.resolve().is_relative_to(bundle):
            raise ValueError(f"Native file escapes bundle: {file.name}")
        available = {p.name.casefold(): p.resolve() for p in (bundle / "bin").iterdir() if p.is_file()}
        for dependency in pe_imports(file):
            name = dependency.casefold()
            if name.startswith(("api-ms-win-", "ext-ms-win-")):
                continue  # Windows API-set contracts are provided by the OS loader.
            target = available.get(name)
            if target and target.is_relative_to(bundle):
                continue
            if name in WINDOWS_SYSTEM_DLLS and (system / dependency).is_file():
                continue
            raise ValueError(f"Windows dependency outside bundle for {file.name}: {dependency}")
