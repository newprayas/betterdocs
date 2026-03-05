#!/usr/bin/env python3
"""
Split large preprocessed .bin shards into smaller .bin shards without re-embedding.

What it does:
1) Scans a directory (default: current working directory) for .bin files
2) Processes files larger than --min-input-mb (default: 60 MB)
3) Removes inline ANN payload by default (to reduce size)
4) Recompresses to `Small_<original>.bin` if it fits under --target-mb
5) Otherwise splits `chunks` into multiple files:
   `Small_<original_stem>_part01.bin`, `..._part02.bin`, etc.

No Voyage API calls are made.
"""

from __future__ import annotations

import argparse
import copy
import gzip
import json
import math
from pathlib import Path
from typing import Any, Dict, List, Tuple

MB = 1024 * 1024


def format_mb(size_bytes: int) -> str:
    return f"{size_bytes / MB:.1f} MB"


def load_gzip_json(path: Path) -> Dict[str, Any]:
    raw = path.read_bytes()
    try:
        data = json.loads(gzip.decompress(raw))
    except Exception as exc:
        raise ValueError(f"{path.name}: invalid gzip/json payload ({exc})") from exc
    if not isinstance(data, dict):
        raise ValueError(f"{path.name}: top-level JSON is not an object")
    return data


def dump_gzip_json(data: Dict[str, Any], level: int = 9) -> bytes:
    payload = json.dumps(data, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    return gzip.compress(payload, compresslevel=level)


def build_part_payload(base: Dict[str, Any], chunk_slice: List[Dict[str, Any]]) -> Dict[str, Any]:
    payload = copy.deepcopy(base)
    payload["chunks"] = chunk_slice

    doc_meta = payload.get("document_metadata")
    if isinstance(doc_meta, dict):
        doc_meta["chunk_count"] = len(chunk_slice)
    return payload


def best_chunk_window(
    base: Dict[str, Any],
    chunks: List[Dict[str, Any]],
    start: int,
    target_bytes: int,
) -> Tuple[int, bytes]:
    low = start + 1
    high = len(chunks)
    best_end = start + 1
    best_blob = dump_gzip_json(build_part_payload(base, chunks[start:best_end]))

    # If even one chunk is bigger than target, return it anyway to avoid deadlock.
    if len(best_blob) > target_bytes:
        return best_end, best_blob

    while low <= high:
        mid = (low + high) // 2
        blob = dump_gzip_json(build_part_payload(base, chunks[start:mid]))
        if len(blob) <= target_bytes:
            best_end = mid
            best_blob = blob
            low = mid + 1
        else:
            high = mid - 1

    return best_end, best_blob


def split_large_bin(
    source: Path,
    target_bytes: int,
    drop_ann_index: bool,
    single_only: bool,
    max_decompressed_bytes: int,
) -> Tuple[List[Path], int]:
    original_size = source.stat().st_size
    package = load_gzip_json(source)

    chunks = package.get("chunks")
    if not isinstance(chunks, list) or len(chunks) == 0:
        raise ValueError(f"{source.name}: missing or empty chunks array")

    # Keep original metadata, but optionally remove ANN for size stability.
    base = {k: v for k, v in package.items() if k != "chunks"}
    if drop_ann_index:
        base.pop("ann_index", None)

    # Try single-file rewrite first.
    single_payload = build_part_payload(base, chunks)
    single_json_bytes = json.dumps(
        single_payload, ensure_ascii=False, separators=(",", ":")
    ).encode("utf-8")
    single_blob = gzip.compress(single_json_bytes, compresslevel=9)
    single_decompressed_size = len(single_json_bytes)
    out_paths: List[Path] = []

    if single_only:
        if single_decompressed_size > max_decompressed_bytes:
            raise ValueError(
                f"{source.name}: single output is too large after decompression "
                f"({format_mb(single_decompressed_size)} > {format_mb(max_decompressed_bytes)}). "
                "Cannot keep single-file mode safely."
            )
        out_name = f"Small_{source.name}"
        out_path = source.parent / out_name
        out_path.write_bytes(single_blob)
        return [out_path], original_size

    if len(single_blob) <= target_bytes and single_decompressed_size <= max_decompressed_bytes:
        out_name = f"Small_{source.name}"
        out_path = source.parent / out_name
        out_path.write_bytes(single_blob)
        return [out_path], original_size

    # Need true splitting.
    blobs: List[bytes] = []
    windows: List[Tuple[int, int]] = []
    start = 0
    while start < len(chunks):
        end, blob = best_chunk_window(base, chunks, start, target_bytes)
        windows.append((start, end))
        blobs.append(blob)
        start = end

    part_count = len(blobs)
    stem = source.stem
    for idx, blob in enumerate(blobs, start=1):
        out_name = f"Small_{stem}_part{idx:02d}.bin"
        out_path = source.parent / out_name
        out_path.write_bytes(blob)
        out_paths.append(out_path)

    return out_paths, original_size


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Split oversized .bin shard files into smaller Small_*.bin files."
    )
    parser.add_argument(
        "directory",
        nargs="?",
        default=".",
        help="Directory to scan (default: current working directory)",
    )
    parser.add_argument(
        "--min-input-mb",
        type=float,
        default=60.0,
        help="Only process input .bin files larger than this size (default: 60)",
    )
    parser.add_argument(
        "--target-mb",
        type=float,
        default=60.0,
        help="Try to keep each output .bin at or below this size (default: 60)",
    )
    parser.add_argument(
        "--keep-ann",
        action="store_true",
        help="Keep ann_index in output (default: remove ann_index for smaller output)",
    )
    parser.add_argument(
        "--single-only",
        action="store_true",
        help="Only write single Small_<original>.bin files. Never write part files.",
    )
    parser.add_argument(
        "--max-decompressed-mb",
        type=float,
        default=510.0,
        help="Safety ceiling for decompressed JSON size per output file (default: 510)",
    )
    args = parser.parse_args()

    root = Path(args.directory).expanduser().resolve()
    if not root.is_dir():
        raise SystemExit(f"Directory not found: {root}")

    min_input_bytes = int(args.min_input_mb * MB)
    target_bytes = int(args.target_mb * MB)
    max_decompressed_bytes = int(args.max_decompressed_mb * MB)
    if target_bytes <= 0:
        raise SystemExit("--target-mb must be > 0")
    if max_decompressed_bytes <= 0:
        raise SystemExit("--max-decompressed-mb must be > 0")

    candidates = sorted(
        p for p in root.glob("*.bin")
        if p.is_file() and not p.name.startswith("Small_") and p.stat().st_size > min_input_bytes
    )

    if not candidates:
        print(f"No .bin files > {args.min_input_mb} MB found in: {root}")
        return

    print(f"Found {len(candidates)} oversized .bin file(s) in: {root}")
    print(f"Target output size: <= {args.target_mb} MB")
    print(f"ANN handling: {'keep ann_index' if args.keep_ann else 'drop ann_index'}")
    print(f"Mode: {'single-only' if args.single_only else 'allow split'}")
    print(f"Decompressed safety ceiling: <= {args.max_decompressed_mb} MB")

    for src in candidates:
        print(f"\nProcessing {src.name} ({format_mb(src.stat().st_size)})")
        try:
            outputs, original_size = split_large_bin(
                source=src,
                target_bytes=target_bytes,
                drop_ann_index=not args.keep_ann,
                single_only=args.single_only,
                max_decompressed_bytes=max_decompressed_bytes,
            )
        except Exception as exc:
            print(f"  FAILED: {exc}")
            continue

        total_out = sum(p.stat().st_size for p in outputs)
        print(f"  Created {len(outputs)} file(s):")
        for p in outputs:
            print(f"   - {p.name} ({format_mb(p.stat().st_size)})")
        ratio = (total_out / original_size) if original_size else 0
        print(f"  Total output size: {format_mb(total_out)} ({ratio:.2f}x of original)")

    print("\nDone.")


if __name__ == "__main__":
    main()
