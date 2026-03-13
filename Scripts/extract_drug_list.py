#!/usr/bin/env python3
"""
Scan the current working directory for .txt files and write cleaned drug-name
lists beside them using the prefix CLEAN_.

Example:
  drugs.txt -> CLEAN_drugs.txt
"""

from __future__ import annotations

import re
from pathlib import Path


LEADER_SPLIT_RE = re.compile(r"^(.*?)\s*\.{2,}.*$")
TRAILING_PAGE_RE = re.compile(r"^(.*?)\s+\d[\d,\s-]*$")
OUTPUT_PREFIX = "CLEAN_"


def clean_drug_name(line: str) -> str | None:
    cleaned = line.strip()
    if not cleaned:
        return None

    leader_match = LEADER_SPLIT_RE.match(cleaned)
    if leader_match:
        cleaned = leader_match.group(1).strip()

    trailing_page_match = TRAILING_PAGE_RE.match(cleaned)
    if trailing_page_match:
        cleaned = trailing_page_match.group(1).strip()

    cleaned = cleaned.strip(" \t.-")

    return cleaned or None


def extract_drug_names(text: str) -> list[str]:
    names: list[str] = []

    for raw_line in text.splitlines():
        cleaned = clean_drug_name(raw_line)
        if cleaned:
            names.append(cleaned)

    return names


def process_file(input_path: Path) -> Path:
    names = extract_drug_names(input_path.read_text(encoding="utf-8", errors="ignore"))
    output_path = input_path.with_name(f"{OUTPUT_PREFIX}{input_path.name}")
    output_text = "\n".join(names) + ("\n" if names else "")
    output_path.write_text(output_text, encoding="utf-8")
    return output_path


def main() -> None:
    cwd = Path.cwd()
    input_files = sorted(
        path for path in cwd.glob("*.txt")
        if path.is_file() and not path.name.startswith(OUTPUT_PREFIX)
    )

    if not input_files:
        raise SystemExit(f"No .txt files found in: {cwd}")

    print(f"Working directory: {cwd}")

    for input_path in input_files:
        output_path = process_file(input_path)
        print(f"{input_path.name} -> {output_path.name}")


if __name__ == "__main__":
    main()
