#!/usr/bin/env python3
"""
Count chunks for all PDF files in the current directory.

Uses the same page-local character chunking as the existing PDF preprocessing
scripts:
- chunk_size: 1000
- chunk_overlap: 200

No embedding API calls are made.

Usage:
  python3 Scripts/count_pdf_chunks.py
  python3 Scripts/count_pdf_chunks.py --chunk-size 1200 --chunk-overlap 150
"""

from __future__ import annotations

import argparse
from pathlib import Path
from typing import Any, Dict, List, Tuple

import fitz  # PyMuPDF


def extract_pages_from_pdf(pdf_path: Path) -> Tuple[List[Dict[str, Any]], int]:
    try:
        doc = fitz.open(pdf_path)
        pages: List[Dict[str, Any]] = []
        for i, page in enumerate(doc):
            text = page.get_text()
            if text and text.strip():
                pages.append({"text": text, "page_number": i + 1})
        return pages, len(doc)
    except Exception as exc:
        print(f"{pdf_path.name}: error reading PDF: {exc}")
        return [], 0


def chunk_text_with_page_context(
    pages: List[Dict[str, Any]],
    chunk_size: int,
    overlap: int,
) -> List[Dict[str, Any]]:
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


def main() -> None:
    parser = argparse.ArgumentParser(description="Count chunks for all PDFs in the current directory.")
    parser.add_argument("--chunk-size", type=int, default=1000, help="Chunk size in characters (default: 1000)")
    parser.add_argument("--chunk-overlap", type=int, default=200, help="Chunk overlap in characters (default: 200)")
    args = parser.parse_args()

    target_dir = Path.cwd()
    pdfs = sorted(target_dir.glob("*.pdf"))
    if not pdfs:
        raise SystemExit(f"No PDF files found in: {target_dir}")

    total_chunks = 0
    total_pages = 0

    print(f"Directory: {target_dir}")
    print(f"PDFs found: {len(pdfs)}")
    print(f"Chunk settings: size={args.chunk_size}, overlap={args.chunk_overlap}")
    print("")

    for pdf_path in pdfs:
        pages, page_count = extract_pages_from_pdf(pdf_path)
        chunks = chunk_text_with_page_context(pages, args.chunk_size, args.chunk_overlap)
        total_pages += page_count
        total_chunks += len(chunks)
        print(f"{pdf_path.name}: {len(chunks)} chunks ({page_count} pages)")

    print("")
    print(f"Total pages: {total_pages}")
    print(f"Total chunks: {total_chunks}")


if __name__ == "__main__":
    main()
