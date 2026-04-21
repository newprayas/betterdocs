import json
import re
import sys
import time
from pathlib import Path
from urllib.parse import quote, urljoin

import requests
from lxml import html


BASE_URL = "https://medex.com.bd"
OUT_DIR = Path("medex_output")

HEADERS = {
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    "Cache-Control": "no-cache",
    "Pragma": "no-cache",
    "Connection": "keep-alive",
    "User-Agent": (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
        "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
    ),
}

SECTION_IDS = {
    "description": "description",
    "indications": "indications",
    "pharmacology": "mode_of_action",
    "dosage_and_administration": "dosage",
    "interaction": "interaction",
    "contraindications": "contraindications",
    "side_effects": "side_effects",
    "pregnancy_and_lactation": "pregnancy_cat",
    "precautions_and_warnings": "precautions",
    "overdose_effects": "overdose_effects",
}

MONEY_RE = re.compile(r"^৳\s*[\d,.]+$")
STANDARD_PRICE_LABELS = {"Unit Price:", "Strip Price:"}


def clean(text: str | None) -> str | None:
    if text is None:
        return None
    text = re.sub(r"\s+", " ", text).strip()
    return text or None


def slugify(text: str) -> str:
    slug = re.sub(r"[^A-Za-z0-9]+", "_", text.strip())
    slug = re.sub(r"_+", "_", slug).strip("_")
    return slug.lower() or "drug"


def normalize_brand(text: str | None) -> str:
    text = clean(text) or ""
    text = re.sub(r"\s*\(.*?\)\s*$", "", text)
    text = re.sub(r"\s+\d.*$", "", text)
    return text.lower().strip()


def display_brand_name(text: str | None) -> str:
    text = clean(text) or ""
    text = re.sub(r"\s*\(.*?\)\s*$", "", text)
    text = re.sub(r"\s+\d.*$", "", text)
    return text.strip()


def normalize_choice_text(text: str | None) -> str:
    text = clean(text) or ""
    text = re.sub(r"\s+", " ", text).strip().lower()
    return text


def fetch(session: requests.Session, url: str) -> tuple[str, float, int]:
    start = time.perf_counter()
    resp = session.get(url, timeout=20)
    elapsed_ms = (time.perf_counter() - start) * 1000
    resp.raise_for_status()
    return resp.text, elapsed_ms, resp.status_code


def parse_search_results(search_html: str) -> list[dict]:
    tree = html.fromstring(search_html)
    results: list[dict] = []
    seen: set[str] = set()

    for row in tree.xpath('//div[contains(@class,"search-result-row")]'):
        title = clean(row.xpath('string(.//div[contains(@class,"search-result-title")]//a[1])'))
        href = row.xpath('string(.//div[contains(@class,"search-result-title")]//a[1]/@href)')
        if not title or not href or ("/brands/" not in href and "/generics/" not in href):
            continue

        url = href if href.startswith("http") else urljoin(BASE_URL, href)
        if url in seen:
            continue
        seen.add(url)

        description = clean(row.xpath("string(.//p[1])"))
        company = None
        if description:
            m = re.search(r"is manufactured by (.+?)(?:\.)?$", description, re.I)
            if m:
                company = clean(m.group(1))

        kind = "generic" if "/generics/" in url else "brand"

        results.append(
            {
                "url": url,
                "title": title,
                "brand": normalize_brand(title),
                "description": description,
                "manufacturer": company,
                "kind": kind,
            }
        )

    return results


