#!/usr/bin/env python3
"""
One-shot pipeline (current directory by default):
1) Read all PDFs
2) Generate Voyage embeddings
3) Build ANN index
4) Embed ANN inline into package JSON (format_version 1.1)
5) Gzip JSON directly to shard_<random>.bin
6) Write file_mapping.json

Output:
- shard_<dld>.bin (e.g. shard_4a8.bin)
- file_mapping.json
"""

from __future__ import annotations

import argparse
import base64
import datetime
import gzip
import hashlib
import json
import os
import random
import string
import time
import uuid
from pathlib import Path
from typing import Any, Dict, List, Tuple

import fitz  # PyMuPDF
import numpy as np
import requests
from dotenv import load_dotenv

load_dotenv()

EMBEDDING_MODEL = "voyage-4-large"
VOYAGE_EMBEDDINGS_URL = "https://api.voyageai.com/v1/embeddings"

MAGIC = b"HNSWANN1"
VERSION = 1


def sha256_hex(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def format_bytes(num_bytes: int) -> str:
    units = ["B", "KB", "MB", "GB", "TB"]
    size = float(num_bytes)
    i = 0
    while size >= 1024 and i < len(units) - 1:
        size /= 1024
        i += 1
    return f"{int(size)} {units[i]}" if i == 0 else f"{size:.1f} {units[i]}"


def get_random_code(used: set[str]) -> str:
    while True:
        code = f"{random.choice(string.digits)}{random.choice(string.ascii_lowercase)}{random.choice(string.digits)}"
        if code not in used:
            used.add(code)
            return code


def get_api_key() -> str:
    env_key = os.getenv("VOYAGE_API_KEY", "").strip()
    if env_key:
        return env_key
    key = input("Please enter your Voyage API Key: ").strip()
    if not key:
        raise SystemExit("Error: API key cannot be empty.")
    return key


def extract_pages_from_pdf(pdf_path: Path) -> Tuple[List[Dict[str, Any]], int]:
    try:
        doc = fitz.open(pdf_path)
        pages: List[Dict[str, Any]] = []
        for i, page in enumerate(doc):
            text = page.get_text()
            if text and text.strip():
                pages.append({"text": text, "page_number": i + 1})
        return pages, len(doc)
    except Exception as e:
        print(f"Error reading {pdf_path.name}: {e}")
        return [], 0


def chunk_text_with_page_context(pages: List[Dict[str, Any]], chunk_size: int, overlap: int) -> List[Dict[str, Any]]:
    chunks: List[Dict[str, Any]] = []
    step = chunk_size - overlap
    if step <= 0:
        raise ValueError("chunk_size must be greater than chunk_overlap")

    for page in pages:
        text = page["text"]
        page_num = page["page_number"]
        start = 0
        while start < len(text):
            end = start + chunk_size
            chunk_text = text[start:end]
            if chunk_text.strip():
                chunks.append({"text": chunk_text, "page": page_num})
            if end >= len(text):
                break
            start += step
    return chunks


def get_batch_embeddings(texts: List[str], api_key: str, max_retries: int = 8) -> List[List[float]] | None:
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }
    payload = {"input": texts, "model": EMBEDDING_MODEL}

    for attempt in range(max_retries):
        try:
            response = requests.post(VOYAGE_EMBEDDINGS_URL, headers=headers, json=payload, timeout=60)

            if response.status_code == 429:
                wait_s = min(60, 2 ** attempt)
                print(f"Rate limited (429). Waiting {wait_s}s...")
                time.sleep(wait_s)
                continue

            if not response.ok:
                print(f"Embedding API error: {response.status_code} {response.text}")

            response.raise_for_status()
            result = response.json()
            data = result.get("data", [])

            if not isinstance(data, list) or len(data) != len(texts):
                return None

            data_sorted = sorted(data, key=lambda x: x.get("index", 0))
            embeddings = [item.get("embedding") for item in data_sorted]
            if any(e is None for e in embeddings):
                return None
            return embeddings  # type: ignore[return-value]

        except requests.RequestException as e:
            if attempt < max_retries - 1:
                wait_s = min(60, 2 ** attempt)
                print(f"Embedding request failed: {e}. Retrying in {wait_s}s...")
                time.sleep(wait_s)
                continue
            print(f"Embedding request failed permanently: {e}")
            return None

    return None


def chunked_knn_graph(vectors: np.ndarray, m: int, block_size: int = 512) -> np.ndarray:
    n, _ = vectors.shape
    neighbors = np.full((n, m), -1, dtype=np.int32)

    for start in range(0, n, block_size):
        end = min(start + block_size, n)
        block = vectors[start:end]
        sims = block @ vectors.T

        for r in range(end - start):
            sims[r, start + r] = -np.inf

        top_k = min(m, n - 1)
        if top_k <= 0:
            continue

        idx_part = np.argpartition(sims, -top_k, axis=1)[:, -top_k:]
        part_scores = np.take_along_axis(sims, idx_part, axis=1)
        order = np.argsort(part_scores, axis=1)[:, ::-1]
        sorted_idx = np.take_along_axis(idx_part, order, axis=1).astype(np.int32)
        neighbors[start:end, :top_k] = sorted_idx
        print(f"   [ANN] Graph rows {start}-{end}/{n}")

    return neighbors


