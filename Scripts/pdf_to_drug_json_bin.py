#!/usr/bin/env python3
"""
Extract structured drug entries from all PDFs in a directory.

Outputs for each matched PDF:
- <pdf_stem>_drug_catalog.json
- shard_<code>.bin (gzip-compressed copy of the same JSON)
- file_mapping.json summary for the whole run

Usage:
  python3 Scripts/pdf_to_drug_json_bin.py
  python3 Scripts/pdf_to_drug_json_bin.py "/path/to/folder"
"""

from __future__ import annotations

import argparse
import datetime
import gzip
import hashlib
import json
import random
import re
import string
import uuid
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import fitz  # PyMuPDF


SECTION_HEADERS = {
    "indications": "indications",
    "indication": "indications",
    "cautions": "cautions",
    "caution": "cautions",
    "contraindications": "contraindications",
    "contraindication": "contraindications",
    "contra indications": "contraindications",
    "contra indication": "contraindications",
    "side effects": "side_effects",
    "side-effects": "side_effects",
    "sideeffects": "side_effects",
    "dose": "dose",
    "note": "notes",
    "notes": "notes",
    "interactions": "notes",
    "proprietary preparations": "proprietary_preparations",
}

NON_DRUG_HEADERS = {
    "indications",
    "cautions",
    "contraindications",
    "side effects",
    "side-effects",
    "dose",
    "note",
    "notes",
    "interactions",
    "proprietary preparations",
}

SECTION_HEADER_NOISE_KEYWORDS = {
    "SYSTEM",
    "DRUGS",
    "ANALGESICS",
    "ANTI INFLAMMATORY",
    "ANTI-INFLAMMATORY",
    "NSAIDS",
    "PAIN",
    "NEURALGIC",
    "NEUROPATHIC",
}


