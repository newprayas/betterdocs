#!/usr/bin/env python3
"""
One-shot pipeline:
1) Read all PDFs from a directory
2) Generate Voyage embeddings
3) Build ANN (HNSW-like k-NN graph artifact)
4) Write a single JSON package with inline ANN payload (format_version 1.1)

Outputs (same folder as PDF):
- <pdf>.pdf_processed_export.ann.ready.json   (inline ANN by default)
- <pdf>.pdf_processed_export.ann.bin          (always emitted)
- <pdf>.pdf_processed_export.ann.idmap.json.gz (always emitted)
"""

from __future__ import annotations

import argparse
import base64
import datetime
import gzip
import hashlib
import json
import os
import time
import uuid
from pathlib import Path
from typing import Dict, List, Tuple

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


def get_api_key() -> str:
    api_key = input("Please enter your Voyage API Key: ").strip()
    if not api_key:
        raise SystemExit("Error: API Key cannot be empty.")
    return api_key


def extract_pages_from_pdf(pdf_path: Path) -> Tuple[List[Dict], int]:
    try:
        doc = fitz.open(pdf_path)
        pages: List[Dict] = []
        for i, page in enumerate(doc):
            text = page.get_text()
            if text.strip():
                pages.append({"text": text, "page_number": i + 1})
        return pages, len(doc)
    except Exception as e:
        print(f"Error reading {pdf_path.name}: {e}")
        return [], 0


def chunk_text_with_page_context(pages: List[Dict], chunk_size: int = 1000, overlap: int = 200) -> List[Dict]:
    chunks: List[Dict] = []
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
            start += (chunk_size - overlap)
    return chunks


def get_batch_embeddings(texts: List[str], api_key: str, max_retries: int = 8) -> List[List[float]] | None:
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }
    payload = {"input": texts, "model": EMBEDDING_MODEL}

    for attempt in range(max_retries):
        try:
            response = requests.post(
                VOYAGE_EMBEDDINGS_URL,
                headers=headers,
                json=payload,
                timeout=60,
            )

            if response.status_code == 429:
                wait_s = min(60, 2 ** attempt)
                print(f"\nRate limited (429). Waiting {wait_s}s before retrying...")
                time.sleep(wait_s)
                continue

            if not response.ok:
                print(f"\nError details: {response.text}")
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
                print(f"\nError generating batch embedding: {e}\nRetrying in {wait_s}s...")
                time.sleep(wait_s)
                continue
            print(f"\nError generating batch embedding: {e}")
            return None

    return None


def chunked_knn_graph(vectors: np.ndarray, m: int, block_size: int = 512) -> np.ndarray:
    n, _ = vectors.shape
    neighbors = np.full((n, m), -1, dtype=np.int32)

    for start in range(0, n, block_size):
        end = min(start + block_size, n)
        block = vectors[start:end]
        sims = block @ vectors.T

        row_count = end - start
        for r in range(row_count):
            sims[r, start + r] = -np.inf

        top_k = min(m, n - 1)
        if top_k <= 0:
            continue

        idx_part = np.argpartition(sims, -top_k, axis=1)[:, -top_k:]
        part_scores = np.take_along_axis(sims, idx_part, axis=1)
        order = np.argsort(part_scores, axis=1)[:, ::-1]
        sorted_idx = np.take_along_axis(idx_part, order, axis=1).astype(np.int32)
        neighbors[start:end, :top_k] = sorted_idx
        print(f"   [ANN] Graph rows {start}-{end} / {n}")

    return neighbors


