"""Create an explicitly incomplete AppSource handoff bundle; Python 3.9+."""
import hashlib
import json
from pathlib import Path
import struct
import subprocess
import tempfile
import zipfile

ROOT = Path(__file__).resolve().parents[1]


def read_json(path):
    return json.loads(path.read_text(encoding="utf-8-sig"))


def require(condition, message):
    if not condition:
        raise ValueError(message)


def main():
    config = read_json(ROOT / "pbiviz.json")
    version = config["visual"]["version"]
    guid = config["visual"]["guid"]
    lock = read_json(ROOT / "package-lock.json")
    require(version == config["version"] == read_json(ROOT / "package.json")["version"]
            == lock["version"] == lock["packages"][""]["version"], "Version mismatch")
    package = ROOT / "dist" / f"{guid}.{version}.pbiviz"
    with zipfile.ZipFile(package) as archive:
        require(archive.testzip() is None, "Corrupt pbiviz archive")
        meta = json.loads(archive.read("package.json"))
        require(meta["visual"] == config["visual"], "Stale pbiviz metadata; rebuild")
        require(meta["version"] == version and meta["author"] == config["author"],
                "Stale pbiviz version or author; rebuild")
        resource = json.loads(archive.read(meta["resources"][0]["file"]))
        require(resource["visual"]["version"] == version, "Resource version mismatch")
        require(resource["visual"]["guid"] == guid, "Resource GUID mismatch")
    logo = ROOT / "assets/store/logo-300.png"
    header = logo.read_bytes()[:24]
    require(header[:8] == b"\x89PNG\r\n\x1a\n" and header[12:16] == b"IHDR"
            and struct.unpack(">II", header[16:24]) == (300, 300), "Invalid store logo")

    files = {package.name: package.read_bytes(), "logo-300.png": logo.read_bytes(),
             "LICENSE": (ROOT / "LICENSE").read_bytes(),
             "EULA.txt": (ROOT / "docs/EULA.md").read_bytes()}
    for path in sorted((ROOT / "docs").glob("*")):
        if path.is_file():
            files[f"docs/{path.name}"] = path.read_bytes()
    sample = ROOT / "store/sample" / f"china-map-sample-{version}.pbix"
    if sample.is_file():
        with zipfile.ZipFile(sample) as sample_archive:
            require(sample_archive.testzip() is None, "Corrupt sample PBIX")
            embedded_path = f"Report/CustomVisuals/{guid}/"
            require(json.loads(sample_archive.read(embedded_path + "package.json"))["version"]
                    == version, "Sample visual version mismatch")
            with zipfile.ZipFile(package) as package_archive:
                resource_path = meta["resources"][0]["file"]
                require(sample_archive.read(embedded_path + resource_path)
                        == package_archive.read(resource_path), "Sample visual differs from package")
        files[f"sample/{sample.name}"] = sample.read_bytes()
    for path in sorted((ROOT / "store/screenshots").glob("*.png")):
        data = path.read_bytes()
        require(data[:8] == b"\x89PNG\r\n\x1a\n" and data[12:16] == b"IHDR"
                and struct.unpack(">II", data[16:24]) == (1366, 768),
                f"Invalid screenshot dimensions: {path.name}")
        require(len(data) <= 1024 * 1024, f"Screenshot exceeds 1024 KB: {path.name}")
        files[f"screenshots/{path.name}"] = data
    screenshot_count = sum(name.startswith("screenshots/") for name in files)
    require(screenshot_count <= 5, "At most five store screenshots are allowed")
    provenance = ROOT / "store/screenshots/provenance.json"
    if provenance.is_file():
        files["screenshots/provenance.json"] = provenance.read_bytes()
    for path in sorted((ROOT / "store/evidence").glob("*.png")):
        files[f"evidence/{path.name}"] = path.read_bytes()
    licenses = []
    for location, entry in sorted(lock["packages"].items()):
        if not location or entry.get("dev") or entry.get("optional"):
            continue
        installed = ROOT / location
        installed_meta = read_json(installed / "package.json")
        require(installed_meta["version"] == entry["version"], f"Run npm ci: {location}")
        license_files = [p for p in installed.iterdir() if p.is_file()
                         and p.name.upper().startswith(("LICENSE", "NOTICE", "COPYING"))]
        require(any(p.name.upper().startswith(("LICENSE", "COPYING")) for p in license_files),
                f"Missing license: {location}")
        for dirname in ("licenses", "LICENSES"):
            folder = installed / dirname
            if folder.is_dir():
                license_files.extend(p for p in folder.rglob("*") if p.is_file())
        for path in license_files:
            files[f"third-party/{location}/{path.relative_to(installed).as_posix()}"] = path.read_bytes()
        licenses.append({"package": installed_meta["name"], "version": entry["version"],
                         "license": entry.get("license"), "location": location})

    status = {"version": version, "readyForSubmission": False,
              "pending": ["Map data provenance and redistribution permission",
                          "Offline sample PBIX validation", "Real Power BI screenshots",
                          "Remaining Desktop and Service validation", "Partner Center publisher setup"],
              "note": "Preparation bundle only. No submission or certification has occurred."}
    status["samplePbixIncluded"] = sample.is_file()
    status["validatedScreenshotCount"] = screenshot_count
    if screenshot_count:
        status["pending"].remove("Real Power BI screenshots")
    files["submission-status.json"] = json.dumps(status, indent=2).encode()
    files["third-party/index.json"] = json.dumps(licenses, indent=2).encode()
    revision = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip()
    dirty = bool(subprocess.check_output(["git", "status", "--porcelain"], cwd=ROOT, text=True).strip())
    manifest = {"version": version, "gitRevision": revision, "workingTreeDirty": dirty,
                "files": [{"path": name, "bytes": len(data),
                           "sha256": hashlib.sha256(data).hexdigest()}
                          for name, data in sorted(files.items())]}
    files["manifest.json"] = json.dumps(manifest, indent=2, ensure_ascii=False).encode("utf-8")
    output = ROOT / "dist" / f"appsource-{version}-preparation.zip"
    with tempfile.TemporaryDirectory(prefix="appsource-") as temporary:
        staging = Path(temporary) / output.name
        with zipfile.ZipFile(staging, "w", zipfile.ZIP_DEFLATED) as archive:
            for name, data in sorted(files.items()):
                archive.writestr(name, data)
        output.write_bytes(staging.read_bytes())
    digest = hashlib.sha256(output.read_bytes()).hexdigest()
    output.with_suffix(".zip.sha256").write_text(f"{digest}  {output.name}\n", encoding="ascii")
    print(f"Created: {output}\nSHA256: {digest}\nFiles: {len(files)}; readyForSubmission: false")


if __name__ == "__main__":
    main()
