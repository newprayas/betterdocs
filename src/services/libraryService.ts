import { LibraryItem } from '@/types/library';

// ---------------- CONFIGURATION ----------------
const HF_USER = 'prayas12'; 
const HF_REPO = 'meddy-library';
// "resolve/main" ensures we get the raw file from the latest commit
const BASE_URL = `https://huggingface.co/datasets/${HF_USER}/${HF_REPO}/resolve/main`;
// -----------------------------------------------

export const libraryService = {
  /**
   * Fetches the list of available books from library.json
   */
  async getAvailableBooks(): Promise<LibraryItem[]> {
    try {
      const response = await fetch(`${BASE_URL}/library.json`);
      
      if (!response.ok) {
        throw new Error(`Failed to fetch library index: ${response.statusText}`);
      }
      
      const data = await response.json();
      
      // Map the raw JSON to include the full download URL
      return data.map((item: any) => ({
        ...item,
        url: `${BASE_URL}/${item.filename}`
      }));
    } catch (error) {
      console.error("Library Index Error:", error);
      throw error;
    }
  },

  /**
   * Downloads and decompresses a .json.gz file directly into a JSON object
   * Uses the browser's native DecompressionStream for performance
   */
  async downloadAndParseBook(url: string): Promise<any> {
    console.log(`[Library] Starting download: ${url}`);
    const response = await fetch(url);
    
    if (!response.ok) throw new Error(`Download failed: ${response.statusText}`);
    if (!response.body) throw new Error("ReadableStream not supported by browser");

    // 1. Create a stream for decompression
    const ds = new DecompressionStream('gzip');
    
    // 2. Pipe the download stream through the decompressor
    const decompressedStream = response.body.pipeThrough(ds);
    
    // 3. Convert the stream into a Response object to easily parse JSON
    // This prevents having to buffer the whole string in JS memory manually
    const jsonResponse = new Response(decompressedStream);
    
    console.log(`[Library] Decompression complete, parsing JSON...`);
    return await jsonResponse.json();
  }
};