def sha256_hex(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def format_bytes(num_bytes: int) -> str:
    units = ["B", "KB", "MB", "GB", "TB"]
    size = float(num_bytes)
    idx = 0
    while size >= 1024 and idx < len(units) - 1:
        size /= 1024
        idx += 1
    return f"{int(size)} {units[idx]}" if idx == 0 else f"{size:.1f} {units[idx]}"


def make_code(used_codes: set[str]) -> str:
    while True:
        code = f"{random.choice(string.digits)}{random.choice(string.ascii_lowercase)}{random.choice(string.digits)}"
        if code not in used_codes:
            used_codes.add(code)
            return code


def normalize_space(text: str) -> str:
    return re.sub(r"\s+", " ", text).strip()


def strip_heading_prefix(text: str) -> str:
    cleaned = normalize_space(text)
    return re.sub(r"^\d+(?:\.\d+)+\.?\s+", "", cleaned)


def normalize_header_token(text: str) -> str:
    cleaned = normalize_space(text).lower()
    cleaned = cleaned.replace("&", " and ")
    cleaned = cleaned.replace("-", " ")
    cleaned = re.sub(r"[^a-z ]+", " ", cleaned)
    cleaned = normalize_space(cleaned)
    return cleaned


def remove_inline_page_noise(text: str) -> str:
    cleaned = normalize_space(text)
    pattern = re.compile(r"\d+\.\s+[A-Z][A-Z \-/()]+$")
    match = pattern.search(cleaned)
    if not match:
        return cleaned

    candidate = match.group(0)
    if any(keyword in candidate for keyword in SECTION_HEADER_NOISE_KEYWORDS):
        return normalize_space(cleaned[: match.start()])
    return cleaned


def is_likely_page_noise(line: str) -> bool:
    text = normalize_space(line)
    if not text:
        return True

    if re.fullmatch(r"\d+", text):
        return True

    bare = strip_heading_prefix(text)
    if ":" in bare or "," in bare:
        return False

    uppercase_letters = sum(1 for ch in bare if ch.isupper())
    alpha_letters = sum(1 for ch in bare if ch.isalpha())
    uppercase_ratio = uppercase_letters / max(1, alpha_letters)
    keyword_hit = any(keyword in bare for keyword in SECTION_HEADER_NOISE_KEYWORDS)

    return alpha_letters > 6 and uppercase_ratio > 0.75 and keyword_hit


def is_drug_heading(line: str) -> bool:
    text = strip_heading_prefix(line)
    if len(text) < 3 or len(text) > 120:
        return False
    if text.endswith(":"):
        return False
    if text.startswith("("):
        return False

    lowered = text.lower()
    if lowered in NON_DRUG_HEADERS:
        return False

    letters_only = re.sub(r"[^A-Za-z]", "", text)
    if len(letters_only) < 3:
        return False

    uppercase_ratio = sum(1 for ch in text if ch.isupper()) / max(
        1, sum(1 for ch in text if ch.isalpha())
    )
    if uppercase_ratio < 0.7:
        return False

    if not re.fullmatch(r"[A-Z0-9 \-,'/().\[\]&]+", text):
        return False

    return True


def is_heading_continuation(line: str) -> bool:
    text = strip_heading_prefix(line)
    if len(text) < 3 or ":" in text:
        return False
    if not text.startswith("("):
        return False

    letters_only = re.sub(r"[^A-Za-z]", "", text)
    if len(letters_only) < 3:
        return False

    return bool(re.fullmatch(r"\([A-Z0-9 \-,'/.&]+\)(?:\s*\[[A-Z]+\])*$", text))


def extract_pdf_lines(pdf_path: Path) -> Tuple[List[Dict[str, Any]], int]:
    doc = fitz.open(pdf_path)
    rows: List[Dict[str, Any]] = []
    try:
        for page_index, page in enumerate(doc):
            text = page.get_text("text")
            for raw_line in text.splitlines():
                cleaned = remove_inline_page_noise(raw_line)
                if cleaned and not is_likely_page_noise(cleaned):
                    rows.append({"page": page_index + 1, "text": cleaned})
        return rows, len(doc)
    finally:
        doc.close()


def split_into_blocks(rows: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    blocks: List[Dict[str, Any]] = []
    current: Optional[Dict[str, Any]] = None

    for row in rows:
        if is_drug_heading(row["text"]):
            if current and current["lines"]:
                blocks.append(current)
            current = {
                "heading": strip_heading_prefix(row["text"]),
                "pages": [row["page"]],
                "lines": [],
            }
            continue

        if current is None:
            continue

        if not current["lines"] and is_heading_continuation(row["text"]):
            current["heading"] = normalize_space(
                f"{current['heading']} {strip_heading_prefix(row['text'])}"
            )
            if row["page"] not in current["pages"]:
                current["pages"].append(row["page"])
            continue

        current["lines"].append(row["text"])
        if row["page"] not in current["pages"]:
            current["pages"].append(row["page"])

    if current and current["lines"]:
        blocks.append(current)

    return blocks


def parse_heading(heading: str) -> Tuple[str, List[str]]:
    cleaned = strip_heading_prefix(heading)
    aliases: List[str] = []

    alias_match = re.search(r"\(([^)]+)\)", cleaned)
    if alias_match:
        aliases = [
            normalize_space(part)
            for part in re.split(r"[,;/]", alias_match.group(1))
            if normalize_space(part)
        ]
        cleaned = normalize_space(re.sub(r"\([^)]+\)", "", cleaned))

    cleaned = re.sub(r"\s+\[", "[", cleaned)
    return cleaned, aliases


def looks_like_header_fragment(text: str) -> bool:
    normalized = normalize_header_token(text)
    if not normalized:
        return False
    if normalized in SECTION_HEADERS:
        return True

    parts = [normalize_space(part) for part in re.split(r"\band\b", normalized)]
    parts = [part for chunk in parts for part in chunk.split(",")]
    parts = [part for part in parts if part]
    return bool(parts) and all(part in SECTION_HEADERS for part in parts)


def classify_section_line(line: str) -> Tuple[List[str], str, bool]:
    stripped = normalize_space(line)
    if not stripped:
        return [], "", False

    bare_header = SECTION_HEADERS.get(normalize_header_token(stripped))
    if bare_header:
        return [bare_header], "", True

    match = re.match(r"^([A-Za-z][A-Za-z ,&/\-]*?)\s*:\s*(.*)$", stripped)
    if not match:
        return [], stripped, False

    header_text = normalize_header_token(match.group(1))
    remainder = normalize_space(match.group(2))
    target = SECTION_HEADERS.get(header_text)
    if target:
        return [target], remainder, True

    raw_header_parts = re.split(r",|&|/|\band\b", match.group(1), flags=re.IGNORECASE)
    header_parts = [normalize_header_token(part) for part in raw_header_parts]
    section_keys = [SECTION_HEADERS.get(part) for part in header_parts if part]
    if section_keys and all(section_keys):
        unique_keys = list(dict.fromkeys(section_keys))
        if not remainder or looks_like_header_fragment(remainder):
            return [], "", True
        return unique_keys, remainder, True

    return [], stripped, False


def parse_block(block: Dict[str, Any], document_id: str, index: int) -> Optional[Dict[str, Any]]:
    drug_name, aliases = parse_heading(block["heading"])
    if not drug_name:
        return None

    sections: Dict[str, List[str]] = {
        "indications": [],
        "cautions": [],
        "contraindications": [],
        "side_effects": [],
        "dose": [],
        "notes": [],
        "proprietary_preparations": [],
    }

    current_sections = ["notes"]
    raw_lines: List[str] = []

    for line in block["lines"]:
        line = remove_inline_page_noise(line)
        if not line or is_likely_page_noise(line):
            continue
        section_keys, remainder, consumed = classify_section_line(line)
        if section_keys:
            current_sections = section_keys
            if remainder:
                for key in current_sections:
                    sections[key].append(remainder)
            raw_lines.append(line)
            continue

        if consumed:
            raw_lines.append(line)
            continue

        for key in current_sections:
            sections[key].append(line)
        raw_lines.append(line)

    has_key_sections = any(
        sections[key]
        for key in (
            "indications",
            "cautions",
            "contraindications",
            "side_effects",
            "dose",
            "proprietary_preparations",
        )
    )
    if not has_key_sections:
        return None

    combined_text = "\n".join([drug_name] + raw_lines).strip()
    search_text = normalize_space(
        " ".join(
            [
                drug_name,
                " ".join(aliases),
                combined_text,
                " ".join(" ".join(values) for values in sections.values()),
            ]
        )
    )

    return {
        "id": f"{document_id}_{index}",
        "drug_name": drug_name,
        "aliases": aliases,
        "pages": block["pages"],
        "indications": normalize_space(" ".join(sections["indications"])) or None,
        "cautions": normalize_space(" ".join(sections["cautions"])) or None,
        "contraindications": normalize_space(" ".join(sections["contraindications"])) or None,
        "side_effects": normalize_space(" ".join(sections["side_effects"])) or None,
        "dose": normalize_space(" ".join(sections["dose"])) or None,
        "notes": normalize_space(" ".join(sections["notes"])) or None,
        "proprietary_preparations": normalize_space(" ".join(sections["proprietary_preparations"])) or None,
        "raw_text": combined_text,
        "search_text": search_text,
    }


def verify_bin_matches_json(bin_path: Path, expected_obj: Dict[str, Any]) -> None:
    raw = bin_path.read_bytes()
    decompressed = gzip.decompress(raw).decode("utf-8")
    actual = json.loads(decompressed)
    if actual != expected_obj:
        raise ValueError("Decoded .bin JSON does not match the source JSON")


def process_pdf(
    pdf_path: Path,
    used_codes: set[str],
) -> Optional[Dict[str, Any]]:
    print(f"\nProcessing: {pdf_path.name}")
    rows, page_count = extract_pdf_lines(pdf_path)
    if not rows:
        print("  Skipped: no readable text.")
        return None

    document_id = str(uuid.uuid4())
    blocks = split_into_blocks(rows)
    entries: List[Dict[str, Any]] = []
    skipped_blocks = 0

    for index, block in enumerate(blocks):
        parsed = parse_block(block, document_id=document_id, index=index)
        if parsed is None:
            skipped_blocks += 1
            continue
        entries.append(parsed)

    if not entries:
        print("  Skipped: no structured drug entries found.")
        return None

    catalog = {
        "format_version": "drug-catalog-1.0",
        "source_metadata": {
            "document_id": document_id,
            "filename": pdf_path.name,
            "page_count": page_count,
            "generated_at": datetime.datetime.now(datetime.timezone.utc).isoformat().replace("+00:00", "Z"),
            "source_system": "LocalDocs AI Drug Extractor",
        },
        "entries": entries,
    }

    json_name = f"{pdf_path.stem}_drug_catalog.json"
    json_path = pdf_path.parent / json_name
    with json_path.open("w", encoding="utf-8") as f:
        json.dump(catalog, f, indent=2, ensure_ascii=False)

    json_bytes = json.dumps(catalog, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    gz_bytes = gzip.compress(json_bytes, compresslevel=9)

    code = make_code(used_codes)
    bin_name = f"shard_{code}.bin"
    bin_path = pdf_path.parent / bin_name
    bin_path.write_bytes(gz_bytes)
    verify_bin_matches_json(bin_path, catalog)

    print(f"  Entries extracted : {len(entries)}")
    print(f"  Blocks skipped    : {skipped_blocks}")
    print(f"  JSON output       : {json_name}")
    print(f"  BIN output        : {bin_name} ({format_bytes(bin_path.stat().st_size)})")

    return {
        "pdf": pdf_path.name,
        "document_id": document_id,
        "entry_count": len(entries),
        "skipped_blocks": skipped_blocks,
        "json_output": json_name,
        "bin_output": bin_name,
        "bin_size_bytes": bin_path.stat().st_size,
        "bin_size_human": format_bytes(bin_path.stat().st_size),
        "sha256": sha256_hex(gz_bytes),
    }


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Extract structured drug JSON and .bin files from all PDFs in a directory."
    )
    parser.add_argument(
        "directory",
        nargs="?",
        default=".",
        help="Target directory (default: current directory)",
    )
    parser.add_argument(
        "--mapping-file",
        default="file_mapping.json",
        help="Summary mapping output filename (default: file_mapping.json)",
    )
    args = parser.parse_args()

    target_dir = Path(args.directory).expanduser().resolve()
    if not target_dir.is_dir():
        raise SystemExit(f"Directory not found: {target_dir}")

    pdfs = sorted(target_dir.glob("*.pdf"))
    if not pdfs:
        raise SystemExit(f"No PDF files found in: {target_dir}")

    print(f"Found {len(pdfs)} PDF file(s) in: {target_dir}")
    used_codes: set[str] = set()
    results: List[Dict[str, Any]] = []
    skipped: List[Dict[str, str]] = []

    for pdf_path in pdfs:
        try:
            result = process_pdf(pdf_path, used_codes)
            if result:
                results.append(result)
            else:
                skipped.append({"pdf": pdf_path.name, "reason": "no structured drug entries found"})
        except Exception as exc:
            print(f"  Failed: {exc}")
            skipped.append({"pdf": pdf_path.name, "reason": str(exc)})

    mapping = {
        "generated_at": datetime.datetime.now(datetime.timezone.utc).isoformat().replace("+00:00", "Z"),
        "directory": str(target_dir),
        "processed_count": len(results),
        "skipped_count": len(skipped),
        "files": results,
        "skipped": skipped,
    }

    mapping_path = target_dir / args.mapping_file
    with mapping_path.open("w", encoding="utf-8") as f:
        json.dump(mapping, f, indent=2, ensure_ascii=False)

    print(f"\nDone. Mapping saved to: {mapping_path}")
    print(f"Processed: {len(results)} | Skipped: {len(skipped)}")


if __name__ == "__main__":
    main()
