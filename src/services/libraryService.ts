import { LibraryItem } from '@/types/library';

// ---------------- CONFIGURATION ----------------
/*
  Mirror behavior summary (previous setup):
  - MIRRORS had 4 Hugging Face dataset endpoints.
  - `currentMirrorIndex` started at a random mirror to spread load.
  - `downloadAndParseBook` tried mirrors in round-robin order on failure.
  - `rotateMirror()` advanced the starting mirror after each successful download.

  Quick revert guide:
  - Put the other mirror URLs back into MIRRORS.
  - Change `currentMirrorIndex` back to:
      Math.floor(Math.random() * MIRRORS.length)
*/
const MIRRORS = [
  "https://huggingface.co/datasets/AIlabstar1/vector-datasets-prodV4/resolve/main"
];

// Rotation effectively disabled because only one mirror is configured.
let currentMirrorIndex = 0;

/**
 * Rotates to the next mirror in the list (Round-Robin)
 */
const rotateMirror = () => {
  currentMirrorIndex = (currentMirrorIndex + 1) % MIRRORS.length;
};

/**
 * Gets a specific mirror URL by index
 */
const getMirrorUrl = (index: number) => {
  return MIRRORS[index % MIRRORS.length];
};
// -----------------------------------------------

// Embedded library catalog (not hosted externally for obscurity)
const LIBRARY_CATALOG = [
  {
    "id": "newdoc_voyage",
    "name": "voyage_masud",
    "filename": "totest.bin",
    "size": "2.9 MB",
    "category": "Ophthalmology"
  }
];

export const libraryService = {
  /**
   * Returns the embedded library catalog with full download URLs
   * (No external fetch - catalog is embedded in code for obscurity)
   */
  async getAvailableBooks(): Promise<LibraryItem[]> {
    // Return items with a placeholder URL, the actual URL is determined at download time
    return LIBRARY_CATALOG.map((item) => ({
      ...item,
      // We attach the filename as the URL so that the frontend code doesn't break
      // But the actual download function will ignore this usage and use the mirrors
      url: item.filename
    }));
  },

  /**
   * Downloads and parses a .bin shard file (gzip compressed JSON)
   * Uses the browser's native DecompressionStream for performance
   */
  async downloadAndParseBook(filenameOrUrl: string): Promise<any> {
    // Extract filename from URL if a full URL was passed (legacy compatibility)
    const filename = filenameOrUrl.split('/').pop() || filenameOrUrl;

    // Try all configured mirrors (currently 1)
    for (let attempt = 0; attempt < MIRRORS.length; attempt++) {
      // Logic:
      // 1. Get the current mirror index (Round-Robin)
      // 2. Add 'attempt' offset so if we fail, we try the NEXT mirror in the list cyclically
      const mirrorIndex = (currentMirrorIndex + attempt) % MIRRORS.length;
      const mirrorBaseUrl = getMirrorUrl(mirrorIndex);
      const url = `${mirrorBaseUrl}/${filename}`;

      console.log(`[Library] ⬇️ Downloading "${filename}" from Mirror #${mirrorIndex + 1} (${mirrorBaseUrl})...`);

      try {
        const response = await fetch(url);

        if (!response.ok) {
          throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }
        if (!response.body) {
          throw new Error("ReadableStream not supported by browser");
        }

        // 1. Create a stream for decompression
        const ds = new DecompressionStream('gzip');

        // 2. Pipe the download stream through the decompressor
        const decompressedStream = response.body.pipeThrough(ds);

        // 3. Convert the stream into a Response object to easily parse JSON
        const jsonResponse = new Response(decompressedStream);

        console.log(`[Library] ✅ Decompression complete, parsing JSON...`);
        const result = await jsonResponse.json();

        // SUCCESS! Rotate the global mirror index once so the NEXT book
        // starts with the next mirror in the sequence (Load Balancing)
        rotateMirror();

        return result;

      } catch (err) {
        console.warn(`[Library] ⚠️ Mirror #${mirrorIndex + 1} failed for "${filename}":`, err);

        // If this was the last mirror, throw the error to the caller
        if (attempt === MIRRORS.length - 1) {
          console.error(`[Library] ❌ All ${MIRRORS.length} mirrors failed for "${filename}". Giving up.`);
          throw new Error(`Failed to download book after trying all mirrors. Last error: ${err}`);
        }

        console.log(`[Library] 🔄 Switching to next mirror...`);
      }
    }
  }
};
