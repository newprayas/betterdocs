#!/usr/bin/env python3
"""
Convert a drug_sections JSON catalog into a gzip-compressed .bin payload plus file_mapping.json.

Usage:
  python3 /path/to/Scripts/json_to_drug_sections_bin.py
  python3 /path/to/Scripts/json_to_drug_sections_bin.py ./drug_sections.json
"""

from __future__ import annotations

import argparse
import gzip
import hashlib
import json
from pathlib import Path
from typing import Any


OUTPUT_FORMAT_VERSION = "drug-sections-catalog-1.0"


def sha256_hex(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def format_bytes(num_bytes: int) -> str:
    units = ["B", "KB", "MB", "GB", "TB"]
    size = float(num_bytes)
    index = 0
    while size >= 1024 and index < len(units) - 1:
        size /= 1024
        index += 1
    return f"{int(size)} {units[index]}" if index == 0 else f"{size:.1f} {units[index]}"


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Convert drug_sections.json into drug_sections.bin and file_mapping.json."
    )
    parser.add_argument(
        "json_path",
        nargs="?",
        default="drug_sections.json",
        help="Path to the input JSON catalog (default: ./drug_sections.json).",
    )
    parser.add_argument(
        "--bin-output",
        default="drug_sections.bin",
        help="Output BIN filename (default: drug_sections.bin).",
    )
    parser.add_argument(
        "--mapping-file",
        default="file_mapping.json",
        help="Output mapping filename (default: file_mapping.json).",
    )
    args = parser.parse_args()

    json_path = Path(args.json_path).expanduser().resolve()
    if not json_path.is_file():
        raise SystemExit(f"JSON file not found: {json_path}")

    payload = json.loads(json_path.read_text(encoding="utf-8"))
    if not isinstance(payload, dict):
        raise SystemExit("Input JSON must be an object")

    payload["format_version"] = OUTPUT_FORMAT_VERSION

    json_bytes = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    gz_bytes = gzip.compress(json_bytes, compresslevel=9)

    target_dir = json_path.parent
    bin_path = target_dir / args.bin_output
    bin_path.write_bytes(gz_bytes)

    round_trip = json.loads(gzip.decompress(bin_path.read_bytes()).decode("utf-8"))
    if round_trip != payload:
        raise SystemExit("Decoded .bin JSON does not match the source JSON")

    mapping = {
        "directory": str(target_dir),
        "json_output": json_path.name,
        "bin_output": bin_path.name,
        "bin_size_bytes": bin_path.stat().st_size,
        "bin_size_human": format_bytes(bin_path.stat().st_size),
        "sha256": sha256_hex(gz_bytes),
        "drug_count": payload.get("drug_count", 0),
        "format_version": payload.get("format_version"),
    }

    mapping_path = target_dir / args.mapping_file
    mapping_path.write_text(json.dumps(mapping, indent=2, ensure_ascii=False), encoding="utf-8")

    print(f"Saved BIN to {bin_path} ({format_bytes(bin_path.stat().st_size)})")
    print(f"Saved mapping to {mapping_path}")


if __name__ == "__main__":
    main()
