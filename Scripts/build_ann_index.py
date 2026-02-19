#!/usr/bin/env python3
"""
Builds a precomputed on-device ANN artifact from a preprocessed package JSON.

Outputs:
- <base>.ann.bin            : ANN graph + quantized vectors (custom binary format)
- <base>.ann.idmap.json.gz  : Chunk ID map in node order
- <base>.ann.ready.json     : Updated package JSON with format_version 1.1 + ann_index metadata

Binary layout (little-endian):
- magic[8]      = b"HNSWANN1"
- version u32   = 1
- dim u32
- node_count u32
- m u32
- entry u32
- ef_search u32
- scale f32
- vectors int8[node_count * dim]
- norms float32[node_count]
- neighbors int32[node_count * m]  (-1 means empty)
"""

from __future__ import annotations

import argparse
import base64
import gzip
import hashlib
import json
import os
import glob
import struct
from pathlib import Path
from typing import Any, Dict, List, Tuple

import numpy as np

MAGIC = b"HNSWANN1"
VERSION = 1


def sha256_hex(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def chunked_knn_graph(vectors: np.ndarray, m: int, block_size: int = 512) -> np.ndarray:
    """
    Build a k-NN graph using exact cosine similarities in blocks.
    vectors must be L2 normalized float32 [N, D].
    Returns int32 neighbors [N, m].
    """
    n, _ = vectors.shape
    neighbors = np.full((n, m), -1, dtype=np.int32)

    for start in range(0, n, block_size):
        end = min(start + block_size, n)
        block = vectors[start:end]  # [B, D]
        sims = block @ vectors.T    # [B, N]

        row_count = end - start
        for r in range(row_count):
            global_idx = start + r
            sims[r, global_idx] = -np.inf  # exclude self

        top_k = min(m, n - 1)
        if top_k <= 0:
            continue

        idx_part = np.argpartition(sims, -top_k, axis=1)[:, -top_k:]
        part_scores = np.take_along_axis(sims, idx_part, axis=1)
        order = np.argsort(part_scores, axis=1)[:, ::-1]
        sorted_idx = np.take_along_axis(idx_part, order, axis=1).astype(np.int32)

        neighbors[start:end, :top_k] = sorted_idx
        print(f"[ANN] Graph rows {start}-{end} / {n}")

    return neighbors


def build_binary(
    vectors: np.ndarray,
    neighbors: np.ndarray,
    entry: int,
    ef_search: int,
) -> Tuple[bytes, float]:
    n, dim = vectors.shape
    m = neighbors.shape[1]

    max_abs = float(np.max(np.abs(vectors)))
    scale = max(max_abs / 127.0, 1e-8)
    q_vectors = np.clip(np.rint(vectors / scale), -127, 127).astype(np.int8)
    norms = np.linalg.norm(vectors, axis=1).astype(np.float32)

    header = struct.pack(
        "<8sIIIIIIf",
        MAGIC,
        VERSION,
        dim,
        n,
        m,
        entry,
        ef_search,
        scale,
    )

    payload = b"".join(
        [
            header,
            q_vectors.tobytes(order="C"),
            norms.tobytes(order="C"),
            neighbors.astype(np.int32).tobytes(order="C"),
        ]
    )
    return payload, scale


def load_package(path: Path) -> Dict[str, Any]:
    with path.open("r", encoding="utf-8") as f:
        return json.load(f)


def discover_packages_from_pdfs(target_dir: Path) -> List[Path]:
    pdf_files = [Path(p) for p in sorted(glob.glob(str(target_dir / "*.pdf")))]
    if not pdf_files:
        raise SystemExit(f"No PDF files found in: {target_dir}")

    package_files: List[Path] = []
    missing: List[str] = []

    for pdf_path in pdf_files:
        expected_json = target_dir / f"{pdf_path.name}_processed_export.json"
        if expected_json.exists():
            package_files.append(expected_json)
        else:
            missing.append(expected_json.name)

    if missing:
        print("[ANN] Warning: Missing processed export JSON for some PDFs:")
        for name in missing:
            print(f"  - {name}")

    if not package_files:
        raise SystemExit(
            "Found PDF files, but no matching '*_processed_export.json' files. "
            "Run your embedding export script first."
        )

    return package_files


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Build ANN artifacts. With no input path, scans current directory PDFs and processes matching *_processed_export.json files."
    )
    parser.add_argument(
        "input_path",
        nargs="?",
        default=None,
        help="Optional: package JSON file or directory with *_processed_export.json files. Omit to auto-scan current directory by PDF names.",
    )
    parser.add_argument("--m", type=int, default=24, help="Graph out-degree (default: 24)")
    parser.add_argument("--ef-construction", type=int, default=128, help="Construction param metadata (default: 128)")
    parser.add_argument("--ef-search", type=int, default=80, help="Search beam width metadata/runtime default (default: 80)")
    parser.add_argument("--block-size", type=int, default=512, help="Matrix block size for graph build")
    parser.add_argument("--inline", action="store_true", default=True, help="Embed artifact_base64 and id_map directly into output JSON (default: enabled)")
    parser.add_argument("--no-inline", action="store_true", help="Disable inline payload and keep external artifact references only")
    parser.add_argument("--output-json", default="", help="Optional output JSON path")
    args = parser.parse_args()

    package_files: List[Path] = []
    inline_mode = args.inline and not args.no_inline

    if args.input_path is None:
        # Auto mode: find PDFs in current directory and use matching processed export JSON files.
        cwd = Path.cwd().resolve()
        if args.output_json:
            raise SystemExit("--output-json cannot be used in auto mode (multiple files may be processed)")
        package_files = discover_packages_from_pdfs(cwd)
    else:
        input_path = Path(args.input_path).expanduser().resolve()
        if not input_path.exists():
            raise SystemExit(f"Input path not found: {input_path}")
        if input_path.is_file():
            package_files = [input_path]
        else:
            if args.output_json:
                raise SystemExit("--output-json can only be used when input_path is a single file")
            pattern = str(input_path / "*_processed_export.json")
            package_files = [Path(p) for p in sorted(glob.glob(pattern))]

    if not package_files:
        if args.input_path is None:
            raise SystemExit("No package files found to process in current directory")
        raise SystemExit(f"No *_processed_export.json files found in: {Path(args.input_path).expanduser().resolve()}")

    print(f"[ANN] Found {len(package_files)} package file(s) to process")

    for package_path in package_files:
        print(f"\n[ANN] Processing: {package_path}")

        package = load_package(package_path)
        chunks = package.get("chunks", [])
        if not isinstance(chunks, list) or not chunks:
            print(f"[ANN] Skipping {package_path.name}: package has no chunks")
            continue

        embeddings = []
        id_map = []
        invalid = False
        for chunk in chunks:
            emb = chunk.get("embedding")
            cid = chunk.get("id")
            if not isinstance(emb, list) or not emb:
                print(f"[ANN] Skipping {package_path.name}: invalid chunk embedding payload")
                invalid = True
                break
            if not isinstance(cid, str):
                print(f"[ANN] Skipping {package_path.name}: invalid chunk id")
                invalid = True
                break
            embeddings.append(emb)
            id_map.append(cid)

        if invalid:
            continue

        vectors = np.asarray(embeddings, dtype=np.float32)
        if vectors.ndim != 2:
            print(f"[ANN] Skipping {package_path.name}: embeddings must be a 2D matrix")
            continue

        n, dim = vectors.shape
        print(f"[ANN] Loaded {n} vectors, dim={dim}")

        # Normalize for cosine graph construction.
        norms = np.linalg.norm(vectors, axis=1, keepdims=True)
        norms[norms == 0] = 1.0
        vectors = vectors / norms

        m = max(4, int(args.m))
        neighbors = chunked_knn_graph(vectors, m=m, block_size=max(64, int(args.block_size)))

        entry = 0
        binary, scale = build_binary(vectors, neighbors, entry=entry, ef_search=max(16, int(args.ef_search)))

        base_name = package_path.stem.replace(".json", "")
        out_dir = package_path.parent
        ann_name = f"{base_name}.ann.bin"
        idmap_name = f"{base_name}.ann.idmap.json.gz"
        out_json_name = f"{base_name}.ann.ready.json"

        ann_path = out_dir / ann_name
        idmap_path = out_dir / idmap_name
        out_json_path = Path(args.output_json).expanduser().resolve() if args.output_json else (out_dir / out_json_name)

        ann_path.write_bytes(binary)
        with gzip.open(idmap_path, "wt", encoding="utf-8") as f:
            json.dump(id_map, f, ensure_ascii=False)

        ann_checksum = sha256_hex(binary)
        idmap_bytes = idmap_path.read_bytes()
        idmap_checksum = sha256_hex(idmap_bytes)

        package["format_version"] = "1.1"
        package["ann_index"] = {
            "algorithm": "hnsw",
            "embedding_dimensions": int(dim),
            "distance": "cosine",
            "params": {
                "m": m,
                "ef_construction": int(args.ef_construction),
                "ef_search": int(args.ef_search),
            },
            "artifact_name": ann_name,
            "artifact_checksum": ann_checksum,
            "artifact_size": len(binary),
            "id_map_name": idmap_name,
            "id_map_checksum": idmap_checksum,
            "id_map_size": len(idmap_bytes),
        }

        if inline_mode:
            package["ann_index"]["artifact_base64"] = base64.b64encode(binary).decode("ascii")
            package["ann_index"]["id_map"] = id_map

        with out_json_path.open("w", encoding="utf-8") as f:
            json.dump(package, f, ensure_ascii=False)

        print("[ANN] Done")
        print(f"  ANN binary : {ann_path}")
        print(f"  ID map     : {idmap_path}")
        print(f"  Package    : {out_json_path}")
        print(f"  Scale      : {scale}")
        print(f"  Checksum   : {ann_checksum}")


if __name__ == "__main__":
    main()