def choose_search_result(
    session: requests.Session, initial_query: str
) -> tuple[str, str, list[dict], dict, list[dict], str]:
    attempts: list[dict] = []
    query = initial_query
    selected_kind = "brand"

    while True:
        search_url = f"{BASE_URL}/search?search={quote(query)}"
        search_html, search_ms, search_status = fetch(session, search_url)
        results = parse_search_results(search_html)
        attempts.append(
            {
                "query": query,
                "search_url": search_url,
                "search_result_count_estimate": len(results),
                "search_fetch_ms": round(search_ms, 1),
                "http_status": search_status,
            }
        )

        if not results:
            print("No brand result found.")
            query = input("Type the correct brand name : ").strip()
            if not query:
                raise SystemExit(2)
            continue

        generic_results = [item for item in results if item.get("kind") == "generic"]
        if len(generic_results) == 1:
            selected_kind = "generic"
            return query, search_url, results, generic_results[0], attempts, selected_kind
        if len(generic_results) > 1:
            print()
            print("I found many generic options.")
            print("Which one do you mean?")
            for index, item in enumerate(generic_results, 1):
                print(f"{index}. {item['title']}")
            while True:
                print()
                choice = input("Type a number, or type the exact generic name : ").strip()
                if not choice:
                    raise SystemExit(2)
                if choice.isdigit():
                    picked = int(choice)
                    if 1 <= picked <= len(generic_results):
                        selected = generic_results[picked - 1]
                        selected_kind = "generic"
                        return query, search_url, results, selected, attempts, selected_kind
                    print("Invalid number.")
                    continue
                exact_generic = [
                    item for item in generic_results if normalize_choice_text(item["title"]) == normalize_choice_text(choice)
                ]
                if exact_generic:
                    selected = exact_generic[0]
                    selected_kind = "generic"
                    return query, search_url, results, selected, attempts, selected_kind
                print("No exact generic match in the list.")
                continue

        query_brand = normalize_brand(query)
        unique_brands = {item["brand"] for item in results if item.get("brand")}
        exact_brand_matches = [item for item in results if item.get("brand") == query_brand]

        if len(unique_brands) == 1 or exact_brand_matches:
            selected = exact_brand_matches[0] if exact_brand_matches else results[0]
            selected_kind = selected.get("kind") or "brand"
            return query, search_url, results, selected, attempts, selected_kind

        print()
        print("I found many brand options.")
        print("Which one do you mean?")
        for index, item in enumerate(results[:10], 1):
            print(f"{index}. {display_brand_name(item['title'])}")
        print()
        choice = input("Type a number, or type the correct brand name to search again : ").strip()
        if not choice:
            raise SystemExit(2)
        if choice.isdigit():
            picked = int(choice)
            if 1 <= picked <= min(len(results), 10):
                selected = results[picked - 1]
                selected_kind = selected.get("kind") or "brand"
                return query, search_url, results, selected, attempts, selected_kind
            print("Invalid number.")
            continue
        query = choice


def section_text(tree: html.HtmlElement, section_id: str) -> str | None:
    nodes = tree.xpath(
        f'//div[@id="{section_id}"]/following-sibling::div[contains(@class,"ac-body")][1]'
    )
    if not nodes:
        return None
    node = nodes[0]

    def walk(elem):
        parts: list[str] = []

        def recurse(current):
            tag = getattr(current, "tag", None)
            if current.text:
                parts.append(current.text)
            for child in current:
                child_tag = getattr(child, "tag", None)
                if isinstance(child_tag, str) and child_tag.lower() in {"p", "div", "li", "br"}:
                    if parts and not parts[-1].endswith("\n"):
                        parts.append("\n")
                recurse(child)
                if isinstance(child_tag, str) and child_tag.lower() in {"p", "div", "li", "br"}:
                    if not parts or not parts[-1].endswith("\n"):
                        parts.append("\n")
                if child.tail:
                    parts.append(child.tail)

        recurse(elem)
        text = "".join(parts)
        lines = [re.sub(r"[ \t]+", " ", line).strip() for line in text.splitlines()]
        lines = [line for line in lines if line]
        return "\n".join(lines).strip() or None

    return walk(node)


def price_text(value: str | None) -> str | None:
    if value is None:
        return None
    value = clean(value)
    if not value:
        return None
    if value.startswith("৳"):
        return value
    return f"৳ {value}"


def parse_brand_cards(tree: html.HtmlElement) -> list[dict]:
    cards: list[dict] = []
    for item in tree.xpath('//div[contains(@class,"available-brands-default")]//div[contains(@class,"available-brands")]'):
        brand_name = clean(item.xpath('string(.//div[contains(@class,"data-row-top")][1])'))
        strength = clean(item.xpath('string(.//div[contains(@class,"data-row-strength")][1])'))
        company = clean(item.xpath('string(.//div[contains(@class,"data-row-company")][1])'))
        price_block = clean(item.xpath('string(.//div[contains(@class,"packages-wrapper")][1])'))

        price_label = None
        price_value = None
        pack_size_info = None
        if price_block:
            m = re.match(r"^(.*?):\s*৳\s*([\d,.]+)\s*$", price_block)
            if m:
                price_label = clean(m.group(1))
                price_value = f"৳ {m.group(2)}"
            else:
                m = re.match(r"^(.*?)\s*:\s*(.*)$", price_block)
                if m:
                    price_label = clean(m.group(1))
                    rest = clean(m.group(2))
                    if rest and "৳" in rest:
                        price_value = rest if rest.startswith("৳") else f"৳ {rest.replace('৳', '').strip()}"
                    else:
                        pack_size_info = rest

        cards.append(
            {
                "brand_name": brand_name,
                "strength": strength,
                "company": company,
                "price_label": price_label,
                "price_bdt": price_value.replace("৳", "").strip() if price_value else None,
                "price_text": price_value,
                "pack_size_info": pack_size_info,
            }
        )

    return cards


