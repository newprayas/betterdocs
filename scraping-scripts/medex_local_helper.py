import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any
from urllib.parse import parse_qs, quote, urlparse

import requests
from lxml import html

from medex_fast_json import (
    BASE_URL,
    HEADERS,
    SECTION_IDS,
    clean,
    display_brand_name,
    extract_summary,
    fetch,
    get_alternate_brands_url,
    normalize_brand,
    normalize_choice_text,
    parse_alternate_brands,
    parse_brand_cards,
    parse_search_results,
    section_text,
)


HOST = "127.0.0.1"
PORT = 8765
PREFERRED_COMPANIES = [
    "square",
    "incepta",
    "healthcare",
    "opsonin",
    "beximco",
    "aristopharma",
    "novartis",
    "acme",
    "ziska",
    "renata",
    "radiant",
]

PREFERRED_DOSAGE_FORMS = [
    "tablet",
    "capsule",
    "tablet (enteric coated)",
    "tablet (film coated)",
    "tablet (extended release)",
    "tablet (sustained release)",
    "oral suspension",
    "syrup",
    "suspension",
    "injection",
    "infusion",
    "suppository",
    "pediatric drop",
    "drops",
]


class MedexSuggestionLookupError(LookupError):
    def __init__(self, query: str, suggestions: list[str]) -> None:
        self.query = query
        self.suggestions = suggestions
        super().__init__(f"No exact MedEx result found for '{query}'")


def normalize_company(text: str | None) -> str:
    return clean(text or "") or ""


def score_company(company: str | None) -> tuple[int, str]:
    normalized = normalize_company(company).lower()
    if not normalized:
        return (len(PREFERRED_COMPANIES) + 1, "")

    for index, preferred in enumerate(PREFERRED_COMPANIES):
        if preferred in normalized:
            return (index, normalized)
    return (len(PREFERRED_COMPANIES), normalized)


def extract_dosage_form_from_title(title: str | None) -> str:
    value = clean(title or "") or ""
    parsed = value.rsplit("(", 1)
    if len(parsed) != 2:
        return ""
    return parsed[1].replace(")", "").strip().lower()


def score_dosage_form(title: str | None) -> tuple[int, str]:
    dosage_form = extract_dosage_form_from_title(title)
    if not dosage_form:
        return (len(PREFERRED_DOSAGE_FORMS) + 1, "")

    for index, preferred in enumerate(PREFERRED_DOSAGE_FORMS):
        if preferred in dosage_form:
            return (index, dosage_form)
    return (len(PREFERRED_DOSAGE_FORMS), dosage_form)


def pick_preferred(items: list[dict[str, Any]]) -> dict[str, Any] | None:
    if not items:
        return None
    ranked = sorted(
        items,
        key=lambda item: (
            score_company(item.get("manufacturer"))[0],
            score_dosage_form(item.get("title"))[0],
            len(display_brand_name(item.get("title") or "")),
            display_brand_name(item.get("title") or "").lower(),
        ),
    )
    return ranked[0]


def build_result_suggestions(results: list[dict[str, Any]], limit: int = 8) -> list[str]:
    suggestions: list[str] = []
    seen: set[str] = set()

    for item in results:
        raw_title = item.get("title") or ""
        suggestion = display_brand_name(raw_title) or clean(raw_title) or ""
        normalized = normalize_choice_text(suggestion)
        if not normalized or normalized in seen:
            continue
        seen.add(normalized)
        suggestions.append(suggestion)
        if len(suggestions) >= limit:
            break

    return suggestions


def resolve_selected_result(results: list[dict[str, Any]], query: str) -> tuple[dict[str, Any], str]:
    if not results:
        raise LookupError("No MedEx results found")

    generic_results = [item for item in results if item.get("kind") == "generic"]
    brand_results = [item for item in results if item.get("kind") == "brand"]
    query_brand = normalize_brand(query)
    query_choice = normalize_choice_text(query)

    exact_generic_matches = [
        item
        for item in generic_results
        if normalize_choice_text(item.get("title")) == query_choice
        or normalize_brand(item.get("title")) == query_brand
    ]
    if exact_generic_matches:
        return exact_generic_matches[0], "generic"

    exact_brand_matches = [
        item
        for item in brand_results
        if item.get("brand") == query_brand
        or normalize_choice_text(display_brand_name(item.get("title"))) == query_choice
    ]
    if exact_brand_matches:
        selected = sorted(
            exact_brand_matches,
            key=lambda item: (
                score_company(item.get("manufacturer"))[0],
                score_dosage_form(item.get("title"))[0],
                exact_brand_matches.index(item),
            ),
        )[0]
        return selected, "brand"

    suggestions = build_result_suggestions(results)
    raise MedexSuggestionLookupError(query, suggestions)


