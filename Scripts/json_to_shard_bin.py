#!/usr/bin/env python3
"""
Convert all package JSON files in a directory into validated shard .bin files.

What it does (single pass):
1) Finds *.json files (excluding file_mapping.json by default)
2) Validates JSON parse
3) Optionally enforces package shape (format_version + chunks)
4) Writes gzip payload directly to shard_<code>.bin
5) Re-reads output and validates decompression + JSON parse
6) Writes file_mapping.json summary

Usage:
  python3 json_to_shard_bin.py
  python3 json_to_shard_bin.py "/path/to/folder"
  python3 json_to_shard_bin.py --include-non-packages
"""

from __future__ import annotations

import argparse
import datetime
import gzip
import hashlib
import json
import random
import string
from pathlib import Path
from typing import Any, Dict, List, Tuple


def format_bytes(num_bytes: int) -> str:
    units = ["B", "KB", "MB", "GB", "TB"]
    size = float(num_bytes)
    idx = 0
    while size >= 1024 and idx < len(units) - 1:
        size /= 1024.0
        idx += 1
    if idx == 0:
        return f"{int(size)} {units[idx]}"
    return f"{size:.1f} {units[idx]}"


def sha256_hex(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def make_code(used_codes: set[str]) -> str:
    # Digit-letter-digit (e.g., 4a8)
    while True:
        code = f"{random.choice(string.digits)}{random.choice(string.ascii_lowercase)}{random.choice(string.digits)}"
        if code not in used_codes:
            used_codes.add(code)
            return code


def is_package_json(obj: Any) -> bool:
    return (
        isinstance(obj, dict)
        and isinstance(obj.get("format_version"), str)
        and isinstance(obj.get("chunks"), list)
    )


def read_json(path: Path) -> Any:
    with path.open("r", encoding="utf-8") as f:
        return json.load(f)


def canonical_json_bytes(obj: Any) -> bytes:
    # Produce clean UTF-8 JSON bytes to avoid accidental trailing junk.
    return json.dumps(obj, ensure_ascii=False, separators=(",", ":")).encode("utf-8")


def gzip_bytes(payload: bytes) -> bytes:
    return gzip.compress(payload, compresslevel=9)


def verify_bin_is_valid_json_gzip(bin_path: Path) -> None:
    raw = bin_path.read_bytes()
    text = gzip.decompress(raw).decode("utf-8")
    json.loads(text)


def process_file(
    json_path: Path,
    out_dir: Path,
    used_codes: set[str],
    prefix: str,
) -> Dict[str, Any]:
    obj = read_json(json_path)
    canonical = canonical_json_bytes(obj)
    gz_payload = gzip_bytes(canonical)

    code = make_code(used_codes)
    out_name = f"{prefix}_{code}.bin"
    out_path = out_dir / out_name
    out_path.write_bytes(gz_payload)

    # Validate what we just wrote.
    verify_bin_is_valid_json_gzip(out_path)

    doc_meta = obj.get("document_metadata") if isinstance(obj, dict) else None
    document_id = doc_meta.get("id") if isinstance(doc_meta, dict) else None
    document_name = doc_meta.get("filename") if isinstance(doc_meta, dict) else None

    return {
        "source_json": json_path.name,
        "output_bin": out_name,
        "shard": out_name.removesuffix(".bin"),
        "size_bytes": out_path.stat().st_size,
        "size_human": format_bytes(out_path.stat().st_size),
        "sha256": sha256_hex(gz_payload),
        "document_id": document_id,
        "document_name": document_name,
    }


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Convert JSON package files to validated shard_*.bin gzip files."
    )
    parser.add_argument(
        "directory",
        nargs="?",
        default=".",
        help="Target directory (default: current directory)",
    )
    parser.add_argument(
        "--prefix",
        default="shard",
        help="Output filename prefix (default: shard)",
    )
    parser.add_argument(
        "--mapping",
        default="file_mapping.json",
        help="Mapping output filename (default: file_mapping.json)",
    )
    parser.add_argument(
        "--include-non-packages",
        action="store_true",
        help="Also convert JSON files that do not look like package JSON",
    )
    args = parser.parse_args()

    target_dir = Path(args.directory).expanduser().resolve()
    if not target_dir.is_dir():
        raise SystemExit(f"Directory not found: {target_dir}")

    mapping_path = target_dir / args.mapping
    json_files = sorted(
        p for p in target_dir.glob("*.json")
        if p.is_file() and p.name != mapping_path.name
    )

    if not json_files:
        raise SystemExit(f"No .json files found in: {target_dir}")

    print(f"Found {len(json_files)} JSON file(s) in {target_dir}")
    used_codes: set[str] = set()
    results: List[Dict[str, Any]] = []
    skipped: List[Tuple[str, str]] = []

    for path in json_files:
        try:
            obj = read_json(path)
        except Exception as e:
            skipped.append((path.name, f"invalid JSON: {e}"))
            continue

        if not args.include_non_packages and not is_package_json(obj):
            skipped.append((path.name, "not a package JSON (missing format_version/chunks)"))
            continue

        try:
            info = process_file(path, target_dir, used_codes, args.prefix)
            results.append(info)
            print(
                f"OK: {path.name} -> {info['output_bin']} "
                f"({info['size_human']})"
            )
        except Exception as e:
            skipped.append((path.name, f"conversion failed: {e}"))

    mapping_data = {
        "generated_at": datetime.datetime.utcnow().isoformat() + "Z",
        "directory": str(target_dir),
        "converted_count": len(results),
        "skipped_count": len(skipped),
        "files": results,
        "skipped": [{"file": name, "reason": reason} for name, reason in skipped],
    }
    with mapping_path.open("w", encoding="utf-8") as f:
        json.dump(mapping_data, f, indent=2, ensure_ascii=False)

    print(f"\nMapping saved: {mapping_path}")
    print(f"Converted: {len(results)} | Skipped: {len(skipped)}")


if __name__ == "__main__":
    main()
