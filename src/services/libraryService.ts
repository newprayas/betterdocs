import { LibraryItem } from '@/types/library';
import type { RouteCompanionPayload } from '@/types';

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

const parseGzipJsonResponse = async (response: Response): Promise<any> => {
  if (!response.body) {
    throw new Error("ReadableStream not supported by browser");
  }

  const ds = new DecompressionStream('gzip');
  const decompressedStream = response.body.pipeThrough(ds);
  const jsonResponse = new Response(decompressedStream);
  return jsonResponse.json();
};

const getCompanionFilename = (filenameOrUrl: string): string => {
  const baseFilename = filenameOrUrl.split('/').pop() || filenameOrUrl;
  const dotIndex = baseFilename.lastIndexOf('.');
  const stem = dotIndex > 0 ? baseFilename.slice(0, dotIndex) : baseFilename;
  return `${stem}_comp.bin`;
};

const arrayBufferToBase64 = (buffer: ArrayBuffer): string => {
  let binary = '';
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
};

const downloadBinaryAsBase64 = async (url: string): Promise<string> => {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed ANN artifact download: ${response.status} ${response.statusText}`);
  }
  const buffer = await response.arrayBuffer();
  return arrayBufferToBase64(buffer);
};

const downloadIdMap = async (url: string): Promise<string[]> => {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed ANN id-map download: ${response.status} ${response.statusText}`);
  }

  if (!response.body) {
    throw new Error('ReadableStream not available for ANN id-map');
  }

  const isGzip = url.endsWith('.gz') || url.endsWith('.gzip');
  let textResponse: Response;

  if (isGzip) {
    const ds = new DecompressionStream('gzip');
    textResponse = new Response(response.body.pipeThrough(ds));
  } else {
    textResponse = new Response(response.body);
  }

  const json = await textResponse.json();
  if (!Array.isArray(json) || json.some((v) => typeof v !== 'string')) {
    throw new Error('ANN id-map payload is invalid');
  }

  return json;
};

//shard_4a8.bin

// Embedded library catalog (not hosted externally for obscurity)
const LIBRARY_CATALOG = [

  {
    "id": "youtube_lectures_prof_masud_sir223",
    "name": "Youtube lectures Prof Masud sir",
    "filename": "shard_7x3.bin",
    "size": "2.7 MB",
    "category": "🎉 Special notes"
  },
  {
    "id": "bailey_love_28ed",
    "name": "Bailey - Love Short Practice of Surgery 28th Edition",
    "filename": "shard_5x6.bin",
    "size": "46.5 MB",
    "category": "Surgery"
  },
  {
    "id": "davidson_medicine_24th",
    "name": "Davidson Medicine 24th edition",
    "filename": "shard_3a1.bin",
    "size": "50.1 MB",
    "category": "Medicine"
  },
  {
    "id": "gynae_dutta_9ed",
    "name": "Gynae DC Dutta's 9th Edition Textbook of Gynecology",
    "filename": "shard_9v4.bin",
    "size": "17.8 MB",
    "category": "Obs and Gyne"
  },
  {
    "id": "srb_manual_surgery_6ed",
    "name": "SRB Manual of Surgery 6th Edition",
    "filename": "shard_0v8.bin",
    "size": "29.1 MB",
    "category": "Surgery"
  },
  {
    "id": "hamilton_bailey_physical_signs",
    "name": "Hamilton Baileys Clinical Surgery 19 Edition",
    "filename": "shard_9s1.bin",
    "size": "14.3 MB",
    "category": "Surgery"
  },
  {
    "id": "norman_browse_6th_ed",
    "name": "Norman Browse Sign Symptoms of Surgical Disease 6th Edition",
    "filename": "shard_9q2.bin",
    "size": "12.1 MB",
    "category": "Surgery"
  },
  {
    "id": "dc_dutta_obs",
    "name": "DC dutta Textbook of Obstetrics 10th edition",
    "filename": "shard_8x9.bin",
    "size": "19.9 MB",
    "category": "Obs and Gyne"
  },
  {
    "id": "dermatology_std_synopsis",
    "name": "Illustrated-Synopsis-of-Dermatology-and-Sexually-Transmitted-Diseases.pdf",
    "filename": "shard_6i5.bin",
    "size": "7.1 MB",
    "category": "Dermatology"
  },
  {
    "id": "kanski_ophthal_10ed",
    "name": "Kanski's Clinical Ophthalmology A Systematic Approach 10th ed",
    "filename": "shard_0z9.bin",
    "size": "18.6 MB",
    "category": "Ophthalmology"
  },
  {
    "id": "macleod_15ed_medicine",
    "name": "Maceod 15h ed medicine",
    "filename": "shard_5a3.bin",
    "size": "9.1 MB",
    "category": "Medicine"
  },
  {
    "id": "ogsb_2021_guidelines",
    "name": "OGSB 2021 guidelines",
    "filename": "shard_2l1.bin",
    "size": "2.0 MB",
    "category": "Obs and Gyne"
  },
  {
    "id": "combined_ward_notes_2025",
    "name": "✅ All Ward / Block notes 62 batch - whole year",
    "filename": "shard_0o8.bin",
    "size": "9.8 MB",
    "category": "🎉 Special notes"
  },
  {
    "id": "combined_notes_lectures",
    "name": "✅ All Lecture notes 62 batch - whole year",
    "filename": "shard_7a5.bin",
    "size": "13.8 MB",
    "category": "🎉 Special notes"
  },
  {
    "id": "combined_notes_vol_2_drive",
    "name": "✅ FINAL PROF WRITTEN NOTES FULL",
    "filename": "shard_2i2.bin",
    "size": "31.5 MB",
    "category": "🎉 Special notes"
  },
  {
    "id": "oxford_handbook_medicine_11ed",
    "name": "Oxford Handbook of Clinical Medicine 11th Edition",
    "filename": "shard_8o8.bin",
    "size": "18.8 MB",
    "category": "Medicine"
  },
  {
    "id": "basak_essentials_ophthalmology_6ed",
    "name": "Basak Essentials of Ophthalmology 6 edition",
    "filename": "shard_9r1.bin",
    "size": "9.2 MB",
    "category": "Ophthalmology"
  },
  {
    "id": "joynal_sir_eye_notes",
    "name": "Joynal Sir Eye Lecture Notes",
    "filename": "shard_2o1.bin",
    "size": "1.8 MB",
    "category": "🎉 Special notes"
  },
  {
    "id": "apleys_orthopaedics_10ed",
    "name": "Apleys 10 edition",
    "filename": "shard_5k3.bin",
    "size": "25.0 MB",
    "category": "Orthopedics"
  },
  {
    "id": "ebnezar_rakesh_orthopedics",
    "name": "Ebnezar and Rakesh Textbook of Orthopedics 5th edition",
    "filename": "shard_9s6.bin",
    "size": "14.4 MB",
    "category": "Orthopedics"
  },
  {
    "id": "gomellas_neonatology_8ed",
    "name": "Gomellas Neonatology 8 edition",
    "filename": "shard_9z5.bin",
    "size": "33.7 MB",
    "category": "Pediatrics"
  },
  {
    "id": "bangladesh_formulary_2019",
    "name": "Bangladesh National Formulary 2019 edition",
    "filename": "shard_6s5.bin",
    "size": "21.2 MB",
    "category": "Pharmacology"
  },
  {
    "id": "step_to_paediatrics_mollah_5ed",
    "name": "Step on to Paediatrics by Md Abid Hossain Mollah 5 edition",
    "filename": "shard_6m4.bin",
    "size": "7.7 MB",
    "category": "Pediatrics"
  },
  {
    "id": "passmedicine_high_yield_textbook",
    "name": "All Passmedicine High Yield Textbook MRCP part 1 2025",
    "filename": "shard_4v0.bin",
    "size": "24.4 MB",
    "category": "MRCP"
  },
  {
    "id": "goldman_cecil_medicine_2vol",
    "name": "Lee Goldman Kathleen A Cooney Goldman Medicine 2 Volume 22 edition",
    "filename": "Small_shard_2d6.bin",
    "size": "179.5 MB",
    "category": "Medicine"
  },
  {
    "id": "first_aid_usmle_step1_2025",
    "name": "First Aid USMLE Step 1 2025 McGraw",
    "filename": "shard_3k8.bin",
    "size": "15.3 MB",
    "category": "USMLE"
  }
];

