"""Use Ubuntu's standard archive for bounded hosted-browser provisioning."""

from pathlib import Path


def configure_mirrors(apt: Path) -> None:
    sources = [apt / "apt-mirrors.txt", apt / "sources.list"]
    sources += list((apt / "sources.list.d").glob("*.sources"))
    sources += list((apt / "sources.list.d").glob("*.list"))
    for source in sources:
        if not source.is_file():
            continue
        original = source.read_text()
        updated = original.replace("azure.archive.ubuntu.com", "archive.ubuntu.com")
        if updated != original:
            source.write_text(updated)
            print(f"Using archive.ubuntu.com in {source.name}")


if __name__ == "__main__":
    configure_mirrors(Path("/etc/apt"))
