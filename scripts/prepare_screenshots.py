"""Frame captured report canvases without resampling or altering their content."""
from pathlib import Path
import hashlib
import json
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
# Report canvas bounds inspected in the original Desktop captures.
CAPTURES = [
    ("01-national", (1472, 872), (124, 174, 1287, 808)),
    ("02-province", (1361, 796), (137, 172, 1163, 733)),
    ("03-district", (1361, 796), (137, 172, 1163, 733)),
]


def main():
    output = ROOT / "store/screenshots"
    output.mkdir(parents=True, exist_ok=True)
    records = []
    for name, expected_size, bounds in CAPTURES:
        source = ROOT / "store/evidence" / f"{name}-raw.png"
        with Image.open(source) as original:
            if original.size != expected_size:
                raise ValueError(f"Unexpected source dimensions: {source}")
            report = original.convert("RGB").crop(bounds)
        canvas = Image.new("RGB", (1366, 768), "white")
        offset = ((1366 - report.width) // 2, (768 - report.height) // 2)
        canvas.paste(report, offset)
        target = output / f"{name}.png"
        canvas.save(target, optimize=True)
        with Image.open(target) as saved:
            assert saved.size == (1366, 768)
            assert saved.crop((*offset, offset[0] + report.width,
                               offset[1] + report.height)).tobytes() == report.tobytes()
        assert target.stat().st_size <= 1024 * 1024
        records.append({"source": source.relative_to(ROOT).as_posix(),
                        "sourceSha256": hashlib.sha256(source.read_bytes()).hexdigest(),
                        "cropBounds": bounds, "offset": offset,
                        "output": target.relative_to(ROOT).as_posix(),
                        "bytes": target.stat().st_size,
                        "sha256": hashlib.sha256(target.read_bytes()).hexdigest(),
                        "reportPixelsUnchanged": True})
    (output / "provenance.json").write_text(json.dumps(records, indent=2), encoding="utf-8")
    print(json.dumps(records, indent=2))


if __name__ == "__main__":
    main()
