#!/usr/bin/env python3
"""
Build one routing .bin from existing shard_*.bin files (no re-embedding, no API calls).

Input:
- All *.bin files in current directory (or optional directory arg)

Output:
- routing_index_all.bin (gzipped JSON)
  Contains per-book vectors + per-section vectors + page/chunk mapping.
"""

from __future__ import annotations

import argparse
import datetime as dt
import gzip
import json
import math
from pathlib import Path
from typing import Any, Dict, List, Optional

import numpy as np


def l2_normalize(vec: np.ndarray) -> Optional[np.ndarray]:
    norm = float(np.linalg.norm(vec))
    if norm <= 0.0 or not np.isfinite(norm):
        return None
    return vec / norm


def read_package_bin(path: Path) -> Optional[Dict[str, Any]]:
    try:
        raw = path.read_bytes()
        text = gzip.decompress(raw).decode("utf-8")
        obj = json.loads(text)
        if not isinstance(obj, dict):
            return None
        if "chunks" not in obj or not isinstance(obj["chunks"], list):
            return None
        return obj
    except Exception:
        return None


def to_int_page(v: Any, default: int = 1) -> int:
    try:
        p = int(v)
        return p if p > 0 else default
    except Exception:
        return default


def main() -> None:
    parser = argparse.ArgumentParser(description="Create routing_index_all.bin from existing .bin shards")
    parser.add_argument("directory", nargs="?", default=".", help="Directory containing .bin files (default: current dir)")
    parser.add_argument("--section-pages", type=int, default=20, help="Pages per section bucket (default: 20)")
    parser.add_argument("--min-chunks-per-section", type=int, default=1, help="Minimum chunks to keep a section (default: 1)")
    parser.add_argument("--output", default="routing_index_all.bin", help="Output routing .bin filename")
    args = parser.parse_args()

    target_dir = Path(args.directory).expanduser().resolve()
    if not target_dir.is_dir():
        raise SystemExit(f"Directory not found: {target_dir}")

    section_pages = max(1, int(args.section_pages))
    min_chunks = max(1, int(args.min_chunks_per_section))

    bin_files = sorted(target_dir.glob("*.bin"))
    if not bin_files:
        raise SystemExit(f"No .bin files found in {target_dir}")

    books_out: List[Dict[str, Any]] = []
    skipped: List[str] = []

    for bin_path in bin_files:
        pkg = read_package_bin(bin_path)
        if not pkg:
            skipped.append(f"{bin_path.name} (not a supported package .bin)")
            continue

        chunks = pkg.get("chunks", [])
        if not chunks:
            skipped.append(f"{bin_path.name} (no chunks)")
            continue

        doc_meta = pkg.get("document_metadata", {}) if isinstance(pkg.get("document_metadata"), dict) else {}
        book_id = str(doc_meta.get("id") or bin_path.stem)
        book_name = str(doc_meta.get("filename") or bin_path.name)

        book_dim: Optional[int] = None
        book_sum: Optional[np.ndarray] = None
        book_count = 0
        max_page_seen = 1

        # section_idx -> stats
        section_stats: Dict[int, Dict[str, Any]] = {}

        for ch in chunks:
            if not isinstance(ch, dict):
                continue

            emb = ch.get("embedding")
            if not isinstance(emb, list) or len(emb) == 0:
                continue

            try:
                v = np.asarray(emb, dtype=np.float32)
            except Exception:
                continue

            if v.ndim != 1:
                continue

            if book_dim is None:
                book_dim = int(v.shape[0])
                book_sum = np.zeros(book_dim, dtype=np.float64)
            elif int(v.shape[0]) != book_dim:
                continue

            nv = l2_normalize(v)
            if nv is None:
                continue

            assert book_sum is not None
            book_sum += nv.astype(np.float64)
            book_count += 1

            meta = ch.get("metadata", {}) if isinstance(ch.get("metadata"), dict) else {}
            page = to_int_page(meta.get("page"), default=1)
            max_page_seen = max(max_page_seen, page)

            sec_idx = (page - 1) // section_pages
            sec = section_stats.get(sec_idx)
            if sec is None:
                sec = {
                    "sum": np.zeros(book_dim, dtype=np.float64),
                    "count": 0,
                    "page_start": sec_idx * section_pages + 1,
                    "page_end": (sec_idx + 1) * section_pages,
                    "chunk_ids": [],
                }
                section_stats[sec_idx] = sec

            sec["sum"] += nv.astype(np.float64)
            sec["count"] += 1
            chunk_id = ch.get("id")
            if isinstance(chunk_id, str):
                sec["chunk_ids"].append(chunk_id)

        if book_count == 0 or book_sum is None or book_dim is None:
            skipped.append(f"{bin_path.name} (no usable embeddings)")
            continue

        book_vec = book_sum / float(book_count)
        book_vec = l2_normalize(book_vec.astype(np.float32))
        if book_vec is None:
            skipped.append(f"{bin_path.name} (invalid book vector)")
            continue

        sections_out: List[Dict[str, Any]] = []
        for sec_idx in sorted(section_stats.keys()):
            sec = section_stats[sec_idx]
            if sec["count"] < min_chunks:
                continue

            sec_vec = sec["sum"] / float(sec["count"])
            sec_vec = l2_normalize(sec_vec.astype(np.float32))
            if sec_vec is None:
                continue

            sections_out.append({
                "section_id": f"{book_id}_sec_{sec_idx:04d}",
                "title": f"Pages {sec['page_start']}-{sec['page_end']}",
                "page_start": sec["page_start"],
                "page_end": sec["page_end"],
                "chunk_count": sec["count"],
                "chunk_ids": sec["chunk_ids"],
                "vector": sec_vec.tolist(),
            })

        books_out.append({
            "book_id": book_id,
            "book_name": book_name,
            "source_bin": bin_path.name,
            "embedding_dimensions": book_dim,
            "chunk_count": book_count,
            "page_count": int(doc_meta.get("page_count") or max_page_seen),
            "book_vector": book_vec.tolist(),
            "sections": sections_out,
        })

        print(f"Processed {bin_path.name}: chunks={book_count}, sections={len(sections_out)}, dim={book_dim}")

    out_obj = {
        "format_version": "route-1.0",
        "generated_at": dt.datetime.now(dt.timezone.utc).isoformat().replace("+00:00", "Z"),
        "source_directory": str(target_dir),
        "section_pages": section_pages,
        "books_count": len(books_out),
        "books": books_out,
        "skipped": skipped,
    }

    out_path = target_dir / args.output
    out_bytes = json.dumps(out_obj, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    out_path.write_bytes(gzip.compress(out_bytes, compresslevel=9))

    print(f"\nDone: {out_path.name}")
    print(f"Books in routing file: {len(books_out)}")
    if skipped:
        print("Skipped:")
        for s in skipped:
            print(f" - {s}")


if __name__ == "__main__":
    main()
