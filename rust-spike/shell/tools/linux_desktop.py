"""Native GTK/WebKit payload for the build platform, not a desktop installer.

Release WebKit uses compiled-in helper paths. Files under runtime/rootfs must be
placed at the same absolute paths in a target root; environment variables alone
cannot relocate these helpers. Other desktop data is selected by moss-run.
"""
from pathlib import Path
import shutil
import subprocess


def desktop_payload(runtime: Path) -> tuple[list[Path], list[str]]:
    libdir = Path(subprocess.run(
        ["pkg-config", "--variable=libdir", "webkit2gtk-4.1"],
        check=True, capture_output=True, text=True).stdout.strip())
    if not libdir.is_absolute():
        raise ValueError("WebKit must declare an absolute build-platform library directory")
    webkit = libdir / "webkit2gtk-4.1"
    fixed = runtime / "rootfs" / webkit.relative_to("/")
    fixed.mkdir(parents=True)
    programs = []
    paths = []
    for name in ("WebKitNetworkProcess", "WebKitWebProcess", "WebKitGPUProcess",
                 "injected-bundle/libwebkit2gtkinjectedbundle.so"):
        source = webkit / name
        target = fixed / name
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, target)
        programs.append(target)
        paths.append(str(source))

    # Copy only the TLS backend; do not inherit host volume monitors/proxy settings.
    gio = runtime / "lib/gio/modules"
    gio.mkdir(parents=True)
    shutil.copy2(libdir / "gio/modules/libgiognutls.so", gio)
    subprocess.run(["gio-querymodules", str(gio)], check=True)
    programs.append(gio / "libgiognutls.so")

    # GLVND and Mesa dlopen these inputs; ldd on WebKit cannot discover them.
    # Keep a software rendering path for machines without a GPU driver install.
    dri = runtime / "lib/dri"
    dri.mkdir()
    shutil.copy2(libdir / "dri/swrast_dri.so", dri / "swrast_dri.so")
    programs.append(dri / "swrast_dri.so")
    gallium = list(libdir.glob("libgallium-*.so"))
    if len(gallium) != 1:
        raise ValueError("Expected one build-platform Mesa Gallium library")
    for source in [libdir / "libEGL_mesa.so.0", libdir / "libGLX_mesa.so.0",
                   libdir / "libGLESv2.so.2", *gallium]:
        target = runtime / "lib" / source.name
        shutil.copy2(source, target)
        programs.append(target)
    vendor = runtime / "share/glvnd/egl_vendor.d"
    vendor.mkdir(parents=True)
    (vendor / "50_mesa.json").write_text(
        '{"file_format_version":"1.0.0","ICD":{"library_path":"libEGL_mesa.so.0"}}\n')

    schemas = runtime / "share/glib-2.0/schemas"
    schemas.mkdir(parents=True)
    shutil.copy2("/usr/share/glib-2.0/schemas/gschemas.compiled", schemas)
    mime = runtime / "share/mime"
    mime.mkdir(parents=True)
    shutil.copy2("/usr/share/mime/mime.cache", mime)
    fonts = runtime / "share/fonts"
    fonts.mkdir(parents=True)
    for name in ("DejaVuSans.ttf", "DejaVuSans-Bold.ttf", "DejaVuSansMono.ttf"):
        shutil.copy2(Path("/usr/share/fonts/truetype/dejavu") / name, fonts)
    (runtime / "etc").mkdir()
    (runtime / "etc/fonts.conf").write_text('''<?xml version="1.0"?>
<!DOCTYPE fontconfig SYSTEM "urn:fontconfig:fonts.dtd">
<fontconfig>
  <dir prefix="relative">../share/fonts</dir>
  <cachedir prefix="xdg">fontconfig</cachedir>
</fontconfig>
''')
    return programs, paths