def parse_alternate_brands(tree: html.HtmlElement) -> dict:
    page_title = clean(tree.xpath('string(//h1[1])'))
    if page_title:
        page_title = page_title.replace(" Available Brands", "").strip()

    rows = []
    for row in tree.xpath('//table[contains(@class,"bindex-table")]//tr[contains(@class,"brand-row")]'):
        cells = row.xpath("./td")
        if len(cells) < 5:
            continue

        brand_name = clean(cells[0].text_content())
        dosage_form = clean(cells[1].text_content())
        strength = clean(cells[2].text_content())
        company = clean(cells[3].text_content())
        price_text_raw = clean(cells[4].text_content())
        brand_url = row.get("data-href")

        price_label = None
        unit_price_bdt = None
        pack_size_info = None
        if price_text_raw:
            m = re.search(r"^(Unit Price:)\s*৳\s*([\d,.]+)\s*(.*)$", price_text_raw)
            if m:
                price_label = "Unit Price"
                unit_price_bdt = m.group(2)
                tail = clean(m.group(3))
                if tail:
                    pack_size_info = tail
            else:
                m = re.search(r"^(.+?):\s*৳\s*([\d,.]+)\s*(.*)$", price_text_raw)
                if m:
                    price_label = clean(m.group(1))
                    unit_price_bdt = m.group(2)
                    tail = clean(m.group(3))
                    if tail:
                        pack_size_info = tail

        rows.append(
            {
                "brand_name": brand_name,
                "dosage_form": dosage_form,
                "strength": strength,
                "company": company,
                "brand_url": brand_url,
                "price_label": price_label,
                "unit_price_bdt": unit_price_bdt,
                "pack_size_info": pack_size_info,
                "price_text": price_text_raw,
            }
        )

    grouped: dict[str, dict] = {}
    for row in rows:
        company = row.get("company") or "Unknown Company"
        dosage_form = row.get("dosage_form") or "Unknown Dosage Form"
        company_bucket = grouped.setdefault(company, {"company": company, "dosage_forms": {}})
        dosage_bucket = company_bucket["dosage_forms"].setdefault(
            dosage_form,
            {"dosage_form": dosage_form, "brands": []},
        )
        dosage_bucket["brands"].append(row)

    grouped_list = []
    for company_bucket in grouped.values():
        dosage_forms = list(company_bucket["dosage_forms"].values())
        company_bucket["dosage_forms"] = dosage_forms
        grouped_list.append(company_bucket)

    return {
        "page_title": page_title,
        "rows": rows,
        "grouped_by_company": grouped_list,
    }


def get_alternate_brands_url(tree: html.HtmlElement) -> str | None:
    href = tree.xpath('string(//a[contains(@href,"/brand-names")][1]/@href)')
    if not href:
        return None
    return href if href.startswith("http") else urljoin(BASE_URL, href)


def parse_packages(tree: html.HtmlElement) -> list[dict]:
    packages: list[dict] = []
    containers = tree.xpath('//div[contains(@class,"package-container")]')

    for container in containers:
        current: dict = {}
        for span in container.xpath("./span"):
            text = clean(span.text_content())
            if not text:
                continue

            classes = span.get("class") or ""
            is_money = bool(MONEY_RE.match(text))
            is_pack_info = "pack-size-info" in classes or (text.startswith("(") and "৳" in text)
            is_label = not is_money and not is_pack_info

            if is_label:
                if current.get("label") and current.get("price_text"):
                    packages.append(current)
                    current = {}

                current.setdefault("label", text.rstrip(":").strip())
                if text in STANDARD_PRICE_LABELS:
                    current["price_kind"] = text.rstrip(":").strip().lower().replace(" ", "_")
                continue

            if is_money:
                current["price_text"] = text
                current["price_bdt"] = text.replace("৳", "").strip()
                continue

            if is_pack_info:
                current["pack_size_info"] = text
                continue

        if current.get("label") or current.get("price_text") or current.get("pack_size_info"):
            packages.append(current)

    cleaned: list[dict] = []
    seen = set()
    for pkg in packages:
        label = pkg.get("label")
        price = pkg.get("price_text")
        pack_size = pkg.get("pack_size_info")
        key = (label, price, pack_size)
        if not label and not price and not pack_size:
            continue
        if key in seen:
            continue
        seen.add(key)
        cleaned.append(pkg)
    return cleaned