def build_ann_binary(vectors: np.ndarray, neighbors: np.ndarray, entry: int, ef_search: int) -> Tuple[bytes, float]:
    n, dim = vectors.shape
    m = neighbors.shape[1]

    max_abs = float(np.max(np.abs(vectors)))
    scale = max(max_abs / 127.0, 1e-8)

    q_vectors = np.clip(np.rint(vectors / scale), -127, 127).astype(np.int8)
    norms = np.linalg.norm(vectors, axis=1).astype(np.float32)

    header = (
        MAGIC
        + VERSION.to_bytes(4, "little")
        + dim.to_bytes(4, "little")
        + n.to_bytes(4, "little")
        + m.to_bytes(4, "little")
        + entry.to_bytes(4, "little")
        + ef_search.to_bytes(4, "little")
        + np.float32(scale).tobytes()
    )

    payload = b"".join([
        header,
        q_vectors.tobytes(order="C"),
        norms.tobytes(order="C"),
        neighbors.astype(np.int32).tobytes(order="C"),
    ])
    return payload, scale


def verify_bin(bin_path: Path) -> None:
    raw = bin_path.read_bytes()
    text = gzip.decompress(raw).decode("utf-8")
    obj = json.loads(text)
    if not isinstance(obj, dict):
        raise ValueError("Decoded .bin JSON is not an object")
    if "format_version" not in obj or "chunks" not in obj:
        raise ValueError("Decoded .bin JSON does not look like a package")
    ann = obj.get("ann_index")
    if not isinstance(ann, dict):
        raise ValueError("ann_index missing in decoded package")
    if not isinstance(ann.get("artifact_base64"), str):
        raise ValueError("ann_index.artifact_base64 missing")
    if not isinstance(ann.get("id_map"), list):
        raise ValueError("ann_index.id_map missing")