export const getLibraryBookNameById = (bookId: string): string | undefined => {
  return LIBRARY_CATALOG.find((item) => item.id === bookId)?.name;
};

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
        console.log(`[Library] ✅ Decompression complete, parsing JSON...`);
        const result = await parseGzipJsonResponse(response);

        // Try to hydrate ANN payload if metadata exists (non-blocking)
        if (result?.ann_index && !result.ann_index.artifact_base64) {
          const ann = result.ann_index;
          if (ann.artifact_name) {
            try {
              const annUrl = `${mirrorBaseUrl}/${ann.artifact_name}`;
              ann.artifact_base64 = await downloadBinaryAsBase64(annUrl);
              console.log(`[Library] ✅ ANN artifact downloaded: ${ann.artifact_name}`);
            } catch (annError) {
              console.warn('[Library] ⚠️ ANN artifact download failed, using legacy fallback:', annError);
            }
          }

          if (ann.id_map_name) {
            try {
              const idMapUrl = `${mirrorBaseUrl}/${ann.id_map_name}`;
              ann.id_map = await downloadIdMap(idMapUrl);
              console.log(`[Library] ✅ ANN id-map downloaded: ${ann.id_map_name}`);
            } catch (idMapError) {
              console.warn('[Library] ⚠️ ANN id-map download failed, using legacy fallback:', idMapError);
            }
          }
        }

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
  },

  /**
   * Best-effort download of optional routing companion (<stem>_comp.bin).
   * This is intentionally silent to users; retrieval simply falls back if unavailable.
   */
  async downloadRoutingCompanion(filenameOrUrl: string): Promise<RouteCompanionPayload | null> {
    const companionFilename = getCompanionFilename(filenameOrUrl);

    for (let attempt = 0; attempt < MIRRORS.length; attempt++) {
      const mirrorIndex = (currentMirrorIndex + attempt) % MIRRORS.length;
      const mirrorBaseUrl = getMirrorUrl(mirrorIndex);
      const companionUrl = `${mirrorBaseUrl}/${companionFilename}`;

      try {
        const response = await fetch(companionUrl);
        if (response.status === 404) {
          console.log(`[Library] ℹ️ No companion file found for "${companionFilename}" on mirror ${mirrorIndex + 1}`);
          continue;
        }
        if (!response.ok) {
          console.warn(`[Library] ⚠️ Companion fetch error ${response.status} on mirror ${mirrorIndex + 1}`);
          continue;
        }

        const result = await parseGzipJsonResponse(response) as RouteCompanionPayload;
        if (!result || typeof result !== 'object' || !Array.isArray(result.books)) {
          console.warn('[Library] ⚠️ Companion file downloaded but format is invalid. Ignoring.');
          return null;
        }

        console.log(`[Library] ✅ Companion loaded: ${companionFilename}`);
        return result;
      } catch (error) {
        console.warn(`[Library] ⚠️ Companion fetch failed on mirror ${mirrorIndex + 1}:`, error);
      }
    }

    console.log(`[Library] ℹ️ Proceeding without companion for "${filenameOrUrl}"`);
    return null;
  }
};