def extract_summary(tree: html.HtmlElement, selected_title: str | None) -> dict:
    h1 = clean(tree.xpath('string(//h1[1])'))
    dosage_form = clean(tree.xpath('string(//small[@title="Dosage Form"][1])'))
    generic = clean(tree.xpath('string(//*[@title="Generic Name"][1])'))
    if not generic:
        generic = clean(tree.xpath('string(//a[contains(@href,"/generics/")][1])'))
    if not generic or generic.lower() == "available brands":
        if selected_title:
            generic = re.sub(r"\s*\(.*?\)\s*$", "", selected_title).strip()
    manufacturer = clean(tree.xpath('string(//*[@title="Manufactured by"][1])'))
    if not manufacturer:
        manufacturer = clean(tree.xpath('string(//a[contains(@href,"/companies/")][1])'))

    strength = clean(tree.xpath('string(//*[@title="Strength"][1])'))
    if not strength and selected_title:
        m = re.search(r"(\d+\s*mg(?:/vial)?)", selected_title, re.I)
        if m:
            strength = m.group(1)

    packages = parse_packages(tree)

    unit_price = None
    strip_price = None
    for pkg in packages:
        label = (pkg.get("label") or "").lower()
        if label == "unit price" and not unit_price:
            unit_price = pkg.get("price_text")
        if label == "strip price" and not strip_price:
            strip_price = pkg.get("price_text")

    if not unit_price:
        unit_price = clean("".join(tree.xpath('//span[contains(text(),"Unit Price")]/following-sibling::span[1]/text()')))
    if not strip_price:
        strip_price = clean("".join(tree.xpath('//span[contains(text(),"Strip Price")]/following-sibling::span[1]/text()')))

    available_as = [clean(a.text_content()) for a in tree.xpath('//a[contains(@class,"btn-sibling-brands")]')]
    available_as = [item for item in available_as if item]

    return {
        "display_name": h1,
        "dosage_form": dosage_form,
        "generic_name": generic,
        "manufacturer": manufacturer,
        "strength": strength,
        "unit_price_bdt": price_text(unit_price),
        "strip_price_bdt": price_text(strip_price),
        "pricing": {
            "unit_price_bdt": price_text(unit_price),
            "strip_price_bdt": price_text(strip_price),
            "packages": packages,
        },
        "available_as": available_as,
    }


def main() -> int:
    query = input("Name of drug : ").strip()
    if not query:
        print("No drug name entered.")
        return 1

    session = requests.Session()
    session.headers.update(HEADERS)

    started = time.perf_counter()

    resolved_query, search_url, search_results, selected_result, attempts, selected_kind = choose_search_result(session, query)
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    out_name = f"{slugify(resolved_query)}.json"
    if selected_kind == "generic":
        out_name = f"generic_{slugify(resolved_query)}.json"
    out_path = OUT_DIR / out_name
    selected_url = selected_result["url"]
    selected_title = selected_result["title"]
    result_count = len(search_results)
    search_ms = attempts[-1]["search_fetch_ms"]
    search_status = attempts[-1]["http_status"]

    brand_html, brand_ms, brand_status = fetch(session, selected_url)
    brand_tree = html.fromstring(brand_html)

    summary = extract_summary(brand_tree, selected_title)
    sections = {
        key: section_text(brand_tree, section_id)
        for key, section_id in SECTION_IDS.items()
    }
    available_brand_names = parse_brand_cards(brand_tree) if selected_kind == "generic" else []

    payload = {
        "query": query,
        "resolved_query": resolved_query,
        "selected_kind": selected_kind,
        "search_url": search_url,
        "search_result_count_estimate": result_count,
        "selected_result_title": selected_title,
        "selected_result_url": selected_url,
        "summary_above_indications": summary,
        "sections": sections,
        "available_brand_names": available_brand_names,
        "logs": {
            "search_fetch_ms": round(search_ms, 1),
            "brand_fetch_ms": round(brand_ms, 1),
            "total_ms": round((time.perf_counter() - started) * 1000, 1),
            "search_attempts": attempts,
            "http_status": {
                "search": search_status,
                "brand": brand_status,
            },
        },
    }

    out_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"Saved: {out_path}")

    alternate_fetch_ms = None
    if selected_kind == "brand":
        wants_other_brands = input("Want other brands for this drug? (y/N) : ").strip().lower()
        if wants_other_brands in {"y", "yes"}:
            alt_url = get_alternate_brands_url(brand_tree)
            if alt_url:
                alt_html, alternate_fetch_ms, _ = fetch(session, alt_url)
                alt_tree = html.fromstring(alt_html)
                payload["alternate_brands"] = {
                    "source_url": alt_url,
                    **parse_alternate_brands(alt_tree),
                }
                out_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
                print(f"Updated with alternate brands: {out_path}")
            else:
                payload["alternate_brands"] = None
                out_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
                print(f"Updated with alternate brands: {out_path}")

    if alternate_fetch_ms is not None:
        payload["logs"]["alternate_brands_fetch_ms"] = round(alternate_fetch_ms, 1)
        out_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")

    print(f"Search fetch ms: {round(search_ms, 1)}")
    print(f"Brand fetch ms: {round(brand_ms, 1)}")
    print(f"Total ms: {round((time.perf_counter() - started) * 1000, 1)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
