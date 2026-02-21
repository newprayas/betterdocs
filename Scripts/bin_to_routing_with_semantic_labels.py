#!/usr/bin/env python3
"""
Build routing companion .bin files from existing shard .bin files.

What it does:
1) Reads every .bin in the target directory (default: current directory)
2) Uses existing chunk embeddings to build:
   - one book vector per book
   - one section vector per page bucket (chapter-like section)
3) Optionally adds semantic section labels using a small number of Voyage embedding calls
4) Writes one companion file per source:
   - <source_stem>_comp.bin

No re-embedding of chunks is performed.
"""

from __future__ import annotations

import argparse
import datetime as dt
import gzip
import json
import os
import re
import time
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import numpy as np
import requests
from dotenv import load_dotenv

load_dotenv()

VOYAGE_EMBEDDINGS_URL = "https://api.voyageai.com/v1/embeddings"
VOYAGE_MODEL = "voyage-4-large"

DEFAULT_LABELS = [
    "General Surgery",
    "Trauma and Emergency",
    "Gastrointestinal Surgery",
    "Hepatobiliary and Pancreas",
    "Colorectal Surgery",
    "Breast Surgery",
    "Endocrine Surgery",
    "Vascular Surgery",
    "Cardiothoracic Surgery",
    "Neurosurgery",
    "Orthopedics",
    "Urology",
    "ENT",
    "Ophthalmology",
    "Obstetrics and Gynecology",
    "Pediatrics",
    "Internal Medicine",
    "Cardiology",
    "Respiratory Medicine",
    "Nephrology",
    "Gastroenterology",
    "Neurology",
    "Infectious Disease",
    "Dermatology",
    "Radiology",
    "Pathology",
    "Pharmacology",
    "Physiology",
    "Anatomy",
    "Exam and Viva Preparation",
]


def get_api_key(prompt_if_missing: bool = False) -> str:
    key = os.getenv("VOYAGE_API_KEY", "").strip()
    if key:
        return key
    if prompt_if_missing:
        key = input("Enter Voyage API key: ").strip()
        if key:
            return key
    raise SystemExit("Voyage API key not provided.")


def prompt_yes_no(question: str, default_no: bool = True) -> bool:
    suffix = " [y/N]: " if default_no else " [Y/n]: "
    reply = input(question + suffix).strip().lower()
    if not reply:
        return not default_no
    return reply in {"y", "yes"}


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
    except Exception:
        return None

    if not isinstance(obj, dict):
        return None
    if "chunks" not in obj or not isinstance(obj["chunks"], list):
        return None
    return obj


def to_int_page(value: Any, default: int = 1) -> int:
    try:
        page = int(value)
        return page if page > 0 else default
    except Exception:
        return default


def compact_text(text: str, limit: int = 500) -> str:
    if not text:
        return ""
    cleaned = re.sub(r"\s+", " ", text).strip()
    return cleaned[:limit]


def get_batch_embeddings(texts: List[str], api_key: str, model: str, max_retries: int = 7) -> List[List[float]]:
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }
    payload = {
        "input": texts,
        "model": model,
    }

    for attempt in range(max_retries):
        try:
            response = requests.post(VOYAGE_EMBEDDINGS_URL, headers=headers, json=payload, timeout=60)

            if response.status_code == 429:
                wait_s = min(60, 2 ** attempt)
                time.sleep(wait_s)
                continue

            response.raise_for_status()
            data = response.json().get("data", [])
            if not isinstance(data, list) or len(data) != len(texts):
                raise ValueError("Invalid embedding response shape")

            data_sorted = sorted(data, key=lambda item: item.get("index", 0))
            embeddings = [item.get("embedding") for item in data_sorted]
            if any((not isinstance(e, list) or len(e) == 0) for e in embeddings):
                raise ValueError("Invalid embedding payload values")
            return embeddings  # type: ignore[return-value]
        except Exception:
            if attempt == max_retries - 1:
                raise
            wait_s = min(60, 2 ** attempt)
            time.sleep(wait_s)

    raise RuntimeError("Unreachable")


def batched_embed(texts: List[str], api_key: str, model: str, batch_size: int) -> np.ndarray:
    vectors: List[np.ndarray] = []
    for i in range(0, len(texts), batch_size):
        batch = texts[i:i + batch_size]
        embs = get_batch_embeddings(batch, api_key, model=model)
        arr = np.asarray(embs, dtype=np.float32)
        if arr.ndim != 2:
            raise ValueError("Unexpected embedding matrix shape")
        norms = np.linalg.norm(arr, axis=1, keepdims=True)
        norms[norms == 0] = 1.0
        arr = arr / norms
        vectors.append(arr)
        print(f"   [Semantic] Embedded {min(i + batch_size, len(texts))}/{len(texts)}")

    if not vectors:
        return np.zeros((0, 0), dtype=np.float32)
    return np.vstack(vectors)


