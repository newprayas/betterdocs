import { LibraryItem } from '@/types/library';

// ---------------- CONFIGURATION ----------------
const HF_USER = 'prayas12';
const HF_REPO = 'vector-datasets-prod';
// "resolve/main" ensures we get the raw file from the latest commit
const BASE_URL = `https://huggingface.co/datasets/${HF_USER}/${HF_REPO}/resolve/main`;
// -----------------------------------------------

// Embedded library catalog (not hosted externally for obscurity)
const LIBRARY_CATALOG = [
  {
    "id": "national_rabies_guideline_2021",
    "name": "National Rabies Guideline 2021",
    "description": "Official national guidelines for rabies management.",
    "filename": "shard_001_v1.bin",
    "size": "417 KB",
    "category": "Guidelines",
    "version": "1.0"
  },
  {
    "id": "national_tb_guideline_2021",
    "name": "National TB Guideline 2021",
    "description": "Official national guidelines for Tuberculosis.",
    "filename": "shard_002_v1.bin",
    "size": "1.91 MB",
    "category": "Guidelines",
    "version": "1.0"
  },
  {
    "id": "abdullah_radiology_5th",
    "name": "Abdullah Radiology (5th Ed)",
    "description": "Essential radiology reference for medicine.",
    "filename": "shard_003_v1.bin",
    "size": "6.03 MB",
    "category": "Medicine",
    "version": "5.0"
  },
  {
    "id": "abdullah_long_case_medicine",
    "name": "Abdullah Long Case in Medicine",
    "description": "Comprehensive long case studies for medical students.",
    "filename": "shard_004_v1.bin",
    "size": "14.4 MB",
    "category": "Medicine",
    "version": "1.0"
  },
  {
    "id": "abdullah_short_case_medicine",
    "name": "Abdullah Short Case in Medicine",
    "description": "Short case clinical examination guide.",
    "filename": "shard_005_v1.bin",
    "size": "17.2 MB",
    "category": "Medicine",
    "version": "1.0"
  },
  {
    "id": "apleys_orthopedics_10th",
    "name": "Apley's Orthopedics (10th Ed)",
    "description": "Standard textbook for orthopedic surgery.",
    "filename": "shard_006_v1.bin",
    "size": "28.9 MB",
    "category": "Orthopedics",
    "version": "10.0"
  },
  {
    "id": "bailey_love_surgery_28th",
    "name": "Bailey & Love's Surgery (28th Ed)",
    "description": "The gold standard textbook for surgery.",
    "filename": "shard_007_v1.bin",
    "size": "53.6 MB",
    "category": "Surgery",
    "version": "28.0"
  },
  {
    "id": "basak_ophthalmology_6th",
    "name": "Basak Essentials of Ophthalmology (6th Ed)",
    "description": "Core concepts in ophthalmology.",
    "filename": "shard_008_v1.bin",
    "size": "10.8 MB",
    "category": "Ophthalmology",
    "version": "6.0"
  },
  {
    "id": "davidson_medicine_24th",
    "name": "Davidson's Principles of Medicine (24th Ed)",
    "description": "Global standard for internal medicine.",
    "filename": "shard_009_v1.bin",
    "size": "57.2 MB",
    "category": "Medicine",
    "version": "24.0"
  },
  {
    "id": "dc_dutta_gynaecology_8th",
    "name": "DC Dutta's Gynaecology (8th Ed)",
    "description": "Comprehensive textbook for Gynaecology.",
    "filename": "shard_010_v1.bin",
    "size": "18.3 MB",
    "category": "Gyne and Obs",
    "version": "8.0"
  },
  {
    "id": "dc_dutta_obstetrics_10th",
    "name": "DC Dutta's Obstetrics (10th Ed)",
    "description": "Comprehensive textbook for Obstetrics.",
    "filename": "shard_011_v1.bin",
    "size": "23.2 MB",
    "category": "Gyne and Obs",
    "version": "10.0"
  },
  {
    "id": "ecg_abm_abdullah_4th",
    "name": "ECG by ABM Abdullah (4th Ed)",
    "description": "Practical guide to ECG interpretation.",
    "filename": "shard_012_v1.bin",
    "size": "1.86 MB",
    "category": "Medicine",
    "version": "4.0"
  },
  {
    "id": "ent_dhingra_7th",
    "name": "Dhingra's ENT (7th Ed)",
    "description": "Diseases of Ear, Nose and Throat.",
    "filename": "shard_013_v1.bin",
    "size": "25.0 MB",
    "category": "ENT",
    "version": "7.0"
  },
  {
    "id": "hamilton_bailey_signs_19th",
    "name": "Hamilton Bailey's Physical Signs (19th Ed)",
    "description": "Demonstrations of physical signs in clinical surgery.",
    "filename": "shard_014_v1.bin",
    "size": "35.0 MB",
    "category": "Surgery",
    "version": "19.0"
  },
  {
    "id": "hutchison_clinical_24th",
    "name": "Hutchison's Clinical Methods (24th Ed)",
    "description": "Standard guide to clinical skills.",
    "filename": "shard_015_v1.bin",
    "size": "12.0 MB",
    "category": "Medicine",
    "version": "24.0"
  },
  {
    "id": "illustrated_synopsis_derm",
    "name": "Neela Khanna - Illustrated Synopsis of Dermatology & STD",
    "description": "Visual guide to dermatological conditions.",
    "filename": "shard_016_v1.bin",
    "size": "15.0 MB",
    "category": "Dermatology",
    "version": "1.0"
  },
  {
    "id": "joynal_eye_lectures",
    "name": "Joynal Sir's Eye Lectures",
    "description": "Lecture notes for ophthalmology.",
    "filename": "shard_017_v1.bin",
    "size": "5.0 MB",
    "category": "Ophthalmology",
    "version": "1.0"
  },
  {
    "id": "kanski_ophthalmology_8th",
    "name": "Kanski's Clinical Ophthalmology (8th Ed)",
    "description": "Systematic approach to eye diseases.",
    "filename": "shard_018_v1.bin",
    "size": "45.0 MB",
    "category": "Ophthalmology",
    "version": "8.0"
  },
  {
    "id": "macleod_clinical_15th",
    "name": "Macleod's Clinical Examination (15th Ed)",
    "description": "Essential guide to clinical examination.",
    "filename": "shard_019_v1.bin",
    "size": "20.0 MB",
    "category": "Medicine",
    "version": "15.0"
  },
  {
    "id": "norman_browse_surgery_6th",
    "name": "Norman Browse's Surgery (6th Ed)",
    "description": "Signs and symptoms of surgical disease.",
    "filename": "shard_020_v1.bin",
    "size": "30.0 MB",
    "category": "Surgery",
    "version": "6.0"
  },
  {
    "id": "ogsb_guidelines_2021",
    "name": "OGSB Guidelines 2021",
    "description": "Obstetrical and Gynecological Society of Bangladesh guidelines.",
    "filename": "shard_021_v1.bin",
    "size": "2.0 MB",
    "category": "Gyne and Obs",
    "version": "2021"
  },
  {
    "id": "oxford_handbook_medicine_10th",
    "name": "Oxford Handbook of Clinical Medicine (10th Ed)",
    "description": "Pocket reference for clinical medicine.",
    "filename": "shard_022_v1.bin",
    "size": "10.0 MB",
    "category": "Medicine",
    "version": "10.0"
  },
  {
    "id": "s_das_surgery_13th",
    "name": "S. Das Manual on Clinical Surgery (13th Ed)",
    "description": "Clinical surgery manual for students.",
    "filename": "shard_023_v1.bin",
    "size": "28.0 MB",
    "category": "Surgery",
    "version": "13.0"
  },
  {
    "id": "step_on_paediatrics_4th",
    "name": "Step on to Paediatrics (4th Ed)",
    "description": "Essential guide for pediatric medicine.",
    "filename": "shard_024_v1.bin",
    "size": "15.0 MB",
    "category": "Pediatrics",
    "version": "4.0"
  },
  {
    "id": "youtube_lectures_processed",
    "name": "Masud sirs Youtube Lectures",
    "description": "Masud sirs Youtube lectures - complete all videos",
    "filename": "shard_025_v1.bin",
    "size": "8.0 MB",
    "category": "Lectures",
    "version": "1.0"
  },
  {
    "id": "brs_physiology_costanzo_linda_s_srg_processed",
    "name": "BRS-Physiology-Costanzo-Linda-S.-SRG",
    "description": "Processed content of BRS-Physiology-Costanzo-Linda-S.-SRG",
    "filename": "shard_026_v1.bin",
    "size": "4.8 MB",
    "category": "Physiology",
    "version": "1.0"
  },
  {
    "id": "ebnezar_and_rakesh_textbook_of_orthopedics_copy_processed",
    "name": "Ebnezar & Rakesh Textbook of Orthopedics copy",
    "description": "Processed content of Ebnezar & Rakesh Textbook of Orthopedics copy",
    "filename": "shard_027_v1.bin",
    "size": "12.0 MB",
    "category": "Orthopedics",
    "version": "1.0"
  },
  {
    "id": "essential_orthopaedics_by_maheshwari_7th_edition_notesmed_processed",
    "name": "Essential-Orthopaedics-by-Maheshwari-7th-Edition-NotesMed",
    "description": "Processed content of Essential-Orthopaedics-by-Maheshwari-7th-Edition-NotesMed",
    "filename": "shard_028_v1.bin",
    "size": "7.0 MB",
    "category": "Orthopedics",
    "version": "1.0"
  },
  {
    "id": "first_aid_for_usmle_step_i_2022_processed",
    "name": "First Aid for USMLE Step I 2022",
    "description": "USMLE",
    "filename": "shard_029_v1.bin",
    "size": "5.8 MB",
    "category": "USMLE",
    "version": "1.0"
  },
  {
    "id": "gomellas_neonatology_8th_edition_processed",
    "name": "Gomellas Neonatology 8th edition",
    "description": "Processed content of Gomellas Neonatology 8th edition",
    "filename": "shard_030_v1.bin",
    "size": "28.1 MB",
    "category": "Pediatrics",
    "version": "1.0"
  },
  {
    "id": "manipal_manual_of_surgery_5th_edition_processed",
    "name": "Manipal Manual of Surgery 5th Edition",
    "description": "Processed content of Manipal Manual of Surgery 5th Edition",
    "filename": "shard_031_v1.bin",
    "size": "21.2 MB",
    "category": "Surgery",
    "version": "1.0"
  },
  {
    "id": "nelson_essentials_of_pediatrics_processed",
    "name": "Nelson-essentials-of-pediatrics",
    "description": "Processed content of Nelson-essentials-of-pediatrics",
    "filename": "shard_032_v1.bin",
    "size": "23.1 MB",
    "category": "Pediatrics",
    "version": "1.0"
  },
  {
    "id": "williams_obstetrics_22th_processed",
    "name": "Williams Obstetrics 22th",
    "description": "Processed content of Williams Obstetrics 22th",
    "filename": "shard_033_v1.bin",
    "size": "23.8 MB",
    "category": "Gyne and Obs",
    "version": "1.0"
  },
  {
    "id": "opthal_kharuna_processed",
    "name": "opthal_kharuna",
    "description": "Processed content of opthal_kharuna",
    "filename": "shard_034_v1.bin",
    "size": "10.0 MB",
    "category": "Ophthalmology",
    "version": "1.0"
  }
];

export const libraryService = {
  /**
   * Returns the embedded library catalog with full download URLs
   * (No external fetch - catalog is embedded in code for obscurity)
   */
  async getAvailableBooks(): Promise<LibraryItem[]> {
    // Map the embedded catalog to include the full download URL
    return LIBRARY_CATALOG.map((item) => ({
      ...item,
      url: `${BASE_URL}/${item.filename}`
    }));
  },

  /**
   * Downloads and parses a .bin shard file (gzip compressed JSON)
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