def build_ann_binary(vectors: np.ndarray, neighbors: np.ndarray, entry: int, ef_search: int) -> Tuple[bytes, float]:
    n, dim = vectors.shape
    m = neighbors.shape[1]

    max_abs = float(np.max(np.abs(vectors)))
    scale = max(max_abs / 127.0, 1e-8)
    q_vectors = np.clip(np.rint(vectors / scale), -127, 127).astype(np.int8)
    norms = np.linalg.norm(vectors, axis=1).astype(np.float32)

    header = np.frombuffer(
        (
            MAGIC
            + VERSION.to_bytes(4, "little")
            + dim.to_bytes(4, "little")
            + n.to_bytes(4, "little")
            + m.to_bytes(4, "little")
            + entry.to_bytes(4, "little")
            + ef_search.to_bytes(4, "little")
            + np.float32(scale).tobytes()
        ),
        dtype=np.uint8,
    ).tobytes()

    payload = b"".join(
        [
            header,
            q_vectors.tobytes(order="C"),
            norms.tobytes(order="C"),
            neighbors.astype(np.int32).tobytes(order="C"),
        ]
    )
    return payload, scale


def process_pdfs() -> None:
    parser = argparse.ArgumentParser(description="Process PDFs: Voyage embeddings + inline ANN package.")
    parser.add_argument("directory", nargs="?", default=".", help="Target directory containing PDF files")
    parser.add_argument("--batch-size", type=int, default=100, help="Embedding batch size (default: 100)")
    parser.add_argument("--chunk-size", type=int, default=1000, help="Chunk size (default: 1000)")
    parser.add_argument("--chunk-overlap", type=int, default=200, help="Chunk overlap (default: 200)")
    parser.add_argument("--m", type=int, default=24, help="ANN graph out-degree (default: 24)")
    parser.add_argument("--ef-construction", type=int, default=128, help="ANN ef_construction metadata (default: 128)")
    parser.add_argument("--ef-search", type=int, default=80, help="ANN ef_search metadata/runtime default (default: 80)")
    parser.add_argument("--block-size", type=int, default=512, help="ANN graph build block size (default: 512)")
    parser.add_argument("--no-inline", action="store_true", help="Disable inline ANN payload in output JSON")
    args = parser.parse_args()

    target_dir = Path(args.directory).expanduser().resolve()
    if not target_dir.is_dir():
        raise SystemExit(f"Error: Directory '{target_dir}' does not exist.")

    pdf_files = sorted(target_dir.glob("*.pdf"))
    if not pdf_files:
        raise SystemExit(f"No PDF files found in: {target_dir}")

    print(f"Found {len(pdf_files)} PDF file(s) in '{target_dir}'.")
    voyage_api_key = get_api_key()
    batch_session_id = str(uuid.uuid4())
    inline_ann = not args.no_inline

    for pdf_file_path in pdf_files:
        pdf_filename = pdf_file_path.name
        print(f"\nProcessing: {pdf_filename}")

        file_stats = os.stat(pdf_file_path)
        file_size = file_stats.st_size
        created_at = datetime.datetime.fromtimestamp(file_stats.st_ctime).isoformat() + "Z"

        pages, total_pages = extract_pages_from_pdf(pdf_file_path)
        if not pages:
            print("   Skipped: no readable text pages.")
            continue

        raw_chunks = chunk_text_with_page_context(
            pages,
            chunk_size=args.chunk_size,
            overlap=args.chunk_overlap,
        )
        print(f"   -> Split into {len(raw_chunks)} chunk(s).")

        processed_chunks: List[Dict] = []
        document_id = str(uuid.uuid4())

        total_chunks = len(raw_chunks)
        for i in range(0, total_chunks, args.batch_size):
            batch_end = min(i + args.batch_size, total_chunks)
            current_batch = raw_chunks[i:batch_end]

            print(
                f"   -> Embedding batch {i // args.batch_size + 1}: chunks {i + 1}-{batch_end}",
                end="\r",
                flush=True,
            )

            batch_texts = [c["text"] for c in current_batch]
            batch_embeddings = get_batch_embeddings(batch_texts, voyage_api_key)
            if batch_embeddings and len(batch_embeddings) == len(current_batch):
                for j, embedding in enumerate(batch_embeddings):
                    chunk_data = current_batch[j]
                    global_index = i + j
                    processed_chunks.append(
                        {
                            "id": f"{document_id}_{global_index}",
                            "text": chunk_data["text"],
                            "embedding": embedding,
                            "metadata": {
                                "page": chunk_data["page"],
                                "chunk_index": global_index,
                                "document_id": document_id,
                                "source": pdf_filename,
                            },
                            "embedding_dimensions": len(embedding),
                        }
                    )
            else:
                print(f"\n   Warning: failed embedding batch for chunks {i + 1}-{batch_end}")
            time.sleep(1)
        print("")

        if not processed_chunks:
            print("   Skipped: no embeddings generated.")
            continue

        embeddings = np.asarray([c["embedding"] for c in processed_chunks], dtype=np.float32)
        if embeddings.ndim != 2:
            print("   Skipped: embedding matrix invalid.")
            continue

        n, dim = embeddings.shape
        print(f"   -> Building ANN graph for {n} vectors (dim={dim})")
        norms = np.linalg.norm(embeddings, axis=1, keepdims=True)
        norms[norms == 0] = 1.0
        embeddings = embeddings / norms

        m = max(4, int(args.m))
        neighbors = chunked_knn_graph(embeddings, m=m, block_size=max(64, int(args.block_size)))
        ann_binary, scale = build_ann_binary(
            embeddings,
            neighbors,
            entry=0,
            ef_search=max(16, int(args.ef_search)),
        )

        base_name = f"{pdf_filename}_processed_export"
        ann_name = f"{base_name}.ann.bin"
        idmap_name = f"{base_name}.ann.idmap.json.gz"
        output_json_name = f"{base_name}.ann.ready.json"

        ann_path = target_dir / ann_name
        idmap_path = target_dir / idmap_name
        output_json_path = target_dir / output_json_name

        ann_path.write_bytes(ann_binary)
        id_map = [c["id"] for c in processed_chunks]
        with gzip.open(idmap_path, "wt", encoding="utf-8") as f:
            json.dump(id_map, f, ensure_ascii=False)

        ann_checksum = sha256_hex(ann_binary)
        idmap_bytes = idmap_path.read_bytes()
        idmap_checksum = sha256_hex(idmap_bytes)

        current_time = datetime.datetime.now(datetime.timezone.utc).isoformat().replace("+00:00", "Z")
        output_data: Dict = {
            "format_version": "1.1",
            "export_metadata": {
                "exported_at": current_time,
                "source_system": "LocalDocs AI",
                "document_id": document_id,
                "session_id": batch_session_id,
            },
            "document_metadata": {
                "id": document_id,
                "filename": pdf_filename,
                "file_size": file_size,
                "page_count": total_pages,
                "processed_at": current_time,
                "created_at": created_at,
                "chunk_count": len(processed_chunks),
                "embedding_model": EMBEDDING_MODEL,
                "chunk_settings": {
                    "chunk_size": args.chunk_size,
                    "chunk_overlap": args.chunk_overlap,
                },
            },
            "chunks": processed_chunks,
            "ann_index": {
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
                "artifact_size": len(ann_binary),
                "id_map_name": idmap_name,
                "id_map_checksum": idmap_checksum,
                "id_map_size": len(idmap_bytes),
            },
        }

        if inline_ann:
            output_data["ann_index"]["artifact_base64"] = base64.b64encode(ann_binary).decode("ascii")
            output_data["ann_index"]["id_map"] = id_map

        with output_json_path.open("w", encoding="utf-8") as f:
            json.dump(output_data, f, ensure_ascii=False)

        print("   Done")
        print(f"   -> JSON package: {output_json_path}")
        print(f"   -> ANN binary  : {ann_path}")
        print(f"   -> ID map      : {idmap_path}")
        print(f"   -> Scale       : {scale}")

    print("\nAll done.")


if __name__ == "__main__":
    process_pdfs()