def build_semantic_labels(
    books: List[Dict[str, Any]],
    labels: List[str],
    api_key: str,
    model: str,
    batch_size: int,
) -> Tuple[int, int]:
    section_prompts: List[str] = []
    section_refs: List[Tuple[int, int]] = []

    for bi, book in enumerate(books):
        for si, section in enumerate(book["sections"]):
            preview = section.get("summary_preview", "")
            title_hint = section.get("title", "")
            prompt = f"Book: {book['book_name']}\nSection: {title_hint}\nContent: {preview}"
            section_prompts.append(prompt)
            section_refs.append((bi, si))

    if not section_prompts:
        return 0, 0

    print(f"\n[Semantic] Embedding {len(labels)} labels...")
    label_vecs = batched_embed(labels, api_key=api_key, model=model, batch_size=batch_size)
    if label_vecs.shape[0] != len(labels):
        raise ValueError("Label embedding count mismatch")

    print(f"[Semantic] Embedding {len(section_prompts)} section summaries...")
    section_vecs = batched_embed(section_prompts, api_key=api_key, model=model, batch_size=batch_size)
    if section_vecs.shape[0] != len(section_prompts):
        raise ValueError("Section embedding count mismatch")

    sims = section_vecs @ label_vecs.T
    best_idx = np.argmax(sims, axis=1)
    best_scores = np.max(sims, axis=1)

    for i, (bi, si) in enumerate(section_refs):
        idx = int(best_idx[i])
        books[bi]["sections"][si]["semantic_label"] = labels[idx]
        books[bi]["sections"][si]["semantic_score"] = float(best_scores[i])

    return len(labels), len(section_prompts)


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Build routing companion .bin files from existing .bin files."
    )
    parser.add_argument("directory", nargs="?", default=".", help="Target directory (default: current directory)")
    parser.add_argument("--section-pages", type=int, default=20, help="Page bucket size per section")
    parser.add_argument("--min-chunks-per-section", type=int, default=1, help="Drop tiny sections")
    parser.add_argument("--summary-chunks", type=int, default=2, help="Chunks per section used for summary preview")
    parser.add_argument("--summary-chars", type=int, default=700, help="Max summary preview chars per section")
    parser.add_argument("--semantic-labels", action="store_true", help="Force-enable semantic labels")
    parser.add_argument("--no-semantic-labels", action="store_true", help="Force-disable semantic labels")
    parser.add_argument("--semantic-batch-size", type=int, default=64, help="Batch size for semantic embedding calls")
    parser.add_argument("--semantic-model", default=VOYAGE_MODEL, help="Voyage embedding model for semantic labels")
    args = parser.parse_args()

    if args.semantic_labels and args.no_semantic_labels:
        raise SystemExit("Use either --semantic-labels or --no-semantic-labels, not both.")

    target_dir = Path(args.directory).expanduser().resolve()
    if not target_dir.is_dir():
        raise SystemExit(f"Error: directory does not exist: {target_dir}")

    section_pages = max(1, int(args.section_pages))
    min_chunks = max(1, int(args.min_chunks_per_section))
    summary_chunks = max(1, int(args.summary_chunks))
    summary_chars = max(120, int(args.summary_chars))

    bin_files = sorted(target_dir.glob("*.bin"))
    bin_files = [p for p in bin_files if not p.stem.endswith("_comp")]
    if not bin_files:
        raise SystemExit(f"No .bin files found in: {target_dir}")

    print(f"Found {len(bin_files)} .bin files in: {target_dir}")
    books_out: List[Dict[str, Any]] = []
    skipped: List[str] = []

    for bin_path in bin_files:
        pkg = read_package_bin(bin_path)
        if not pkg:
            skipped.append(f"{bin_path.name}: unreadable or invalid package format")
            continue

        chunks = pkg.get("chunks", [])
        if not isinstance(chunks, list) or not chunks:
            skipped.append(f"{bin_path.name}: no chunks")
            continue

        doc_meta = pkg.get("document_metadata", {}) if isinstance(pkg.get("document_metadata"), dict) else {}
        book_id = str(doc_meta.get("id") or bin_path.stem)
        book_name = str(doc_meta.get("filename") or bin_path.name)
        page_count_meta = int(doc_meta.get("page_count") or 0)

        book_dim: Optional[int] = None
        book_sum: Optional[np.ndarray] = None
        book_count = 0
        max_page_seen = 1

        sections: Dict[int, Dict[str, Any]] = {}

        for ch in chunks:
            if not isinstance(ch, dict):
                continue

            emb = ch.get("embedding")
            if not isinstance(emb, list) or not emb:
                continue

            try:
                vec = np.asarray(emb, dtype=np.float32)
            except Exception:
                continue
            if vec.ndim != 1:
                continue

            if book_dim is None:
                book_dim = int(vec.shape[0])
                book_sum = np.zeros(book_dim, dtype=np.float64)
            elif int(vec.shape[0]) != book_dim:
                continue

            nvec = l2_normalize(vec)
            if nvec is None:
                continue

            assert book_sum is not None
            book_sum += nvec.astype(np.float64)
            book_count += 1

            meta = ch.get("metadata", {}) if isinstance(ch.get("metadata"), dict) else {}
            page = to_int_page(meta.get("page"), default=1)
            max_page_seen = max(max_page_seen, page)

            sec_idx = (page - 1) // section_pages
            sec = sections.get(sec_idx)
            if sec is None:
                sec = {
                    "sum": np.zeros(book_dim, dtype=np.float64),
                    "count": 0,
                    "page_start": sec_idx * section_pages + 1,
                    "page_end": (sec_idx + 1) * section_pages,
                    "chunk_ids": [],
                    "summary_texts": [],
                }
                sections[sec_idx] = sec

            sec["sum"] += nvec.astype(np.float64)
            sec["count"] += 1

            chunk_id = ch.get("id")
            if isinstance(chunk_id, str):
                sec["chunk_ids"].append(chunk_id)

            if len(sec["summary_texts"]) < summary_chunks:
                chunk_text = ch.get("text")
                if isinstance(chunk_text, str) and chunk_text.strip():
                    sec["summary_texts"].append(compact_text(chunk_text, limit=400))

        if book_count == 0 or book_dim is None or book_sum is None:
            skipped.append(f"{bin_path.name}: no usable embeddings")
            continue

        book_vec = book_sum / float(book_count)
        book_vec = l2_normalize(book_vec.astype(np.float32))
        if book_vec is None:
            skipped.append(f"{bin_path.name}: failed book vector normalization")
            continue

        sections_out: List[Dict[str, Any]] = []
        for sec_idx in sorted(sections.keys()):
            sec = sections[sec_idx]
            if sec["count"] < min_chunks:
                continue

            sec_vec = sec["sum"] / float(sec["count"])
            sec_vec = l2_normalize(sec_vec.astype(np.float32))
            if sec_vec is None:
                continue

            preview = " ".join(sec["summary_texts"]).strip()
            if len(preview) > summary_chars:
                preview = preview[:summary_chars]

            section_id = f"{book_id}_sec_{sec_idx:04d}"
            sections_out.append({
                "section_id": section_id,
                "title": f"Pages {sec['page_start']}-{sec['page_end']}",
                "page_start": sec["page_start"],
                "page_end": sec["page_end"],
                "chunk_count": sec["count"],
                "chunk_ids": sec["chunk_ids"],
                "vector": sec_vec.tolist(),
                "summary_preview": preview,
            })

        books_out.append({
            "book_id": book_id,
            "book_name": book_name,
            "source_bin": bin_path.name,
            "embedding_dimensions": int(book_dim),
            "chunk_count": int(book_count),
            "page_count": page_count_meta if page_count_meta > 0 else int(max_page_seen),
            "book_vector": book_vec.tolist(),
            "sections": sections_out,
        })

        print(
            f"Processed {bin_path.name}: "
            f"chunks={book_count}, sections={len(sections_out)}, dim={book_dim}"
        )

    if args.semantic_labels:
        semantic_enabled = True
    elif args.no_semantic_labels:
        semantic_enabled = False
    else:
        semantic_enabled = prompt_yes_no("Generate semantic labels using Voyage API?", default_no=True)

    semantic_call_info = {"enabled": False, "label_count": 0, "section_count": 0}
    if semantic_enabled and books_out:
        api_key = get_api_key(prompt_if_missing=True)
        print("\n[Semantic] Enabled: generating semantic labels...")
        label_count, section_count = build_semantic_labels(
            books=books_out,
            labels=DEFAULT_LABELS,
            api_key=api_key,
            model=args.semantic_model,
            batch_size=max(1, int(args.semantic_batch_size)),
        )
        semantic_call_info = {
            "enabled": True,
            "label_count": label_count,
            "section_count": section_count,
        }
        print(f"[Semantic] Done. labels={label_count}, sections={section_count}")

    written_files: List[str] = []
    for book in books_out:
        source_bin = str(book.get("source_bin", "book.bin"))
        source_stem = Path(source_bin).stem
        out_name = f"{source_stem}_comp.bin"
        out_path = target_dir / out_name

        output = {
            "format_version": "route-1.1",
            "generated_at": dt.datetime.now(dt.timezone.utc).isoformat().replace("+00:00", "Z"),
            "source_directory": str(target_dir),
            "section_pages": section_pages,
            "books_count": 1,
            "books": [book],
            "semantic": semantic_call_info,
            "skipped": skipped,
        }

        out_bytes = json.dumps(output, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        out_path.write_bytes(gzip.compress(out_bytes, compresslevel=9))
        written_files.append(out_name)

    print("\nDone.")
    print(f"Books included: {len(books_out)}")
    if written_files:
        print("Written companion files:")
        for name in written_files:
            print(f" - {name}")
    if skipped:
        print("Skipped:")
        for s in skipped:
            print(f" - {s}")


if __name__ == "__main__":
    main()