def process_pdf(
    pdf_path: Path,
    api_key: str,
    used_codes: set[str],
    batch_session_id: str,
    batch_size: int,
    chunk_size: int,
    chunk_overlap: int,
    m: int,
    ef_construction: int,
    ef_search: int,
    block_size: int,
) -> Dict[str, Any] | None:
    pdf_filename = pdf_path.name
    print(f"\nProcessing: {pdf_filename}")

    file_stats = os.stat(pdf_path)
    file_size = file_stats.st_size
    created_at = datetime.datetime.fromtimestamp(file_stats.st_ctime).isoformat() + "Z"

    pages, total_pages = extract_pages_from_pdf(pdf_path)
    if not pages:
        print("   Skipped: no readable text pages.")
        return None

    raw_chunks = chunk_text_with_page_context(pages, chunk_size=chunk_size, overlap=chunk_overlap)
    print(f"   -> Split into {len(raw_chunks)} chunks")

    document_id = str(uuid.uuid4())
    processed_chunks: List[Dict[str, Any]] = []

    for i in range(0, len(raw_chunks), batch_size):
        batch_end = min(i + batch_size, len(raw_chunks))
        current_batch = raw_chunks[i:batch_end]

        print(f"   -> Embedding batch {i // batch_size + 1}: chunks {i + 1}-{batch_end}", end="\r", flush=True)
        texts = [c["text"] for c in current_batch]
        embeddings = get_batch_embeddings(texts, api_key)

        if embeddings and len(embeddings) == len(current_batch):
            for j, embedding in enumerate(embeddings):
                idx = i + j
                chunk_data = current_batch[j]
                processed_chunks.append({
                    "id": f"{document_id}_{idx}",
                    "text": chunk_data["text"],
                    "embedding": embedding,
                    "metadata": {
                        "page": chunk_data["page"],
                        "chunk_index": idx,
                        "document_id": document_id,
                        "source": pdf_filename,
                    },
                    "embedding_dimensions": len(embedding),
                })
        else:
            print(f"\n   Warning: failed embedding batch for {i + 1}-{batch_end}")

        time.sleep(1)
    print("")

    if not processed_chunks:
        print("   Skipped: no embeddings generated.")
        return None

    emb = np.asarray([c["embedding"] for c in processed_chunks], dtype=np.float32)
    if emb.ndim != 2:
        print("   Skipped: invalid embedding matrix.")
        return None

    n, dim = emb.shape
    print(f"   -> Building ANN graph for {n} vectors (dim={dim})")
    norms = np.linalg.norm(emb, axis=1, keepdims=True)
    norms[norms == 0] = 1.0
    emb = emb / norms

    m = max(4, int(m))
    neighbors = chunked_knn_graph(emb, m=m, block_size=max(64, int(block_size)))
    ann_binary, scale = build_ann_binary(emb, neighbors, entry=0, ef_search=max(16, int(ef_search)))

    ann_checksum = sha256_hex(ann_binary)
    id_map = [c["id"] for c in processed_chunks]
    id_map_json = json.dumps(id_map, ensure_ascii=False).encode("utf-8")
    idmap_checksum = sha256_hex(id_map_json)

    now = datetime.datetime.now(datetime.timezone.utc).isoformat().replace("+00:00", "Z")
    package_data: Dict[str, Any] = {
        "format_version": "1.1",
        "export_metadata": {
            "exported_at": now,
            "source_system": "LocalDocs AI",
            "document_id": document_id,
            "session_id": batch_session_id,
        },
        "document_metadata": {
            "id": document_id,
            "filename": pdf_filename,
            "file_size": file_size,
            "page_count": total_pages,
            "processed_at": now,
            "created_at": created_at,
            "chunk_count": len(processed_chunks),
            "embedding_model": EMBEDDING_MODEL,
            "chunk_settings": {
                "chunk_size": chunk_size,
                "chunk_overlap": chunk_overlap,
            },
        },
        "chunks": processed_chunks,
        "ann_index": {
            "algorithm": "hnsw",
            "embedding_dimensions": int(dim),
            "distance": "cosine",
            "params": {
                "m": m,
                "ef_construction": int(ef_construction),
                "ef_search": int(ef_search),
            },
            "artifact_checksum": ann_checksum,
            "artifact_size": len(ann_binary),
            "id_map_checksum": idmap_checksum,
            "id_map_size": len(id_map_json),
            "artifact_base64": base64.b64encode(ann_binary).decode("ascii"),
            "id_map": id_map,
        },
    }

    shard_code = get_random_code(used_codes)
    shard_name = f"shard_{shard_code}.bin"
    shard_path = pdf_path.parent / shard_name

    json_bytes = json.dumps(package_data, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    gz_bytes = gzip.compress(json_bytes, compresslevel=9)
    shard_path.write_bytes(gz_bytes)

    verify_bin(shard_path)

    print(f"   -> Output: {shard_name} ({format_bytes(shard_path.stat().st_size)})")
    print(f"   -> ANN scale: {scale}")

    return {
        "pdf": pdf_filename,
        "document_id": document_id,
        "chunk_count": len(processed_chunks),
        "embedding_dimensions": int(dim),
        "shard": shard_name,
        "size_bytes": shard_path.stat().st_size,
        "size_human": format_bytes(shard_path.stat().st_size),
        "sha256": sha256_hex(gz_bytes),
    }


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Process all PDFs in current directory into shard_*.bin with inline ANN."
    )
    parser.add_argument("directory", nargs="?", default=".", help="Target directory (default: current directory)")
    parser.add_argument("--batch-size", type=int, default=100)
    parser.add_argument("--chunk-size", type=int, default=1000)
    parser.add_argument("--chunk-overlap", type=int, default=200)
    parser.add_argument("--m", type=int, default=24)
    parser.add_argument("--ef-construction", type=int, default=128)
    parser.add_argument("--ef-search", type=int, default=80)
    parser.add_argument("--block-size", type=int, default=512)
    parser.add_argument("--mapping-file", default="file_mapping.json")
    args = parser.parse_args()

    target_dir = Path(args.directory).expanduser().resolve()
    if not target_dir.is_dir():
        raise SystemExit(f"Error: directory does not exist: {target_dir}")

    pdfs = sorted(target_dir.glob("*.pdf"))
    if not pdfs:
        raise SystemExit(f"No PDF files found in: {target_dir}")

    print(f"Found {len(pdfs)} PDF file(s) in: {target_dir}")
    api_key = get_api_key()
    batch_session_id = str(uuid.uuid4())
    used_codes: set[str] = set()

    mapping: Dict[str, Any] = {
        "generated_at": datetime.datetime.now(datetime.timezone.utc).isoformat().replace("+00:00", "Z"),
        "directory": str(target_dir),
        "files": [],
    }

    for pdf in pdfs:
        try:
            result = process_pdf(
                pdf_path=pdf,
                api_key=api_key,
                used_codes=used_codes,
                batch_session_id=batch_session_id,
                batch_size=args.batch_size,
                chunk_size=args.chunk_size,
                chunk_overlap=args.chunk_overlap,
                m=args.m,
                ef_construction=args.ef_construction,
                ef_search=args.ef_search,
                block_size=args.block_size,
            )
            if result:
                mapping["files"].append(result)
        except Exception as e:
            print(f"   Failed for {pdf.name}: {e}")
            mapping["files"].append({
                "pdf": pdf.name,
                "error": str(e),
            })

    mapping_path = target_dir / args.mapping_file
    with mapping_path.open("w", encoding="utf-8") as f:
        json.dump(mapping, f, indent=2, ensure_ascii=False)

    print(f"\nDone. Mapping saved to: {mapping_path}")


if __name__ == "__main__":
    main()

