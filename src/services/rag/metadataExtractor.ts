import type { Document, DocumentCreate, DocumentUpdate } from '@/types/document';
import type { PreprocessedPackage } from '@/types/preprocessed';

export interface ExtractedMetadata {
  title?: string;
  author?: string;
  language?: string;
  subject?: string;
  keywords?: string[];
  creationDate?: Date;
  modificationDate?: Date;
  producer?: string;
  creator?: string;
  pageCount?: number;
  wordCount?: number;
  characterCount?: number;
  readingTimeMinutes?: number;
  chunkSize?: number;
  chunkOverlap?: number;
  embeddingModel?: string;
  processingNotes?: string[];
}

export interface MetadataExtractionResult {
  success: boolean;
  metadata: ExtractedMetadata;
  warnings: string[];
  errors: string[];
}

export class MetadataExtractor {
  
  /**
   * Extract comprehensive metadata from a preprocessed package
   */
  async extractFromPreprocessedPackage(packageData: PreprocessedPackage): Promise<MetadataExtractionResult> {
    const result: MetadataExtractionResult = {
      success: true,
      metadata: {},
      warnings: [],
      errors: []
    };

    try {
      // Extract document metadata from package
      const docMeta = packageData.document_metadata;
      
      // Basic document info
      result.metadata.title = this.extractTitle(docMeta);
      result.metadata.pageCount = docMeta.page_count;
      result.metadata.embeddingModel = docMeta.embedding_model;
      
      // Chunk settings
      if (docMeta.chunk_settings) {
        result.metadata.chunkSize = docMeta.chunk_settings.chunk_size;
        result.metadata.chunkOverlap = docMeta.chunk_settings.chunk_overlap;
      }

      // Dates
      result.metadata.creationDate = this.parseDate(docMeta.created_at);
      result.metadata.modificationDate = this.parseDate(docMeta.processed_at);

      // Extract content-based metadata from chunks
      const contentMetadata = await this.extractFromChunks(packageData.chunks);
      result.metadata.wordCount = contentMetadata.wordCount;
      result.metadata.characterCount = contentMetadata.characterCount;
      result.metadata.readingTimeMinutes = contentMetadata.readingTimeMinutes;
      result.metadata.language = contentMetadata.language;

      // Merge metadata
      Object.assign(result.metadata, contentMetadata.additional);

      // Validate extracted metadata
      this.validateExtractedMetadata(result);

    } catch (error) {
      result.success = false;
      result.errors.push(`Failed to extract metadata: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }

    return result;
  }

  /**
   * Extract metadata from document content (for non-preprocessed documents)
   */
  async extractFromContent(content: string, filename?: string): Promise<MetadataExtractionResult> {
    const result: MetadataExtractionResult = {
      success: true,
      metadata: {},
      warnings: [],
      errors: []
    };

    try {
      // Basic content analysis
      result.metadata.characterCount = content.length;
      result.metadata.wordCount = this.countWords(content);
      // Calculate reading time with a more reasonable cap for very large documents
      const rawReadingTime = Math.ceil(result.metadata.wordCount / 200);
      result.metadata.readingTimeMinutes = Math.min(rawReadingTime, 720); // Cap at 12 hours

      // Extract title from content
      if (!result.metadata.title) {
        result.metadata.title = this.extractTitleFromContent(content);
      }

      // Extract potential metadata from content patterns
      const contentPatterns = this.extractContentPatterns(content);
      Object.assign(result.metadata, contentPatterns);

      // Language detection (basic)
      result.metadata.language = this.detectLanguage(content);

      // Extract keywords
      result.metadata.keywords = this.extractKeywords(content);

      // Use filename as fallback title
      if (!result.metadata.title && filename) {
        result.metadata.title = filename.replace(/\.[^/.]+$/, ''); // Remove extension
        result.warnings.push('Using filename as title - no clear title found in content');
      }

    } catch (error) {
      result.success = false;
      result.errors.push(`Failed to extract metadata from content: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }

    return result;
  }

  /**
   * Apply extracted metadata to a document
   */
  applyToDocument(document: Document | DocumentCreate, metadata: ExtractedMetadata): DocumentUpdate {
    const update: DocumentUpdate = {};

    // Only include fields that are actually defined
    if (metadata.title !== undefined) update.title = metadata.title;
    if (metadata.author !== undefined) update.author = metadata.author;
    if (metadata.language !== undefined) update.language = metadata.language;
    if (metadata.pageCount !== undefined) update.pageCount = metadata.pageCount;

    return update;
  }

  /**
   * Extract title from document metadata
   */
  private extractTitle(docMeta: any): string | undefined {
    // Try various title fields
    if (docMeta.title) return docMeta.title;
    if (docMeta.document_title) return docMeta.document_title;
    if (docMeta.filename) return docMeta.filename.replace(/\.[^/.]+$/, '');
    return undefined;
  }

  /**
   * Extract metadata from chunks
   */
  private async extractFromChunks(chunks: any[]): Promise<{
    wordCount: number;
    characterCount: number;
    readingTimeMinutes: number;
    language?: string;
    additional: any;
  }> {
    let totalWordCount = 0;
    let totalCharCount = 0;
    const allText: string[] = [];

    for (const chunk of chunks) {
      if (chunk.text) {
        allText.push(chunk.text);
        totalWordCount += this.countWords(chunk.text);
        totalCharCount += chunk.text.length;
      }
    }

    const combinedText = allText.join(' ');
    
    // Calculate reading time with a more reasonable cap for very large documents
    const rawReadingTime = Math.ceil(totalWordCount / 200);
    const cappedReadingTime = Math.min(rawReadingTime, 720); // Cap at 12 hours
    
    return {
      wordCount: totalWordCount,
      characterCount: totalCharCount,
      readingTimeMinutes: cappedReadingTime,
      language: this.detectLanguage(combinedText),
      additional: {}
    };
  }

  /**
   * Extract title from content
   */
  private extractTitleFromContent(content: string): string | undefined {
    const lines = content.split('\n').map(line => line.trim()).filter(line => line.length > 0);
    
    // Look for title candidates in first few lines
    for (let i = 0; i < Math.min(10, lines.length); i++) {
      const line = lines[i];
      
      // Skip if too long or too short for a title
      if (line.length < 10 || line.length > 200) continue;
      
      // Skip if it looks like a header/footer
      if (this.isLikelyHeaderOrFooter(line)) continue;
      
      // Skip if it contains numbers that look like page numbers or dates
      if (/\d{4}|\b\d+\/\d+\/\d+\b/.test(line)) continue;
      
      // Good candidate for title
      return line;
    }
    
    return undefined;
  }

  /**
   * Extract patterns from content
   */
  private extractContentPatterns(content: string): any {
    const metadata: any = {};
    
    // Look for author patterns
    const authorPatterns = [
      /(?:author|by|written by)\s*:?\s*([^\n\r]+)/i,
      /^(.+?)\s+(?:author|writer|creator)/im
    ];
    
    for (const pattern of authorPatterns) {
      const match = content.match(pattern);
      if (match && match[1] && match[1].trim().length < 100) {
        metadata.author = match[1].trim();
        break;
      }
    }

    // Look for subject/topic
    const subjectPatterns = [
      /(?:subject|topic)\s*:?\s*([^\n\r]+)/i,
      /^(?:abstract|summary)\s*:?\s*([^\n\r]+)/i
    ];
    
    for (const pattern of subjectPatterns) {
      const match = content.match(pattern);
      if (match && match[1] && match[1].trim().length < 200) {
        metadata.subject = match[1].trim();
        break;
      }
    }

    return metadata;
  }

  /**
   * Detect language (basic implementation)
   */
  private detectLanguage(content: string): string {
    // Simple language detection based on common words
    const sample = content.substring(0, 1000).toLowerCase();
    
    // Check for common English words
    const englishWords = ['the', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for', 'of', 'with', 'by'];
    const englishMatches = englishWords.filter(word => sample.includes(word)).length;
    
    // Check for common Spanish words
    const spanishWords = ['el', 'la', 'y', 'o', 'pero', 'en', 'de', 'para', 'con', 'por', 'un', 'una'];
    const spanishMatches = spanishWords.filter(word => sample.includes(word)).length;
    
    // Check for common French words
    const frenchWords = ['le', 'la', 'et', 'ou', 'mais', 'dans', 'de', 'pour', 'avec', 'par', 'un', 'une'];
    const frenchMatches = frenchWords.filter(word => sample.includes(word)).length;
    
    if (englishMatches > spanishMatches && englishMatches > frenchMatches) {
      return 'en';
    } else if (spanishMatches > englishMatches && spanishMatches > frenchMatches) {
      return 'es';
    } else if (frenchMatches > englishMatches && frenchMatches > spanishMatches) {
      return 'fr';
    }
    
    return 'en'; // Default to English
  }

  /**
   * Extract keywords from content
   */
  private extractKeywords(content: string): string[] {
    // Simple keyword extraction - remove common words and get frequent terms
    const commonWords = new Set([
      'the', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for', 'of', 'with', 'by',
      'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 'have', 'has',
      'had', 'do', 'does', 'did', 'will', 'would', 'could', 'should', 'may', 'might',
      'can', 'this', 'that', 'these', 'those', 'i', 'you', 'he', 'she', 'it', 'we', 'they'
    ]);
    
    const words = content.toLowerCase()
      .replace(/[^\w\s]/g, ' ')
      .split(/\s+/)
      .filter(word => word.length > 3 && !commonWords.has(word));
    
    // Count frequency
    const wordCount = new Map<string, number>();
    words.forEach(word => {
      wordCount.set(word, (wordCount.get(word) || 0) + 1);
    });
    
    // Get top keywords
    return Array.from(wordCount.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([word]) => word);
  }

  /**
   * Check if line is likely header or footer
   */
  private isLikelyHeaderOrFooter(line: string): boolean {
    // Common header/footer patterns
    const patterns = [
      /^\d+$/, // Just numbers (page numbers)
      /^\d+\s+of\s+\d+$/, // "1 of 10"
      /^\w+\s+\d{1,2},?\s+\d{4}$/, // Dates
      /^(page|pg|p)\.?\s*\d+/i, // Page indicators
      /^©\s*\d{4}/, // Copyright
      /^(confidential|draft|internal)/i // Document status
    ];
    
    return patterns.some(pattern => pattern.test(line));
  }

  /**
   * Count words in text
   */
  private countWords(text: string): number {
    return text.trim().split(/\s+/).filter(word => word.length > 0).length;
  }

  /**
   * Parse date string
   */
  private parseDate(dateString?: string): Date | undefined {
    if (!dateString) return undefined;
    
    try {
      return new Date(dateString);
    } catch {
      return undefined;
    }
  }

  /**
   * Validate extracted metadata
   */
  private validateExtractedMetadata(result: MetadataExtractionResult): void {
    const { metadata } = result;
    
    // Validate page count
    if (metadata.pageCount !== undefined && (metadata.pageCount < 0 || metadata.pageCount > 10000)) {
      result.warnings.push(`Unusual page count: ${metadata.pageCount}`);
    }
    
    // Validate word count
    if (metadata.wordCount !== undefined && (metadata.wordCount < 0 || metadata.wordCount > 1000000)) {
      result.warnings.push(`Unusual word count: ${metadata.wordCount}`);
    }
    
    // Validate reading time
    if (metadata.readingTimeMinutes !== undefined &&
        (metadata.readingTimeMinutes < 0 || metadata.readingTimeMinutes > 720)) {
      result.warnings.push(`Unusual reading time: ${metadata.readingTimeMinutes} minutes`);
    }
    
    // Check for missing important metadata
    if (!metadata.title) {
      result.warnings.push('No title found in document');
    }
    
    if (!metadata.language) {
      result.warnings.push('Could not detect document language');
    }
  }
}

// Singleton instance
export const metadataExtractor = new MetadataExtractor();