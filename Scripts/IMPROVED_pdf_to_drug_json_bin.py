#!/usr/bin/env python3
"""
Improved structured drug extractor for all PDFs in a directory.

This version adds stricter stop rules to reduce:
- chapter / section listings leaking into the previous drug
- page-transition bleed between unrelated sections
- numbered subsection headers being mistaken for drug content
- proprietary preparations swallowing the next chapter or drug

Outputs for each matched PDF:
- <pdf_stem>_drug_catalog.json
- shard_<code>.bin (gzip-compressed copy of the same JSON)
- file_mapping.json summary for the whole run

Usage:
  python3 Scripts/IMPROVED_pdf_to_drug_json_bin.py
  python3 Scripts/IMPROVED_pdf_to_drug_json_bin.py "/path/to/folder"
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
    "interactions": "interactions",
    "proprietary preparations": "proprietary_preparations",
    "proprietary preparation": "proprietary_preparations",
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
    "proprietary preparation",
}

SECTION_HEADER_NOISE_KEYWORDS = {
    "SYSTEM",
    "DRUG",
    "DRUGS",
    "ANALGESICS",
    "ANTICOAGULANTS",
    "ANTIANGINAL",
    "ANTIHYPERTENSIVE",
    "RESPIRATORY",
    "CARDIOVASCULAR",
    "GASTROINTESTINAL",
    "NERVOUS",
    "MENTAL",
    "HEPARINS",
    "CHAPTER",
}

BOUNDARY_SPLIT_PATTERN = re.compile(
    r"(?=(?:Chapter-\d+\b|\d+\.\s+[A-Z][A-Z][A-Z /&-]{5,}|\d+(?:\.\d+)+\.?\s+[A-Z]))"
)

CONTENTS_LINE_PATTERN = re.compile(
    r"^(?:Chapter-\d+\b.*|\d+(?:\.\d+)+\.?\s+.+\bp\.\s*\d+\b.*)$",
    re.IGNORECASE,
)

MAJOR_SECTION_PATTERN = re.compile(r"^\d+\.\s+[A-Z][A-Z0-9 /&().' -]{5,}$")
NUMBERED_SUBSECTION_PATTERN = re.compile(r"^\d+\.\d+(?:\.\d+)+\.?\s*[A-Z]")


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


def split_embedded_boundaries(text: str) -> List[str]:
    cleaned = normalize_space(text)
    if not cleaned:
        return []

    boundaries = [
        match.start()
        for match in BOUNDARY_SPLIT_PATTERN.finditer(cleaned)
        if match.start() > 0
    ]
    if not boundaries:
        return [cleaned]

    parts: List[str] = []
    start = 0
    for boundary in boundaries:
        chunk = normalize_space(cleaned[start:boundary])
        if chunk:
            parts.append(chunk)
        start = boundary
    final_chunk = normalize_space(cleaned[start:])
    if final_chunk:
        parts.append(final_chunk)
    return parts


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


def is_contents_or_listing_line(line: str) -> bool:
    text = normalize_space(line)
    if not text:
        return False

    if CONTENTS_LINE_PATTERN.match(text):
        return True

    if " p." in text.lower() and len(re.findall(r"\d+(?:\.\d+)+", text)) >= 1:
        return True

    if text.startswith("Chapter-"):
        return True

    return False


def is_structural_boundary(line: str) -> bool:
    text = normalize_space(line)
    if not text:
        return True

    if is_contents_or_listing_line(text):
        return True

    if text.startswith("Chapter-"):
        return True

    if MAJOR_SECTION_PATTERN.fullmatch(text):
        return True

    stripped = strip_heading_prefix(text)
    if "SYSTEM" in text and ":" not in text and "," not in text:
        return True

    if NUMBERED_SUBSECTION_PATTERN.match(text) and "[" not in stripped and "(" not in stripped:
        return True

    return False


def is_soft_page_boundary(line: str) -> bool:
    text = normalize_space(line)
    if not text:
        return True

    if MAJOR_SECTION_PATTERN.fullmatch(text):
        return True

    stripped = strip_heading_prefix(text)
    if "SYSTEM" in text and ":" not in text and "," not in text:
        return True

    if stripped.isupper() and any(keyword in stripped for keyword in SECTION_HEADER_NOISE_KEYWORDS):
        return True

    return False


def is_drug_heading(line: str) -> bool:
    original = normalize_space(line)
    text = strip_heading_prefix(original)
    if len(text) < 3 or len(text) > 120:
        return False
    if text.endswith(":"):
        return False
    if text.endswith(",") or text.endswith(";"):
        return False
    if text.startswith("("):
        return False

    lowered = text.lower()
    if lowered in NON_DRUG_HEADERS:
        return False

    if is_contents_or_listing_line(original):
        return False

    if MAJOR_SECTION_PATTERN.fullmatch(original):
        return False

    if NUMBERED_SUBSECTION_PATTERN.match(original) and "[" not in text and "(" not in text:
        return False

    letters_only = re.sub(r"[^A-Za-z]", "", text)
    if len(letters_only) < 3:
        return False
    if "[" not in text and "(" not in text and " " not in text and len(letters_only) < 6:
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
                for segment in split_embedded_boundaries(raw_line):
                    cleaned = remove_inline_page_noise(segment)
                    if cleaned and not is_likely_page_noise(cleaned):
                        rows.append({"page": page_index + 1, "text": cleaned})
        return rows, len(doc)
    finally:
        doc.close()


def split_into_blocks(rows: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    blocks: List[Dict[str, Any]] = []
    current: Optional[Dict[str, Any]] = None

    for row in rows:
        text = normalize_space(row["text"])
        if not text:
            continue

        if is_soft_page_boundary(text):
            continue

        if is_structural_boundary(text):
            if current and current["lines"]:
                blocks.append(current)
            current = None
            continue

        if is_drug_heading(text):
            if current and current["lines"]:
                blocks.append(current)
            current = {
                "heading": strip_heading_prefix(text),
                "pages": [row["page"]],
                "lines": [],
            }
            continue

        if current is None:
            continue

        if not current["lines"] and is_heading_continuation(text):
            current["heading"] = normalize_space(
                f"{current['heading']} {strip_heading_prefix(text)}"
            )
            if row["page"] not in current["pages"]:
                current["pages"].append(row["page"])
            continue

        current["lines"].append(text)
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


def resolve_section_key(header_text: str) -> Optional[str]:
    target = SECTION_HEADERS.get(header_text)
    if target:
        return target

    for candidate in sorted(SECTION_HEADERS, key=len, reverse=True):
        if header_text.startswith(f"{candidate} "):
            return SECTION_HEADERS[candidate]

    return None


def classify_section_line(line: str) -> Tuple[List[str], str, bool]:
    stripped = normalize_space(line)
    if not stripped:
        return [], "", False

    bare_header = None
    if stripped[:1].isupper() or stripped.isupper():
        bare_header = SECTION_HEADERS.get(normalize_header_token(stripped))
    if bare_header:
        return [bare_header], "", True

    match = re.match(r"^([A-Za-z][A-Za-z ,&/\-]*?)\s*:\s*(.*)$", stripped)
    if not match:
        return [], stripped, False

    header_text = normalize_header_token(match.group(1))
    remainder = normalize_space(match.group(2))
    target = resolve_section_key(header_text)
    if target:
        return [target], remainder, True

    raw_header_parts = re.split(r",|&|/|\band\b", match.group(1), flags=re.IGNORECASE)
    header_parts = [normalize_header_token(part) for part in raw_header_parts]
    section_keys = [resolve_section_key(part) for part in header_parts if part]
    if section_keys and all(section_keys):
        unique_keys = list(dict.fromkeys(section_keys))
        if not remainder or looks_like_header_fragment(remainder):
            return [], "", True
        return unique_keys, remainder, True

    return [], stripped, False


def sanitize_section_value(text: str) -> Optional[str]:
    compact = normalize_space(text)
    if not compact:
        return None

    if is_contents_or_listing_line(compact):
        return None

    compact = re.sub(r"(?:Chapter-\d+\b.*)$", "", compact, flags=re.IGNORECASE)
    compact = re.sub(r"(?:\d+\.\s+[A-Z][A-Z0-9 /&().' -]{5,})$", "", compact)
    compact = normalize_space(compact)
    return compact or None


def join_section_lines(parts: List[str]) -> Optional[str]:
    text = ""
    for part in parts:
        cleaned = normalize_space(part)
        if not cleaned:
            continue
        if not text:
            text = cleaned
            continue

        if text.endswith("-") and cleaned[:1].islower():
            text = f"{text[:-1]}{cleaned}"
        elif text.endswith("/") or cleaned.startswith(("/", ")", ",", ".", ";", ":")):
            text = f"{text}{cleaned}"
        else:
            text = f"{text} {cleaned}"

    return normalize_space(text) or None


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
        "interactions": [],
        "notes": [],
        "proprietary_preparations": [],
    }

    current_sections = ["notes"]
    raw_lines: List[str] = []

    for line in block["lines"]:
        line = remove_inline_page_noise(line)
        if not line or is_likely_page_noise(line):
            continue
        if is_soft_page_boundary(line):
            continue
        if is_structural_boundary(line):
            break

        section_keys, remainder, consumed = classify_section_line(line)
        if section_keys:
            if (
                not remainder
                and len(section_keys) == 1
                and current_sections
                and current_sections[0] != section_keys[0]
            ):
                current_value = join_section_lines(sections[current_sections[0]])
                if current_value and current_value.lower().endswith("see under"):
                    sections[current_sections[0]].append(line)
                    raw_lines.append(line)
                    continue

            current_sections = section_keys
            if remainder:
                cleaned_remainder = sanitize_section_value(remainder)
                if cleaned_remainder:
                    for key in current_sections:
                        sections[key].append(cleaned_remainder)
            raw_lines.append(line)
            continue

        if consumed:
            raw_lines.append(line)
            continue

        cleaned_line = sanitize_section_value(line)
        if not cleaned_line:
            continue

        for key in current_sections:
            sections[key].append(cleaned_line)
        raw_lines.append(cleaned_line)

    has_key_sections = any(
        sections[key]
        for key in (
            "indications",
            "cautions",
            "contraindications",
            "side_effects",
            "dose",
            "interactions",
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
        "indications": join_section_lines(sections["indications"]),
        "cautions": join_section_lines(sections["cautions"]),
        "contraindications": join_section_lines(sections["contraindications"]),
        "side_effects": join_section_lines(sections["side_effects"]),
        "dose": join_section_lines(sections["dose"]),
        "interactions": join_section_lines(sections["interactions"]),
        "notes": join_section_lines(sections["notes"]),
        "proprietary_preparations": join_section_lines(sections["proprietary_preparations"]),
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
            "source_system": "LocalDocs AI Drug Extractor (Improved Boundaries)",
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
