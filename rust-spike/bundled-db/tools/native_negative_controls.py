"""Plant real linked outside dependencies on the CI platform, then run the gate."""
import os
from pathlib import Path
import platform
import subprocess
import tempfile


def outside_dependency(bundle, scratch, refuses):
    system = platform.system()
    if system not in ("Darwin", "Windows"):
        return
    with tempfile.TemporaryDirectory(prefix="outside-library-", dir=scratch) as temporary:
        work = Path(temporary)
        outside, source = work / "outside.c", work / "probe.c"
        if system == "Darwin":
            outside.write_text("int outside(void) { return 428; }\n")
            source.write_text("extern int outside(void); int probe(void) { return outside(); }\n")
            library = work / "liboutside_js428.dylib"
            probe = bundle / "lib" / "outside_probe.dylib"
            subprocess.run(["cc", "-dynamiclib", str(outside), "-install_name", str(library),
                            "-o", str(library)], check=True)
            try:
                subprocess.run(["cc", "-dynamiclib", str(source), str(library),
                                "-install_name", "@loader_path/outside_probe.dylib",
                                "-o", str(probe)], check=True)
                refuses("macOS planted outside library",
                        "macOS dependency outside bundle for outside_probe.dylib:")
            finally:
                probe.unlink(missing_ok=True)
        else:
            outside.write_text("__declspec(dllexport) int outside(void) { return 428; }\n")
            source.write_text("__declspec(dllimport) int outside(void); "
                              "__declspec(dllexport) int probe(void) { return outside(); }\n")
            vswhere = Path(os.environ["ProgramFiles(x86)"]) / "Microsoft Visual Studio/Installer/vswhere.exe"
            vs = subprocess.check_output([str(vswhere), "-latest", "-property", "installationPath"], text=True).strip()
            probe = bundle / "bin" / "outside_probe.dll"
            script = work / "build.cmd"
            script.write_text(
                f'@echo off\ncall "{vs}\\VC\\Auxiliary\\Build\\vcvars64.bat"\n'
                'if errorlevel 1 exit /b %errorlevel%\n'
                'cl /nologo /LD outside.c /link /OUT:outside_js428.dll /IMPLIB:outside.lib\n'
                'if errorlevel 1 exit /b %errorlevel%\n'
                f'cl /nologo /LD probe.c outside.lib /link /OUT:"{probe}" /IMPLIB:probe.lib\n'
                'exit /b %errorlevel%\n')
            try:
                subprocess.run(["cmd", "/d", "/c", str(script)], cwd=work, check=True)
                env = dict(os.environ)
                # The loader could find it here; the audit must still refuse it.
                env["PATH"] = str(work) + os.pathsep + env["PATH"]
                refuses("Windows planted outside DLL",
                        "Windows dependency outside bundle for outside_probe.dll: outside_js428.dll", env)
            finally:
                probe.unlink(missing_ok=True)