def build_payload(query: str, include_alternate: bool = False) -> dict[str, Any]:
    session = requests.Session()
    session.headers.update(HEADERS)

    search_url = f"{BASE_URL}/search?search={quote(query)}"
    search_html, search_ms, search_status = fetch(session, search_url)
    search_results = parse_search_results(search_html)
    if not search_results:
        raise LookupError(f"No MedEx result found for '{query}'")

    selected_result, selected_kind = resolve_selected_result(search_results, query)
    selected_url = selected_result["url"]
    selected_title = selected_result["title"]

    page_html, page_ms, page_status = fetch(session, selected_url)
    page_tree = html.fromstring(page_html)

    payload: dict[str, Any] = {
        "query": query,
        "resolved_query": query,
        "selected_kind": selected_kind,
        "search_url": search_url,
        "search_result_count_estimate": len(search_results),
        "selected_result_title": selected_title,
        "selected_result_url": selected_url,
        "summary_above_indications": extract_summary(page_tree, selected_title),
        "sections": {
            key: section_text(page_tree, section_id)
            for key, section_id in SECTION_IDS.items()
        },
        "available_brand_names": parse_brand_cards(page_tree) if selected_kind == "generic" else [],
        "logs": {
            "search_fetch_ms": round(search_ms, 1),
            "brand_fetch_ms": round(page_ms, 1),
            "http_status": {
                "search": search_status,
                "brand": page_status,
            },
        },
    }

    if include_alternate:
        alternate_url = None
        if selected_kind == "brand":
            alternate_url = get_alternate_brands_url(page_tree)
        elif selected_kind == "generic":
            generic_href = selected_result.get("url")
            if generic_href:
                alternate_url = (
                    generic_href.rstrip("/") + "/brand-names"
                    if "/generics/" in generic_href
                    else None
                )

        if alternate_url:
            alt_html, alt_ms, _ = fetch(session, alternate_url)
            alt_tree = html.fromstring(alt_html)
            payload["alternate_brands"] = {
                "source_url": alternate_url,
                **parse_alternate_brands(alt_tree),
            }
            payload["logs"]["alternate_brands_fetch_ms"] = round(alt_ms, 1)
        else:
            payload["alternate_brands"] = None

    return payload


class MedexLocalHandler(BaseHTTPRequestHandler):
    server_version = "MedexLocalHelper/1.0"

    def log_message(self, fmt: str, *args: Any) -> None:
        return

    def _set_headers(self, status_code: int = 200) -> None:
        self.send_response(status_code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    def do_OPTIONS(self) -> None:
        self._set_headers(204)

    def do_GET(self) -> None:
        parsed = urlparse(self.path)

        if parsed.path == "/health":
            self._set_headers(200)
            self.wfile.write(json.dumps({"ok": True}).encode("utf-8"))
            return

        if parsed.path != "/query":
            self._set_headers(404)
            self.wfile.write(json.dumps({"error": "Not found"}).encode("utf-8"))
            return

        params = parse_qs(parsed.query)
        query = (params.get("q") or [""])[0].strip()
        include_alternate = (params.get("include_alternate") or ["0"])[0].strip() in {
            "1",
            "true",
            "yes",
        }

        if not query:
            self._set_headers(400)
            self.wfile.write(json.dumps({"error": "Missing q parameter"}).encode("utf-8"))
            return

        try:
            payload = build_payload(query, include_alternate=include_alternate)
            self._set_headers(200)
            self.wfile.write(
                json.dumps(payload, ensure_ascii=False).encode("utf-8")
            )
        except MedexSuggestionLookupError as error:
            self._set_headers(404)
            self.wfile.write(
                json.dumps(
                    {
                        "error": str(error),
                        "code": "no_exact_match",
                        "query": error.query,
                        "suggestions": error.suggestions,
                    }
                ).encode("utf-8")
            )
        except LookupError as error:
            self._set_headers(404)
            self.wfile.write(
                json.dumps({"error": str(error)}).encode("utf-8")
            )
        except Exception as error:
            self._set_headers(500)
            self.wfile.write(
                json.dumps({"error": str(error)}).encode("utf-8")
            )


def main() -> int:
    server = ThreadingHTTPServer((HOST, PORT), MedexLocalHandler)
    print(f"MedEx local helper running on http://{HOST}:{PORT}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
