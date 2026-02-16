import os
import glob
import json
import time
import requests
import fitz  # PyMuPDF
import uuid
import argparse
import datetime
from dotenv import load_dotenv

# Load environment variables (optional; script will still prompt for key)
load_dotenv()

# Voyage settings
EMBEDDING_MODEL = "voyage-4-large"
VOYAGE_EMBEDDINGS_URL = "https://api.voyageai.com/v1/embeddings"

def get_api_key():
    """Prompts the user for the Voyage API key."""
    api_key = input("Please enter your Voyage API Key: ").strip()
    if not api_key:
        print("❌ Error: API Key cannot be empty.")
        exit(1)
    return api_key

def extract_pages_from_pdf(pdf_path):
    """Extracts text from a PDF file page by page."""
    try:
        doc = fitz.open(pdf_path)
        pages = []
        for i, page in enumerate(doc):
            text = page.get_text()
            if text.strip():
                pages.append({"text": text, "page_number": i + 1})
        return pages, len(doc)
    except Exception as e:
        print(f"Error reading {pdf_path}: {e}")
        return [], 0

def chunk_text_with_page_context(pages, chunk_size=1000, overlap=200):
    """Splits pages into overlapping chunks while preserving page metadata."""
    chunks = []
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

def get_batch_embeddings(texts, api_key, max_retries=8):
    """
    Generates embeddings for a batch of text chunks using Voyage embeddings API.
    Voyage endpoint: POST https://api.voyageai.com/v1/embeddings
    Request body: { "input": [..], "model": "voyage-4-large" }
    Response body: { "data": [ { "embedding": [...], "index": 0 }, ... ], ... }
    """
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }

    payload = {
        "input": texts,
        "model": EMBEDDING_MODEL,
    }

    for attempt in range(max_retries):
        try:
            response = requests.post(
                VOYAGE_EMBEDDINGS_URL,
                headers=headers,
                json=payload,
                timeout=60,
            )

            # Handle rate limiting explicitly
            if response.status_code == 429:
                wait_s = min(60, 2 ** attempt)  # exponential backoff up to 60s
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

            # Ensure embeddings are returned in correct order by index
            data_sorted = sorted(data, key=lambda x: x.get("index", 0))
            embeddings = [item.get("embedding") for item in data_sorted]

            if any(e is None for e in embeddings):
                return None

            return embeddings

        except requests.RequestException as e:
            # network / timeout / HTTP errors after raise_for_status
            if attempt < max_retries - 1:
                wait_s = min(60, 2 ** attempt)
                print(f"\nError generating batch embedding: {e}\nRetrying in {wait_s}s...")
                time.sleep(wait_s)
                continue
            print(f"\nError generating batch embedding: {e}")
            return None

    return None

def process_pdfs():
    """Main function to process all PDFs in the current directory or target directory."""
    parser = argparse.ArgumentParser(description="Process PDFs to generate embeddings (Voyage AI).")
    parser.add_argument("directory", nargs="?", default=".", help="Target directory containing PDF files")
    args = parser.parse_args()

    target_dir = args.directory
    if not os.path.isdir(target_dir):
        print(f"❌ Error: Directory '{target_dir}' does not exist.")
        return

    voyage_api_key = get_api_key()

    # Search for PDFs in the target directory
    search_path = os.path.join(target_dir, "*.pdf")
    pdf_files = glob.glob(search_path)

    if not pdf_files:
        print(f"No PDF files found in: {os.path.abspath(target_dir)}")
        return

    print(f"Found {len(pdf_files)} PDF files in '{target_dir}'. Processing...")

    batch_session_id = str(uuid.uuid4())
    BATCH_SIZE = 100  # keep same logic; Voyage supports lists in one call

    for pdf_file_path in pdf_files:
        pdf_filename = os.path.basename(pdf_file_path)
        print(f"\n📄 Processing: {pdf_filename}")

        # File Stats
        file_stats = os.stat(pdf_file_path)
        file_size = file_stats.st_size
        created_at = datetime.datetime.fromtimestamp(file_stats.st_ctime).isoformat() + "Z"

        # 1. Extract Pages
        pages, total_pages = extract_pages_from_pdf(pdf_file_path)
        if not pages:
            continue

        # 2. Chunk Text
        CHUNK_SIZE = 1000
        CHUNK_OVERLAP = 200
        raw_chunks = chunk_text_with_page_context(pages, chunk_size=CHUNK_SIZE, overlap=CHUNK_OVERLAP)

        print(f"   -> Split into {len(raw_chunks)} chunks.")

        processed_chunks = []
        document_id = str(uuid.uuid4())

        # 3. Generate Embeddings (Batch Mode)
        print("   -> Generating embeddings (Batch Mode)...")

        total_chunks = len(raw_chunks)
        for i in range(0, total_chunks, BATCH_SIZE):
            batch_end = min(i + BATCH_SIZE, total_chunks)
            current_batch = raw_chunks[i:batch_end]

            print(
                f"   ⏳ Batch {i//BATCH_SIZE + 1}: Chunks {i+1}-{batch_end}...",
                end="\r",
                flush=True,
            )

            batch_texts = [c["text"] for c in current_batch]
            batch_embeddings = get_batch_embeddings(batch_texts, voyage_api_key)

            if batch_embeddings and len(batch_embeddings) == len(current_batch):
                for j, embedding in enumerate(batch_embeddings):
                    chunk_data = current_batch[j]
                    global_index = i + j

                    processed_chunk = {
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
                    processed_chunks.append(processed_chunk)
            else:
                print(f"\n   ⚠️ Batch failed or partial result for chunks {i+1}-{batch_end}")

            # Small safety delay between batches (keep same logic)
            time.sleep(1)

        print("")  # Newline

        # 4. Save JSON
        output_filename = f"{pdf_filename}_processed_export.json"
        output_path = os.path.join(target_dir, output_filename)

        current_time = datetime.datetime.now(datetime.timezone.utc).isoformat().replace("+00:00", "Z")

        output_data = {
            "format_version": "1.0",
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
                    "chunk_size": CHUNK_SIZE,
                    "chunk_overlap": CHUNK_OVERLAP,
                },
            },
            "chunks": processed_chunks,
        }

        with open(output_path, "w", encoding="utf-8") as f:
            json.dump(output_data, f, indent=2, ensure_ascii=False)

        print(f"✅ Saved embeddings to: {output_path}")

if __name__ == "__main__":
    process_pdfs()
