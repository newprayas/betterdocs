#!/usr/bin/env python3
"""
Extract BNF-style drug sections from every PDF in the current working directory.

Default output:
  ./drug_sections.json

Usage:
  python3 /path/to/Scripts/extract_bnf_drug_sections.py
  python3 /path/to/Scripts/extract_bnf_drug_sections.py --output my_sections.json
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import re
from pathlib import Path
from typing import Any

import fitz  # PyMuPDF


SECTION_MAP = {
    "indications and dose": "indications_and_dose",
    "important safety information": "important_safety_information",
    "contra indications": "contra_indications",
    "contra indication": "contra_indications",
    "cautions": "cautions",
    "cautions further information": "cautions_further_information",
    "interactions": "interactions",
    "side effects": "side_effects",
    "pregnancy": "pregnancy",
    "breast feeding": "breast_feeding",
    "hepatic impairment": "hepatic_impairment",
    "renal impairment": "renal_impairment",
    "treatment cessation": "treatment_cessation",
    "directions for administration": "directions_for_administration",
    "prescribing and dispensing information": "prescribing_and_dispensing_information",
    "patient and carer advice": "patient_and_carer_advice",
}

SECTION_KEYS = list(dict.fromkeys(SECTION_MAP.values()))

DATE_SUFFIX_RE = re.compile(r"\s+\d{2}-[A-Za-z]{3}-\d{4}$")
STOP_SECTION = "__stop__"

SECTION_PATTERNS = [
    ("indications_and_dose", re.compile(r"(?<!\w)(?:[lI|]\s+)?INDICATIONS\s+AND\s+DOSE\b")),
    ("important_safety_information", re.compile(r"(?<!\w)IMPORTANT\s+SAFETY\s+INFORMATION\b")),
    ("contra_indications", re.compile(r"(?<!\w)(?:[lI|]\s+)?CONTRA(?:-|\s+)INDICATIONS?\b")),
    (
        "cautions_further_information",
        re.compile(r"(?<!\w)(?:[lI|]\s+)?CAUTIONS(?:\s*,\s*|\s+)FURTHER\s+INFORMATION\b"),
    ),
    ("cautions", re.compile(r"(?<!\w)(?:[lI|]\s+)?CAUTIONS\b")),
    ("interactions", re.compile(r"(?<!\w)(?:[lI|]\s+)?INTERACTIONS\b")),
    ("side_effects", re.compile(r"(?<!\w)(?:[lI|]\s+)?SIDE(?:-|\s+)EFFECTS\b")),
    ("pregnancy", re.compile(r"(?<!\w)(?:[lI|]\s+)?PREGNANCY\b")),
    ("breast_feeding", re.compile(r"(?<!\w)(?:[lI|]\s+)?BREAST\s+FEEDING\b")),
    ("hepatic_impairment", re.compile(r"(?<!\w)(?:[lI|]\s+)?HEPATIC\s+IMPAIRMENT\b")),
    ("renal_impairment", re.compile(r"(?<!\w)(?:[lI|]\s+)?RENAL\s+IMPAIRMENT\b")),
    ("treatment_cessation", re.compile(r"(?<!\w)(?:[lI|]\s+)?TREATMENT\s+CESSATION\b")),
    (
        "directions_for_administration",
        re.compile(r"(?<!\w)(?:[lI|]\s+)?DIRECTIONS\s+FOR\s+ADMINISTRATION\b"),
    ),
    (
        "prescribing_and_dispensing_information",
        re.compile(r"(?<!\w)(?:[lI|]\s+)?PRESCRIBING\s+AND\s+DISPENSING\s+INFORMATION\b"),
    ),
    (
        "patient_and_carer_advice",
        re.compile(r"(?<!\w)(?:[lI|]\s+)?PATIENT\s+AND\s+CARER\s+ADVICE\b"),
    ),
]

STOP_PATTERNS = [
    (STOP_SECTION, re.compile(r"(?<!\w)(?:[lI|]\s+)?MEDICINAL\s+FORMS\b")),
    (STOP_SECTION, re.compile(r"(?<!\w)COMBINATIONS\s+AVAILABLE\b")),
    (STOP_SECTION, re.compile(r"(?<!\w)CAUTIONARY\s+AND\s+ADVISORY\s+LABELS\b")),
]

FORM_HEADING_RE = re.compile(
    r"^(?:"
    r"Tablet|Tablets|Capsule|Capsules|Caplet|Caplets|Linctus|Oral solution|Oral suspension|"
    r"Oral drops|Oral powder|Mixture|Modified-release tablets|Modified-release capsules|"
    r"Orodispersible tablets|Sublingual tablets|Effervescent tablets|Transdermal patches|"
    r"Suppositories|Solution for injection|Powder for solution for injection|Powder for injection|"
    r"Injection|Infusion|Granules|Lozenges|Oral lyophilisate"
    r")$"
)


def normalize_space(text: str) -> str:
    return re.sub(r"\s+", " ", text).strip()


def normalize_header(text: str) -> str:
    cleaned = normalize_space(text)
    cleaned = re.sub(r"^[\W_]*[lI|]\s+", "", cleaned)
    cleaned = re.sub(r"^[\W_]*", "", cleaned)
    cleaned = cleaned.replace("&", " and ")
    cleaned = cleaned.replace("-", " ")
    cleaned = re.sub(r"[^A-Za-z ]+", " ", cleaned)
    return normalize_space(cleaned).lower()


def clean_line(text: str) -> str:
    cleaned = text.replace("\u00a0", " ")
    cleaned = cleaned.replace("\uf0b7", " ")
    cleaned = cleaned.replace("▶", "▶ ")
    cleaned = normalize_space(cleaned)
    return cleaned


def is_noise_line(text: str) -> bool:
    line = normalize_space(text)
    if not line:
        return True

    lower = line.lower()
    if "facebook.com" in lower or "books-courses-medical applications" in lower:
        return True
    if lower == "www.med":
        return True
    if re.fullmatch(r"\d+", line):
        return True
    if re.fullmatch(r"[A-Za-z ]+\s+BNF\s+\d+", line):
        return True
    if re.fullmatch(r"[A-Za-z ]+\d+", line):
        upper_ratio = sum(1 for ch in line if ch.isupper()) / max(1, sum(1 for ch in line if ch.isalpha()))
        if upper_ratio > 0.6:
            return True
    if line.startswith("eiii "):
        return True
    return False


def extract_pdf_lines(pdf_path: Path) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    doc = fitz.open(pdf_path)
    try:
        for page_index, page in enumerate(doc):
            for raw_line in page.get_text("text").splitlines():
                line = clean_line(raw_line)
                if not is_noise_line(line):
                    rows.append({"page": page_index + 1, "text": line})
    finally:
        doc.close()
    return rows


def detect_section_header(text: str) -> str | None:
    normalized = normalize_header(text)
    return SECTION_MAP.get(normalized)


def find_inline_markers(text: str) -> list[tuple[int, int, str]]:
    matches: list[tuple[int, int, str]] = []
    for key, pattern in [*SECTION_PATTERNS, *STOP_PATTERNS]:
        for match in pattern.finditer(text):
            matches.append((match.start(), match.end(), key))

    matches.sort(key=lambda item: (item[0], -(item[1] - item[0])))
    filtered: list[tuple[int, int, str]] = []
    last_end = -1
    for start, end, key in matches:
        if start < last_end:
            continue
        filtered.append((start, end, key))
        last_end = end
    return filtered


def leading_section_key(text: str) -> str | None:
    markers = find_inline_markers(text)
    if not markers:
        return None
    start, _end, key = markers[0]
    if key == STOP_SECTION:
        return STOP_SECTION
    if text[:start].strip():
        return None
    return key


def clean_segment_text(text: str) -> str:
    return normalize_space(text.strip(" :-\u2022"))


def looks_like_non_clinical_line(text: str) -> bool:
    line = normalize_space(text)
    if not line:
        return False
    if FORM_HEADING_RE.fullmatch(line):
        return True
    if line.startswith("▶") and "(Non-proprietary)" in line:
        return True
    return False


def is_title_candidate(text: str) -> bool:
    line = normalize_space(text)
    if len(line) < 4 or len(line) > 120:
        return False
    if line.startswith("▶"):
        return False
    if detect_section_header(line):
        return False
    if line.endswith(":"):
        return False
    if any(ch.isdigit() for ch in DATE_SUFFIX_RE.sub("", line)):
        return False

    no_date = DATE_SUFFIX_RE.sub("", line)
    if len(no_date.split()) > 8:
        return False
    if not re.fullmatch(r"[A-Za-z][A-Za-z0-9()/,\- ]*[A-Za-z)]", no_date):
        return False

    alpha_count = sum(1 for ch in no_date if ch.isalpha())
    if alpha_count < 4:
        return False

    upper_ratio = sum(1 for ch in no_date if ch.isupper()) / max(1, alpha_count)
    if upper_ratio > 0.45:
        return False

    first_alpha = next((ch for ch in no_date if ch.isalpha()), "")
    if first_alpha and not first_alpha.isupper():
        return False

    return True


def is_entry_start(rows: list[dict[str, Any]], index: int) -> bool:
    line = rows[index]["text"]
    if not is_title_candidate(line):
        return False

    for next_row in rows[index + 1 : index + 7]:
        next_line = next_row["text"]
        section_key = leading_section_key(next_line) or detect_section_header(next_line)
        if section_key:
            return section_key == "indications_and_dose"
        if is_title_candidate(next_line):
            return False

    return False


def build_entry(title_line: str, source_pdf: str, pages: set[int], sections: dict[str, list[str]]) -> dict[str, Any] | None:
    title = normalize_space(DATE_SUFFIX_RE.sub("", title_line))
    if not title:
        return None

    extracted = {
        key: normalize_space(" ".join(value)) or None
        for key, value in sections.items()
    }
    if not any(extracted.values()):
        return None

    return {
        "title": title,
        "source_pdf": source_pdf,
        "pages": sorted(pages),
        **extracted,
    }


def parse_pdf(pdf_path: Path) -> list[dict[str, Any]]:
    rows = extract_pdf_lines(pdf_path)
    entries: list[dict[str, Any]] = []

    current_title: str | None = None
    current_section: str | None = None
    current_pages: set[int] = set()
    current_sections = {key: [] for key in SECTION_KEYS}
    skip_non_clinical = False

    def flush_current() -> None:
        nonlocal current_title, current_section, current_pages, current_sections, skip_non_clinical
        if current_title:
            entry = build_entry(current_title, pdf_path.name, current_pages, current_sections)
            if entry:
                entries.append(entry)
        current_title = None
        current_section = None
        current_pages = set()
        current_sections = {key: [] for key in SECTION_KEYS}
        skip_non_clinical = False

    for index, row in enumerate(rows):
        line = row["text"]
        page = row["page"]

        if is_entry_start(rows, index):
            flush_current()
            current_title = line
            current_pages = {page}
            continue

        if not current_title:
            continue

        current_pages.add(page)

        if skip_non_clinical:
            continue

        if looks_like_non_clinical_line(line):
            skip_non_clinical = True
            current_section = None
            continue

        markers = find_inline_markers(line)
        if not markers:
            if current_section:
                current_sections[current_section].append(line)
            continue

        prefix = clean_segment_text(line[: markers[0][0]])
        if prefix and current_section:
            current_sections[current_section].append(prefix)

        for marker_index, (start, end, section_key) in enumerate(markers):
            if section_key == STOP_SECTION:
                skip_non_clinical = True
                current_section = None
                break

            current_section = section_key
            next_start = markers[marker_index + 1][0] if marker_index + 1 < len(markers) else len(line)
            content = clean_segment_text(line[end:next_start])
            if content:
                current_sections[current_section].append(content)

    flush_current()
    return entries


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Extract BNF-style drug sections from all PDFs in the current working directory."
    )
    parser.add_argument(
        "--output",
        default="drug_sections.json",
        help="Output JSON filename written to the current working directory.",
    )
    args = parser.parse_args()

    target_dir = Path.cwd()
    pdfs = sorted(target_dir.glob("*.pdf"))
    if not pdfs:
        raise SystemExit(f"No PDF files found in: {target_dir}")

    all_entries: list[dict[str, Any]] = []
    for pdf_path in pdfs:
        all_entries.extend(parse_pdf(pdf_path))

    payload = {
        "format_version": "bnf-drug-sections-1.0",
        "generated_at": dt.datetime.now(dt.timezone.utc).isoformat().replace("+00:00", "Z"),
        "directory": str(target_dir),
        "pdf_count": len(pdfs),
        "drug_count": len(all_entries),
        "drugs": all_entries,
    }

    output_path = target_dir / args.output
    with output_path.open("w", encoding="utf-8") as handle:
        json.dump(payload, handle, indent=2, ensure_ascii=False)

    print(f"Processed {len(pdfs)} PDF file(s)")
    print(f"Extracted {len(all_entries)} drug entries")
    print(f"Saved JSON to {output_path}")


if __name__ == "__main__":
    main()
