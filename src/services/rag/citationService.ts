import type { VectorSearchResult } from '@/types/embedding';
import type { Citation as MessageCitation } from '@/types/message';
import type { SimplifiedCitation, SimplifiedCitationGroup, PageGroup } from '@/types/citation';

export interface Citation {
  document: string;
  page?: number;
  pages?: number[]; // Multiple pages for combined chunks
  pageRange?: string; // Formatted page range like "5-7" or "5,7,9"
  excerpt: string;
  sourceIndex: number;
  chunkId: string;
  fullContent?: string; // Full chunk content for display
}

export interface ProcessedCitations {
  citations: Citation[];
  renumberedResponse: string;
  usedSourceIndices: number[];
  validationWarnings: string[]; // Add validation warnings
}


export class CitationService {
  /**
   * Parse citation indices from bracket content.
   * Supports:
   * - [1]
   * - [1, 2]
   * - noisy formats like [5+L1-L3] (extracts leading 5)
   */
  private parseCitationIndices(innerContent: string): number[] {
    const indices: number[] = [];
    const seen = new Set<number>();
    const segments = innerContent.split(',');

    for (const segment of segments) {
      const m = segment.match(/^\s*(\d+)/);
      if (!m) continue;

      const index = parseInt(m[1], 10);
      if (Number.isNaN(index) || seen.has(index)) continue;

      seen.add(index);
      indices.push(index);
    }

    return indices;
  }

  /**
   * Extract citations from AI response and process them
   * Filters unused citations and renumbers them sequentially
   * Enhanced with robust validation and page number accuracy
   */
  processCitations(
    response: string,
    searchResults: VectorSearchResult[]
  ): ProcessedCitations {
    console.log('\n=== CITATION PROCESSING DEBUG START ===');
    console.log('[CITATION INPUT]', `Processing citations for response with ${searchResults.length} search results`);
    
    // Extract all citation references from response
    const citationMatches = this.extractCitationReferences(response);
    console.log('[CITATION MATCHES]', `Found ${citationMatches.length} citation references:`, citationMatches.map(m => `[${m.index}] at position ${m.position}`));
    
    const usedSourceIndices = new Set<number>();
    const validationWarnings: string[] = [];

    // Log all search results for reference
    console.log('[SEARCH RESULTS]', 'Available search results:');
    searchResults.forEach((result, index) => {
      console.log(`[RESULT ${index}]`, {
        chunkId: result.chunk.id,
        documentTitle: result.document.title,
        similarity: result.similarity,
        chunkPage: result.chunk.page,
        metadataPageNumber: result.chunk.metadata?.pageNumber,
        isCombined: result.chunk.metadata?.isCombined,
        originalChunkCount: result.chunk.metadata?.originalChunkCount,
        combinedChunkIds: result.chunk.metadata?.combinedChunkIds,
        contentPreview: result.chunk.content.substring(0, 100) + '...'
      });
    });

    // Filter valid citations and collect used indices
    const validCitations: Citation[] = [];
    
    for (const match of citationMatches) {
      const sourceIndex = match.index;
      
      // CRITICAL FIX: Convert 1-based citation to 0-based index
      // LLM citations are 1-based (CONTEXT SOURCE 1, 2, 3, 4, 5) but searchResults array is 0-based
      const correctedSourceIndex = sourceIndex - 1;
      console.log(`[CITATION INDEX MAPPING]`, `Citation [${sourceIndex}] -> searchResults[${correctedSourceIndex}] (CONTEXT SOURCE ${sourceIndex})`);
      
      // Strict validation: source index must exist in search results
      if (correctedSourceIndex >= 0 && correctedSourceIndex < searchResults.length) {
        const result = searchResults[correctedSourceIndex];
        
        console.log(`[PROCESSING CITATION [${sourceIndex}]]`, {
          chunkId: result.chunk.id,
          documentTitle: result.document.title,
          chunkPage: result.chunk.page,
          metadataPageNumber: result.chunk.metadata?.pageNumber,
          isCombined: result.chunk.metadata?.isCombined,
          correctedIndex: correctedSourceIndex,
          contextSource: `CONTEXT SOURCE ${sourceIndex}`,
          mappingCorrect: true
        });
        
        // Enhanced page number detection - handle combined chunks with multiple pages
        const pageInfo = this.detectPageNumber(
          result.chunk.content,
          result.chunk.metadata?.pageNumber,
          result.chunk.page,
          result.chunk.metadata?.pageNumbers
        );
        
        console.log(`[PAGE DETECTION [${sourceIndex}]]`, {
          contentPage: result.chunk.page,
          metadataPage: result.chunk.metadata?.pageNumber,
          metadataPageNumbers: result.chunk.metadata?.pageNumbers,
          pageInfo,
          isCombined: result.chunk.metadata?.isCombined,
          detectionPriority: 'metadata.pageNumbers > chunk.page > metadata.pageNumber > content extraction'
        });
        
        // Create citation with full content and enhanced page information
        const citation: Citation = {
          document: result.document.title || result.document.fileName,
          page: pageInfo.page,
          pages: pageInfo.pages,
          pageRange: pageInfo.pageRange,
          excerpt: this.createExcerpt(result.chunk.content),
          sourceIndex, // Keep original sourceIndex for display
          chunkId: result.chunk.id,
          fullContent: result.chunk.content, // Store full content for display
        };

        console.log(`[CITATION CREATED [${sourceIndex}]]`, {
          document: citation.document,
          page: citation.page,
          pages: citation.pages,
          pageRange: citation.pageRange,
          excerpt: citation.excerpt.substring(0, 80) + '...'
        });

        validCitations.push(citation);
        usedSourceIndices.add(sourceIndex);
      } else {
        // Add warning for invalid citation
        const warning = `Invalid citation [${sourceIndex}]: Source index out of range (corrected: ${correctedSourceIndex}, available: 0-${searchResults.length - 1})`;
        validationWarnings.push(warning);
        console.log('[INVALID CITATION]', {
          citationNumber: sourceIndex,
          correctedIndex: correctedSourceIndex,
          contextSource: `CONTEXT SOURCE ${sourceIndex}`,
          mappingFailed: true,
          reason: 'Index out of range',
          availableRange: `0-${searchResults.length - 1}`
        });
      }
    }

    // Remove duplicates and sort by source index
    const uniqueCitations = this.removeDuplicateCitations(validCitations)
      .sort((a, b) => a.sourceIndex - b.sourceIndex);

    console.log('[UNIQUE CITATIONS]', `After duplicate removal: ${uniqueCitations.length} citations`);
    uniqueCitations.forEach((citation, index) => {
      console.log(`[UNIQUE ${index}]`, {
        sourceIndex: citation.sourceIndex,
        document: citation.document,
        page: citation.page,
        pages: citation.pages,
        pageRange: citation.pageRange,
        chunkId: citation.chunkId
      });
    });

    // NEW: Validate that cited content actually matches the sources
    const contentValidationResult = this.validateCitationContent(response, uniqueCitations, searchResults);
    validationWarnings.push(...contentValidationResult.warnings);
    
    // Filter out citations that failed content validation
    const validatedCitations = uniqueCitations.filter((citation, index) => {
      const isValid = contentValidationResult.validCitationIndices.has(index);
      if (!isValid) {
        console.log(`[CONTENT VALIDATION FAILED]`, `Citation [${citation.sourceIndex}] removed - content doesn't match source`);
      }
      return isValid;
    });

    // Renumber citations in response and remove invalid ones
    const renumberedResponse = this.renumberCitationsAndRemoveInvalid(response, validatedCitations, validationWarnings);

    console.log('[CITATION RESULT]', {
      originalCitations: citationMatches.length,
      validCitations: validCitations.length,
      uniqueCitations: uniqueCitations.length,
      validatedCitations: validatedCitations.length,
      contentValidationWarnings: contentValidationResult.warnings.length,
      finalPageNumbers: validatedCitations.map(c => ({
        document: c.document,
        page: c.page,
        pages: c.pages,
        pageRange: c.pageRange
      }))
    });
    console.log('=== CITATION PROCESSING DEBUG END ===\n');

    return {
      citations: validatedCitations,
      renumberedResponse,
      usedSourceIndices: Array.from(usedSourceIndices).sort((a, b) => a - b),
      validationWarnings,
    };
  }

  /**
   * Extract citation references from text using regex
   * Handles both normal and noisy citation notations.
   */
  private extractCitationReferences(text: string): Array<{ index: number; position: number }> {
    // Match any bracket group, then parse supported citation formats.
    const citationPattern = /\[([^\]]+)\]/g;
    const matches: Array<{ index: number; position: number }> = [];
    let match;

    while ((match = citationPattern.exec(text)) !== null) {
      const indices = this.parseCitationIndices(match[1]);
      
      for (const index of indices) {
        matches.push({
          index,
          position: match.index,
        });
      }
    }

    return matches;
  }

  /**
   * Remove duplicate citations (same document and page)
   * Enhanced to handle combined chunks properly
   */
  private removeDuplicateCitations(citations: Citation[]): Citation[] {
    const seen = new Set<string>();
    const unique: Citation[] = [];

    for (const citation of citations) {
      // Create a more sophisticated key that handles multiple pages
      let key: string;
      if (citation.pages && citation.pages.length > 0) {
        // For combined chunks, use sorted page numbers as part of the key
        const sortedPages = [...citation.pages].sort((a, b) => a - b).join(',');
        key = `${citation.document}_${sortedPages}`;
      } else if (citation.page) {
        // For single pages, use the page number
        key = `${citation.document}_${citation.page}`;
      } else {
        // For no page information
        key = `${citation.document}_unknown`;
      }
      
      if (!seen.has(key)) {
        seen.add(key);
        unique.push(citation);
      }
    }

    return unique;
  }

  /**
   * Enhanced page number detection with priority order
   * Priority: 1. metadata.pageNumbers (for combined chunks), 2. chunk.page (direct page field), 3. metadata.pageNumber, 4. content extraction
   */
  private detectPageNumber(
    content: string,
    metadataPageNumber?: number,
    chunkPage?: number,
    metadataPageNumbers?: number[]
  ): { page?: number; pages?: number[]; pageRange?: string } {
    console.log('[PAGE DETECTION]', {
      chunkPage,
      metadataPageNumber,
      metadataPageNumbers,
      contentPreview: content.substring(0, 50) + '...',
      checkingPriority: 'metadata.pageNumbers > chunk.page > metadata.pageNumber > content extraction'
    });
    
    // Priority 1: For combined chunks, use pageNumbers array
    if (metadataPageNumbers && metadataPageNumbers.length > 0) {
      const sortedPages = [...metadataPageNumbers].sort((a, b) => a - b);
      const pageRange = this.formatPageRange(sortedPages);
      console.log('[PAGE DETECTION RESULT]', `Using metadata.pageNumbers: ${sortedPages.join(', ')} (range: ${pageRange})`);
      return {
        page: sortedPages[0], // Primary page for compatibility
        pages: sortedPages,
        pageRange
      };
    }
    
    // Priority 2: Use direct page field from chunk if available
    if (chunkPage && chunkPage > 0) {
      console.log('[PAGE DETECTION RESULT]', `Using chunk.page: ${chunkPage}`);
      return { page: chunkPage };
    }
    
    // Priority 3: Use metadata pageNumber if available
    if (metadataPageNumber && metadataPageNumber > 0) {
      console.log('[PAGE DETECTION RESULT]', `Using metadata.pageNumber: ${metadataPageNumber}`);
      return { page: metadataPageNumber };
    }
    
    // Priority 4: Try to extract page number from content as fallback
    const pagePatterns = [
      /page\s+(\d+)/i,
      /p\.?\s*(\d+)/i,
      /第(\d+)页/,
      /page\s+(\d+)\s+of/i,
    ];

    for (const pattern of pagePatterns) {
      const match = content.match(pattern);
      if (match && match[1]) {
        const extractedPage = parseInt(match[1], 10);
        // Only use extracted page if it's reasonable (not 0 or negative)
        if (extractedPage > 0) {
          console.log('[PAGE DETECTION RESULT]', `Using content extraction: ${extractedPage}`);
          return { page: extractedPage };
        }
      }
    }

    console.log('[PAGE DETECTION RESULT]', 'No valid page number found');
    // Return undefined if no valid page number found
    return {};
  }

  /**
   * Format page numbers into a readable range or list
   */
  private formatPageRange(pages: number[]): string {
    if (pages.length === 0) return '';
    if (pages.length === 1) return `${pages[0]}`;
    
    // Check if pages are consecutive
    const isConsecutive = pages.every((page, index) => {
      return index === 0 || page === pages[index - 1] + 1;
    });
    
    if (isConsecutive) {
      return `${pages[0]}-${pages[pages.length - 1]}`;
    } else {
      // For non-consecutive pages, show them as a list
      return pages.join(', ');
    }
  }

  /**
   * Renumber citations in response text sequentially and remove invalid ones
   * FIXED: Handles comma-separated lists like [2, 13] correctly
   */
  private renumberCitationsAndRemoveInvalid(
    response: string,
    citations: Citation[],
    validationWarnings: string[]
  ): string {
    let renumbered = response;
    
    // Create set of valid source indices
    const validSourceIndices = new Set(citations.map(c => c.sourceIndex));
    
    // Create mapping from original indices to new indices
    const indexMap = new Map<number, number>();
    citations.forEach((citation, newIndex) => {
      indexMap.set(citation.sourceIndex, newIndex + 1);
    });

    // Replace both single [1] and multi [1, 2] citations
    const citationGroupPattern = /\[([^\]]+)\]/g;
    
    renumbered = renumbered.replace(citationGroupPattern, (match, innerContent) => {
        // Parse supported citation indices (including noisy forms like [5+L1-L3])
        const indices = this.parseCitationIndices(innerContent);
        
        // Map to new valid indices
        const newIndices = indices
            .filter((idx: number) => {
                if (!validSourceIndices.has(idx)) {
                    // Only log warning once per invalid index
                    if (!renumbered.includes(`invalid_logged_${idx}`)) {
                        validationWarnings.push(`Removed invalid citation [${idx}] from response`);
                    }
                    return false;
                }
                return true;
            })
            .map((idx: number) => indexMap.get(idx))
            .filter((idx: number | undefined): idx is number => idx !== undefined)
            .sort((a: number, b: number) => a - b); // Sort for cleaner display
            
        // If no valid citations remain in this group, return empty string
        if (newIndices.length === 0) {
            return '';
        }
        
        // Return renumbered group
        return `[${newIndices.join(', ')}]`;
    });

    // Clean up punctuation spacing
    renumbered = renumbered.replace(/ +([.,;:!])/g, '$1');

    return renumbered.trim();
  }

  /**
   * Create a concise excerpt from chunk content for preview
   * Full content will be available via fullContent property
   */
  private createExcerpt(content: string, maxLength: number = 300): string {
    if (content.length <= maxLength) {
      return content;
    }

    // Try to end at sentence boundary
    const truncated = content.substring(0, maxLength);
    const lastSentenceEnd = Math.max(
      truncated.lastIndexOf('.'),
      truncated.lastIndexOf('!'),
      truncated.lastIndexOf('?')
    );

    if (lastSentenceEnd > maxLength * 0.7) {
      return truncated.substring(0, lastSentenceEnd + 1);
    }

    return truncated + '...';
  }

  /**
   * Format citations for display at the end of response in Vancouver style
   */
  formatCitationsForDisplay(citations: Citation[]): string {
    if (citations.length === 0) {
      return '';
    }

    const sources = citations.map((citation, index) => {
      let pageInfo = '';
      if (citation.pageRange) {
        pageInfo = `. pp. ${citation.pageRange}`;
      } else if (citation.pages && citation.pages.length > 1) {
        pageInfo = `. pp. ${citation.pages.join(', ')}`;
      } else if (citation.page) {
        pageInfo = `. p. ${citation.page}`;
      }
      return `${index + 1}. ${citation.document}${pageInfo}`;
    });

    return '\n\n**Vancouver Style References:**\n' + sources.join('\n');
  }

  /**
   * Enhanced validation of citation format in response
   */
  validateCitationFormat(response: string, availableSources: number): {
    isValid: boolean;
    errors: string[];
    warnings: string[];
  } {
    const errors: string[] = [];
    const warnings: string[] = [];

    // Check for citation references
    const citationMatches = this.extractCitationReferences(response);
    
    if (citationMatches.length === 0) {
      warnings.push('No citations found in response');
    }

    // Check for invalid citation numbers (out of range)
    for (const match of citationMatches) {
      if (match.index >= availableSources) {
        errors.push(`Citation [${match.index}] is invalid - only ${availableSources} sources available (0-${availableSources - 1})`);
      }
      if (match.index < 0) {
        errors.push(`Citation [${match.index}] is invalid - negative index`);
      }
    }

    // Check for consecutive citations without context
    const consecutivePattern = /\[\d+\]\s*\[\d+\]/g;
    const consecutiveMatches = response.match(consecutivePattern);
    if (consecutiveMatches && consecutiveMatches.length > 0) {
      warnings.push('Found consecutive citations without context between them');
    }

    // Check for citations at the very end (might be missing context)
    const endCitationPattern = /\[\d+\]\s*$/;
    if (endCitationPattern.test(response.trim())) {
      warnings.push('Citation appears at the very end without context');
    }

    // Check for citation gaps (e.g., [1], [3] without [2])
    const usedIndices = citationMatches.map(m => m.index).sort((a, b) => a - b);
    for (let i = 1; i < usedIndices.length; i++) {
      if (usedIndices[i] > usedIndices[i - 1] + 1) {
        warnings.push(`Citation gap detected between [${usedIndices[i - 1]}] and [${usedIndices[i]}]`);
      }
    }

    return {
      isValid: errors.length === 0,
      errors,
      warnings,
    };
  }

  /**
   * Extract citation metadata for storage in the correct MessageCitation format
   * Enhanced to include full content and handle combined chunks
   */
  extractCitationMetadata(
    citations: Citation[],
    searchResults: VectorSearchResult[]
  ): MessageCitation[] {
    return citations.map(citation => {
      // Find the corresponding search result to check if it's a combined chunk
      const searchResult = searchResults.find(result => result.chunk.id === citation.chunkId);
      
      // Handle combined chunks by including metadata about the original chunks
      let enhancedExcerpt = citation.fullContent || citation.excerpt;
      let additionalMetadata: any = {};
      
      if (searchResult?.chunk.metadata?.isCombined) {
        additionalMetadata = {
          isCombined: true,
          originalChunkCount: searchResult.chunk.metadata.originalChunkCount,
          combinedChunkIds: searchResult.chunk.metadata.combinedChunkIds,
        };
        
        // For combined chunks, we might want to add a note about the combination
        if (searchResult.chunk.metadata.originalChunkCount && searchResult.chunk.metadata.originalChunkCount > 1) {
          enhancedExcerpt = `[Combined from ${searchResult.chunk.metadata.originalChunkCount} chunks]\n\n${enhancedExcerpt}`;
        }
      }
      
      return {
        document: citation.document,
        page: citation.page,
        pages: citation.pages,
        pageRange: citation.pageRange,
        excerpt: enhancedExcerpt,
        ...additionalMetadata,
      };
    });
  }

  /**
   * Create citation links for interactive UI
   */
  createCitationLinks(citations: Citation[]): Array<{
    id: string;
    text: string;
    documentId: string;
    pageNumber?: number;
    chunkId: string;
  }> {
    return citations.map((citation, index) => ({
      id: `citation-${index + 1}`,
      text: `[${index + 1}]`,
      documentId: citation.document,
      pageNumber: citation.page,
      pages: citation.pages,
      pageRange: citation.pageRange,
      chunkId: citation.chunkId,
    }));
  }

  /**
   * Merge citations from multiple responses
   */
  mergeCitations(citationGroups: ProcessedCitations[]): ProcessedCitations {
    const allCitations: Citation[] = [];
    const allUsedIndices: number[] = [];
    const allValidationWarnings: string[] = [];
    let mergedResponse = '';

    for (let i = 0; i < citationGroups.length; i++) {
      const group = citationGroups[i];
      
      // Offset citation indices for merged response
      const offsetCitations = group.citations.map(citation => ({
        ...citation,
        sourceIndex: citation.sourceIndex + allUsedIndices.length,
      }));

      allCitations.push(...offsetCitations);
      allUsedIndices.push(...group.usedSourceIndices);
      allValidationWarnings.push(...(group.validationWarnings || []));
      
      if (i === 0) {
        mergedResponse = group.renumberedResponse;
      } else {
        // Append response with adjusted citation numbers
        mergedResponse += '\n\n' + this.adjustCitationIndices(
          group.renumberedResponse,
          allUsedIndices.length
        );
      }
    }

    return {
      citations: this.removeDuplicateCitations(allCitations),
      renumberedResponse: mergedResponse,
      usedSourceIndices: allUsedIndices,
      validationWarnings: allValidationWarnings,
    };
  }

  /**
   * Adjust citation indices by offset
   * FIXED: Handles comma-separated citations
   */
  private adjustCitationIndices(text: string, offset: number): string {
    const citationPattern = /\[([\d,\s]+)\]/g;
    
    return text.replace(citationPattern, (match, innerContent) => {
        const indices = innerContent.split(',').map((s: string) => parseInt(s.trim(), 10));
        const newIndices = indices.map((idx: number) => idx + offset);
        return `[${newIndices.join(', ')}]`;
    });
  }

  /**
   * NEW: Validate that cited content actually appears in the cited sources
   * Enhanced with confidence scoring and more lenient validation criteria
   */
  private validateCitationContent(
    response: string,
    citations: Citation[],
    searchResults: VectorSearchResult[]
  ): {
    validCitationIndices: Set<number>;
    warnings: string[];
  } {
    const validCitationIndices = new Set<number>();
    const warnings: string[] = [];

    console.log('\n=== CONTENT VALIDATION START ===');
    console.log('[VALIDATION INPUT]', `Checking ${citations.length} citations against their sources`);
    console.log('[CITATION JOURNEY]', `Response length: ${response.length} characters`);
    console.log('[CITATION JOURNEY]', `Available search results: ${searchResults.length} sources`);

    // Extract text segments that should be supported by each citation
    const citationContexts = this.extractCitationContexts(response);
    console.log('[CITATION JOURNEY]', `Extracted contexts for ${citationContexts.size} citations`);
    
    // Log detailed citation journey
    citationContexts.forEach((context, index) => {
      console.log(`[CITATION JOURNEY CONTEXT ${index}]`, {
        citationNumber: index,
        contextLength: context.length,
        contextPreview: context.substring(0, 100) + '...',
        expectedSourceIndex: index - 1, // 0-based
        contextSource: 'CONTEXT SOURCE ' + index
      });
    });

    for (let i = 0; i < citations.length; i++) {
      const citation = citations[i];
      const sourceIndex = citation.sourceIndex;
      
      // Get the source content - CRITICAL FIX: Convert 1-based citation to 0-based index
      // LLM citations are 1-based (CONTEXT SOURCE 1, 2, 3, 4, 5) but searchResults array is 0-based
      const correctedSourceIndex = sourceIndex - 1;
      console.log(`[CITATION INDEX MAPPING]`, `Citation [${sourceIndex}] -> searchResults[${correctedSourceIndex}] (CONTEXT SOURCE ${sourceIndex})`);
      
      const sourceResult = searchResults[correctedSourceIndex];
      if (!sourceResult) {
        warnings.push(`Citation [${sourceIndex}]: Source not found in search results (corrected index: ${correctedSourceIndex})`);
        continue;
      }

      const sourceContent = sourceResult.chunk.content.toLowerCase();
      const citationContext = citationContexts.get(sourceIndex);
      
      if (!citationContext) {
        warnings.push(`Citation [${sourceIndex}]: No context found for citation`);
        continue;
      }

      // Check if the cited context actually appears in the source
      const contextLower = citationContext.toLowerCase();
      const contentMatch = this.checkContentMatchWithConfidence(contextLower, sourceContent);
      
      console.log(`[VALIDATING CITATION [${sourceIndex}]]`, {
        citationNumber: sourceIndex,
        sourceIndex: correctedSourceIndex, // 0-based
        contextLength: citationContext.length,
        sourceContentLength: sourceContent.length,
        confidenceScore: contentMatch.confidence,
        isValid: contentMatch.confidence >= 0.2, // Accept citations with 20%+ confidence (less strict)
        contextPreview: citationContext.substring(0, 100) + '...',
        sourcePreview: sourceContent.substring(0, 100) + '...',
        sourcePage: sourceResult.chunk.metadata?.pageNumber || sourceResult.chunk.page,
        sourceDocument: sourceResult.document.title || sourceResult.document.fileName,
        validationReason: contentMatch.reason
      });

      // Use confidence scoring instead of binary validation - LESS STRICT: lowered threshold from 0.3 to 0.2
      if (contentMatch.confidence >= 0.2) {
        validCitationIndices.add(i);
        if (contentMatch.confidence < 0.5) { // Lowered from 0.6 to 0.5
          warnings.push(`Citation [${sourceIndex}]: Low confidence match (${Math.round(contentMatch.confidence * 100)}%) - ${contentMatch.reason}`);
        }
      } else {
        warnings.push(`Citation [${sourceIndex}]: Rejected - ${contentMatch.reason} (confidence: ${Math.round(contentMatch.confidence * 100)}%)`);
      }
    }

    console.log('[VALIDATION RESULT]', {
      totalCitations: citations.length,
      validCitations: validCitationIndices.size,
      invalidCitations: citations.length - validCitationIndices.size,
      warnings: warnings.length
    });
    console.log('=== CONTENT VALIDATION END ===\n');

    return { validCitationIndices, warnings };
  }

  /**
   * Extract the text context that each citation should support
   * FIXED: Handles comma-separated citations by associating text with ALL citations in the group
   */
  private extractCitationContexts(response: string): Map<number, string> {
    console.log('\n=== CITATION CONTEXT EXTRACTION START ===');
    console.log('[CONTEXT EXTRACTION]', `Extracting contexts from response of ${response.length} characters`);
    
    const citationContexts = new Map<number, string>();
    const citationPattern = /\[([^\]]+)\]/g;
    let match;
    let lastIndex = 0;

    while ((match = citationPattern.exec(response)) !== null) {
      const citationPosition = match.index;
      
      // Parse all indices in this group (supports noisy forms like [5+L1-L3])
      const indices = this.parseCitationIndices(match[1]);
      
      // Extract text from last position to this citation group
      const textSegment = response.substring(lastIndex, citationPosition).replace(/[ \t]+/g, ' ').trim();
      
      /*
      console.log(`[CONTEXT EXTRACTION MATCH]`, {
        citationNumbers: indices,
        citationPosition: citationPosition,
        citationText: match[0],
        lastPosition: lastIndex,
        segmentLength: textSegment.length
      });
      */
      
      // If this segment has text, associate it with all citations in this group
      if (textSegment.length > 10 || citationContexts.size === 0) {
        indices.forEach(idx => {
            citationContexts.set(idx, textSegment);
        });
      } else if (citationContexts.size > 0) {
        // If text segment is too short, append to previous citation's context
        // (This is heuristic and might need refinement for multi-citation logic)
        // For grouped citations like [1,2], they share context, so finding the last key works reasonably well
        const lastKey = Array.from(citationContexts.keys()).pop();
        if (lastKey !== undefined) {
          const existingContext = citationContexts.get(lastKey) || '';
          const combinedContext = existingContext + ' ' + textSegment;
          indices.forEach(idx => {
              citationContexts.set(idx, combinedContext);
          });
        }
      }
      
      lastIndex = citationPosition + match[0].length;
    }

    console.log('[CONTEXT EXTRACTION RESULT]', `Extracted ${citationContexts.size} citation contexts`);
    console.log('=== CITATION CONTEXT EXTRACTION END ===\n');

    return citationContexts;
  }

  /**
   * Check if the cited context actually matches the source content with confidence scoring
   * ENHANCED: More lenient validation with better medical term handling
   */
  private checkContentMatchWithConfidence(context: string, sourceContent: string): {
    confidence: number;
    reason: string;
  } {
    console.log('\n=== CONTENT MATCH ANALYSIS START ===');
    console.log('[CONTENT MATCH INPUT]', {
      contextLength: context.length,
      sourceLength: sourceContent.length,
      contextPreview: context.substring(0, 100) + '...',
      sourcePreview: sourceContent.substring(0, 100) + '...'
    });

    // Remove common words and normalize for comparison
    const normalizedContext = this.normalizeTextForComparison(context);
    const normalizedSource = this.normalizeTextForComparison(sourceContent);

    let confidence = 0;
    let reasons: string[] = [];

    // 1. Check for direct phrase matches (reduced from 3 to 2 consecutive words for more leniency)
    const contextWords = normalizedContext.split(/\s+/);
    const sourceWords = normalizedSource.split(/\s+/);
    
    let maxMatchLength = 0;
    let totalPhraseMatches = 0;
    
    for (let i = 0; i <= contextWords.length - 2; i++) { // Reduced from 3 to 2
      const phrase = contextWords.slice(i, i + 2).join(' ');
      if (normalizedSource.includes(phrase)) {
        totalPhraseMatches++;
        maxMatchLength = Math.max(maxMatchLength, 2);
        
        // Check for longer matches
        for (let j = 3; j <= contextWords.length - i; j++) {
          const longerPhrase = contextWords.slice(i, i + j).join(' ');
          if (normalizedSource.includes(longerPhrase)) {
            maxMatchLength = j;
          } else {
            break;
          }
        }
      }
    }

    // Calculate phrase match confidence
    if (maxMatchLength >= 2) { // Reduced from 3 to 2
      const phraseConfidence = Math.min(0.8, (maxMatchLength / 8) + (totalPhraseMatches * 0.15)); // More lenient calculation
      confidence = Math.max(confidence, phraseConfidence);
      reasons.push(`${maxMatchLength}+ consecutive words match`);
    }

    // 2. Check for key term overlap (reduced from 2 to 1 important term for more leniency)
    const importantTerms = this.extractImportantTerms(context);
    const matchingTerms = importantTerms.filter(term =>
      normalizedSource.includes(term.toLowerCase())
    );

    const hasTermOverlap = matchingTerms.length >= 1 || // Reduced from 2 to 1
                          (matchingTerms.length >= 1 && importantTerms.length <= 1);

    if (hasTermOverlap) {
      const termConfidence = Math.min(0.7, (matchingTerms.length / Math.max(importantTerms.length, 1)) * 0.9); // More lenient
      confidence = Math.max(confidence, termConfidence);
      reasons.push(`${matchingTerms.length}/${importantTerms.length} key terms match`);
    }

    // 3. Enhanced semantic similarity check with lower threshold
    const semanticSimilarity = this.calculateSemanticSimilarity(normalizedContext, normalizedSource);
    if (semanticSimilarity > 0.2) { // Reduced from 0.3 to 0.2
      const semanticConfidence = Math.min(0.6, semanticSimilarity * 0.8); // More lenient
      confidence = Math.max(confidence, semanticConfidence);
      reasons.push(`semantic similarity: ${Math.round(semanticSimilarity * 100)}%`);
    }

    // 4. Enhanced medical/scientific term matching with higher boost
    const medicalTerms = this.extractMedicalTerms(context);
    const matchingMedicalTerms = medicalTerms.filter(term =>
      normalizedSource.includes(term.toLowerCase())
    );
    
    if (matchingMedicalTerms.length > 0) {
      confidence += 0.15 * (matchingMedicalTerms.length / Math.max(medicalTerms.length, 1)); // Increased from 0.1 to 0.15
      reasons.push(`${matchingMedicalTerms.length} medical terms match`);
    }

    // 5. NEW: Add partial match consideration for medical content
    const medicalTermBoost = this.calculateMedicalTermMatch(context, sourceContent);
    if (medicalTermBoost > 0) {
      confidence = Math.min(confidence + medicalTermBoost, 1.0);
      reasons.push(`medical term relevance: ${Math.round(medicalTermBoost * 100)}%`);
    }

    // Cap confidence at 1.0
    confidence = Math.min(confidence, 1.0);

    let reason = '';
    if (confidence < 0.2) { // Updated threshold to match new validation
      if (maxMatchLength > 0) {
        reason = `Only found ${maxMatchLength} consecutive matching words (need at least 2)`;
      } else if (matchingTerms.length > 0) {
        reason = `Only ${matchingTerms.length} key terms match (need at least 1)`;
      } else {
        reason = 'No meaningful content match found between citation and source';
      }
    } else {
      reason = reasons.join('; ');
    }

    /*
    console.log('[CONTENT MATCH RESULT]', {
      confidence: Math.round(confidence * 100) + '%',
      reason: reason,
      phraseMatches: totalPhraseMatches,
      termMatches: matchingTerms.length,
      medicalMatches: matchingMedicalTerms.length,
      semanticSimilarity: Math.round(semanticSimilarity * 100) + '%'
    });
    */
    console.log('=== CONTENT MATCH ANALYSIS END ===\n');

    return { confidence, reason };
  }

  /**
   * NEW: Calculate medical term match boost for better validation
   */
  private calculateMedicalTermMatch(context: string, sourceContent: string): number {
    const medicalTerms = [
      'glaucoma', 'cataract', 'diabetes', 'hypertension', 'ophthalmoscopy', 'ultrasound',
      'diagnosis', 'treatment', 'symptom', 'therapy', 'medication', 'surgery', 'examination',
      'retina', 'cornea', 'lens', 'optic', 'vision', 'eye', 'ocular', 'ophthalmic',
      'intraocular', 'pressure', 'fluid', 'injection', 'laser', 'phacoemulsification'
    ];

    const contextLower = context.toLowerCase();
    const sourceLower = sourceContent.toLowerCase();

    let matchCount = 0;
    for (const term of medicalTerms) {
      if (contextLower.includes(term) && sourceLower.includes(term)) {
        matchCount++;
      }
    }

    // Return boost based on medical term overlap
    return Math.min(matchCount * 0.1, 0.3); // Max 30% boost
  }

  /**
   * Calculate semantic similarity between two texts using Jaccard similarity
   * This is a simplified semantic similarity check
   */
  private calculateSemanticSimilarity(text1: string, text2: string): number {
    const words1 = new Set(text1.split(/\s+/).filter(w => w.length > 2));
    const words2 = new Set(text2.split(/\s+/).filter(w => w.length > 2));
    
    const intersection = new Set([...words1].filter(x => words2.has(x)));
    const union = new Set([...words1, ...words2]);
    
    if (union.size === 0) return 0;
    return intersection.size / union.size;
  }

  /**
   * Legacy method for backward compatibility
   */
  private checkContentMatch(context: string, sourceContent: string): {
    isValid: boolean;
    reason: string;
  } {
    const result = this.checkContentMatchWithConfidence(context, sourceContent);
    return {
      isValid: result.confidence >= 0.3,
      reason: result.reason
    };
  }

  /**
   * Normalize text for comparison by removing punctuation and common words
   */
  private normalizeTextForComparison(text: string): string {
    const commonWords = new Set([
      'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
      'of', 'with', 'by', 'is', 'are', 'was', 'were', 'be', 'been', 'have',
      'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could', 'should',
      'this', 'that', 'these', 'those', 'i', 'you', 'he', 'she', 'it', 'we', 'they'
    ]);

    return text
      .toLowerCase()
      .replace(/[^\w\s]/g, ' ') // Replace punctuation with spaces
      .replace(/[ \t]+/g, ' ') // Only replace spaces and tabs, NOT newlines
      .trim()
      .split(/\s+/)
      .filter(word => !commonWords.has(word) && word.length > 1)
      .join(' ');
  }

  /**
   * Extract important terms (nouns and specific terminology) from text
   * Enhanced with better medical/scientific term identification
   */
  private extractImportantTerms(text: string): string[] {
    // Enhanced medical and scientific terms
    const medicalTerms = [
      'cataract', 'glaucoma', 'diabetes', 'hypertension', 'ophthalmoscopy', 'ultrasound',
      'diagnosis', 'treatment', 'symptom', 'therapy', 'medication', 'surgery', 'examination',
      'retina', 'cornea', 'lens', 'optic', 'vision', 'eye', 'ocular', 'ophthalmic',
      'intraocular', 'pressure', 'fluid', 'injection', 'laser', 'phacoemulsification',
      'biometry', 'keratometry', 'astigmatism', 'myopia', 'hyperopia', 'presbyopia'
    ];

    const scientificTerms = [
      'analysis', 'research', 'study', 'clinical', 'trial', 'patient', 'outcome',
      'procedure', 'technique', 'method', 'result', 'conclusion', 'evidence',
      'parameter', 'measurement', 'assessment', 'evaluation', 'diagnostic'
    ];

    // Create patterns for matching
    const importantPatterns = [
      /\b[a-zA-Z]{4,}\b/g, // Words with 4+ characters
      new RegExp(`\\b(?:${medicalTerms.join('|')})\\b`, 'gi'), // Medical terms
      new RegExp(`\\b(?:${scientificTerms.join('|')})\\b`, 'gi'), // Scientific terms
      /\b(?:[A-Z][a-z]+(?:[A-Z][a-z]+)*)\b/g, // CamelCase technical terms
      /\b\d+(?:\.\d+)?(?:%|mg|ml|mm|cm)\b/g, // Measurements and units
    ];

    const allMatches: string[] = [];
    importantPatterns.forEach(pattern => {
      const matches = text.match(pattern);
      if (matches) {
        allMatches.push(...matches);
      }
    });

    // Filter out common words and normalize
    const commonWords = new Set([
      'this', 'that', 'with', 'from', 'they', 'have', 'been', 'said', 'each',
      'which', 'their', 'time', 'will', 'about', 'would', 'there', 'could'
    ]);

    const filteredTerms = allMatches
      .map(term => term.toLowerCase())
      .filter(term => !commonWords.has(term) && term.length > 2);

    // Return unique terms
    return Array.from(new Set(filteredTerms));
  }

  /**
   * Extract specifically medical terms from text
   */
  private extractMedicalTerms(text: string): string[] {
    const medicalTerms = [
      'cataract', 'glaucoma', 'diabetes', 'hypertension', 'ophthalmoscopy', 'ultrasound',
      'diagnosis', 'treatment', 'symptom', 'therapy', 'medication', 'surgery', 'examination',
      'retina', 'cornea', 'lens', 'optic', 'vision', 'eye', 'ocular', 'ophthalmic',
      'intraocular', 'pressure', 'fluid', 'injection', 'laser', 'phacoemulsification',
      'biometry', 'keratometry', 'astigmatism', 'myopia', 'hyperopia', 'presbyopia'
    ];

    const pattern = new RegExp(`\\b(?:${medicalTerms.join('|')})\\b`, 'gi');
    const matches = text.match(pattern);
    
    return matches ? Array.from(new Set(matches.map(term => term.toLowerCase()))) : [];
  }

  /**
   * NEW: Process citations using simplified page-based grouping
   * Groups all chunks from the same page into a single citation
   * ENHANCED: Added comprehensive logging and content validation
   */
  processSimplifiedCitations(
    response: string,
    searchResults: VectorSearchResult[]
  ): SimplifiedCitationGroup {
    console.log('\n=== SIMPLIFIED CITATION PROCESSING START ===');
    console.log('[SIMPLIFIED INPUT]', `Processing ${searchResults.length} search results for simplified citations`);
    console.log('[RESPONSE ANALYSIS]', `LLM Response length: ${response.length} characters`);
    console.log('[RESPONSE PREVIEW]', response.substring(0, 200) + (response.length > 200 ? '...' : ''));
    
    // Extract citation references from response
    const citationMatches = this.extractCitationReferences(response);
    console.log('[CITATION MATCHES]', `Found ${citationMatches.length} citation references:`, citationMatches.map(m => `[${m.index}] at position ${m.position}`));
    
    const usedSourceIndices = new Set<number>();
    
    // Group search results by page
    const pageGroups = this.groupByPage(searchResults);
    console.log('[PAGE GROUPS]', `Created ${pageGroups.length} page groups`);
    
    // Extract citation contexts for validation
    const citationContexts = this.extractCitationContexts(response);
    console.log('[CITATION CONTEXTS]', `Extracted contexts for ${citationContexts.size} citations`);
    citationContexts.forEach((context, index) => {
      console.log(`[CONTEXT ${index}]`, context.substring(0, 100) + (context.length > 100 ? '...' : ''));
    });

    // Strict fail-closed behavior:
    // If the model did not emit explicit [n] citations, do NOT auto-derive references.
    // This avoids presenting unsupported statements as sourced.
    if (citationMatches.length === 0) {
      const warning = 'No explicit inline citations found in model output; skipping derived citations to avoid unsupported references.';
      console.warn('[SIMPLIFIED NO EXPLICIT CITATIONS]', warning);
      console.log('=== SIMPLIFIED CITATION PROCESSING END ===\n');
      return {
        citations: [],
        renumberedResponse: response,
        usedSourceIndices: [],
        validationWarnings: [warning],
      };
    }

    // Filter valid citations and create simplified citations
    const validCitations: SimplifiedCitation[] = [];
    const validationWarnings: string[] = [];
    
    for (const match of citationMatches) {
      const sourceIndex = match.index;
      const citationContext = citationContexts.get(sourceIndex);
      
      // LLM citations are 1-based (CONTEXT SOURCE 1, 2, 3...) while array is 0-based
      let correctedSourceIndex = sourceIndex - 1;
      console.log(`[SIMPLIFIED CITATION MAPPING]`, `Citation [${sourceIndex}] -> searchResults[${correctedSourceIndex}] (CONTEXT SOURCE ${sourceIndex})`);
      
      if (correctedSourceIndex >= 0 && correctedSourceIndex < searchResults.length) {
        let result = searchResults[correctedSourceIndex];
        let pageNumber = this.getEffectivePageNumber(result);
        
        console.log(`[PROCESSING CITATION [${sourceIndex}]]`, {
          documentTitle: result.document.title || result.document.fileName,
          pageNumber,
          chunkId: result.chunk.id,
          similarity: result.similarity,
          chunkPreview: result.chunk.content.substring(0, 150) + '...'
        });
        
        if (pageNumber !== undefined) {
          // Find the page group for this result
          let pageGroup = pageGroups.find(pg =>
            pg.documentId === result.document.id && pg.page === pageNumber
          );
          
          if (pageGroup) {
            // Combine all content from this page
            let combinedContent = pageGroup.chunks
              .sort((a, b) => a.content.localeCompare(b.content)) // Sort for consistency
              .map(chunk => chunk.content)
              .join('\n---\n');
            
            // Validate that citation context matches the source content.
            let isValidCitation = true;
            let validationReason = '';
            
            if (citationContext) {
              const currentValidation = this.checkContentMatchWithConfidence(citationContext, combinedContent);
              let bestIndex = correctedSourceIndex;
              let bestValidation = currentValidation;
              let bestResult = result;
              let bestPageNumber = pageNumber;
              let bestPageGroup = pageGroup;
              let bestCombinedContent = combinedContent;

              // Try remapping citation to best matching retrieved chunk/page.
              for (let candidateIndex = 0; candidateIndex < searchResults.length; candidateIndex++) {
                const candidateResult = searchResults[candidateIndex];
                const candidatePage = this.getEffectivePageNumber(candidateResult);
                if (candidatePage === undefined) continue;

                const candidatePageGroup = pageGroups.find(pg =>
                  pg.documentId === candidateResult.document.id && pg.page === candidatePage
                );
                if (!candidatePageGroup) continue;

                const candidateContent = candidatePageGroup.chunks
                  .map(chunk => chunk.content)
                  .join('\n---\n');
                const candidateValidation = this.checkContentMatchWithConfidence(citationContext, candidateContent);

                if (candidateValidation.confidence > bestValidation.confidence) {
                  bestValidation = candidateValidation;
                  bestIndex = candidateIndex;
                  bestResult = candidateResult;
                  bestPageNumber = candidatePage;
                  bestPageGroup = candidatePageGroup;
                  bestCombinedContent = candidateContent;
                }
              }

              // Remap when best candidate is clearly stronger.
              if (bestIndex !== correctedSourceIndex && bestValidation.confidence >= currentValidation.confidence + 0.15) {
                console.warn('[SIMPLIFIED CITATION REMAP]', {
                  citation: sourceIndex,
                  from: correctedSourceIndex + 1,
                  to: bestIndex + 1,
                  fromConfidence: currentValidation.confidence,
                  toConfidence: bestValidation.confidence
                });
                correctedSourceIndex = bestIndex;
                result = bestResult;
                pageNumber = bestPageNumber;
                pageGroup = bestPageGroup;
                combinedContent = bestCombinedContent;
              }

              isValidCitation = bestValidation.confidence >= 0.35;
              validationReason = bestValidation.reason;
              
              console.log(`[CITATION VALIDATION [${sourceIndex}]]`, {
                isValid: isValidCitation,
                confidence: bestValidation.confidence,
                reason: bestValidation.reason,
                contextPreview: citationContext.substring(0, 80) + '...',
                sourcePreview: combinedContent.substring(0, 80) + '...'
              });
              
              if (!isValidCitation) {
                validationWarnings.push(`Citation [${sourceIndex}] validation failed: ${validationReason}`);
              }
            } else {
              console.warn(`[VALIDATION WARNING]`, `No context found for citation [${sourceIndex}]`);
              validationWarnings.push(`No context found for citation [${sourceIndex}]`);
            }
            
            // Only add citation if it passes validation
            if (isValidCitation) {
              const simplifiedCitation: SimplifiedCitation = {
                document: result.document.title || result.document.fileName,
                page: pageNumber,
                combinedContent,
                sourceIndex: correctedSourceIndex + 1,
                chunkIds: pageGroup.chunks.map(chunk => chunk.id),
                similarity: Math.max(...pageGroup.chunks.map(chunk => chunk.similarity))
              };
              
              validCitations.push(simplifiedCitation);
              usedSourceIndices.add(correctedSourceIndex + 1);
              
              console.log(`[VALID CITATION ADDED [${sourceIndex}]]`, {
                document: simplifiedCitation.document,
                page: simplifiedCitation.page,
                chunkCount: simplifiedCitation.chunkIds.length,
                similarity: simplifiedCitation.similarity,
                correctedIndex: correctedSourceIndex,
                contextSource: `CONTEXT SOURCE ${sourceIndex}`,
                mappingCorrect: true
              });
            } else {
              console.log(`[INVALID CITATION REJECTED [${sourceIndex}]]`, {
                reason: validationReason,
                correctedIndex: correctedSourceIndex,
                contextSource: `CONTEXT SOURCE ${sourceIndex}`,
                mappingFailed: true
              });
            }
          } else {
            console.warn(`[PAGE GROUP NOT FOUND]`, `No page group found for document ${result.document.id}, page ${pageNumber}`);
            validationWarnings.push(`No page group found for citation [${sourceIndex}]`);
          }
        } else {
          console.warn(`[PAGE NUMBER NOT FOUND]`, `No valid page number for citation [${sourceIndex}]`);
          validationWarnings.push(`No valid page number for citation [${sourceIndex}]`);
        }
      } else {
        console.warn(`[INVALID CITATION INDEX]`, `Citation [${sourceIndex}] is out of range (corrected index: ${correctedSourceIndex}, available: 0-${searchResults.length - 1})`);
        validationWarnings.push(`Citation [${sourceIndex}] is out of range (corrected index: ${correctedSourceIndex})`);
      }
    }
    
    // Remove duplicates and sort by source index
    const uniqueCitations = this.removeDuplicateSimplifiedCitations(validCitations)
      .sort((a, b) => a.sourceIndex - b.sourceIndex);
    
    // Renumber citations in response
    const renumberedResponse = this.renumberSimplifiedCitations(response, uniqueCitations);
    
    console.log('[SIMPLIFIED RESULT]', {
      originalCitations: citationMatches.length,
      validCitations: validCitations.length,
      uniqueCitations: uniqueCitations.length,
      rejectedCitations: citationMatches.length - validCitations.length,
      pageGroups: pageGroups.length,
      validationWarnings: validationWarnings.length
    });
    
    if (validationWarnings.length > 0) {
      console.log('[VALIDATION WARNINGS]', validationWarnings);
    }
    
    console.log('=== SIMPLIFIED CITATION PROCESSING END ===\n');
    
    return {
      citations: uniqueCitations,
      renumberedResponse,
      usedSourceIndices: Array.from(usedSourceIndices).sort((a, b) => a - b),
      validationWarnings
    };
  }

  /**
   * Derive citations from response content when model didn't emit [n].
   * This keeps answer text and references grounded to retrieved chunks/pages.
   */
  private deriveCitationsFromResponseContent(
    response: string,
    pageGroups: PageGroup[]
  ): SimplifiedCitationGroup {
    const candidates = pageGroups
      .map((pg) => {
        const combinedContent = pg.chunks.map((c) => c.content).join('\n---\n');
        const maxSimilarity = Math.max(...pg.chunks.map((c) => c.similarity));
        return {
          pageGroup: pg,
          combinedContent,
          maxSimilarity,
        };
      })
      .filter((c) => {
        const text = c.combinedContent.replace(/\s+/g, ' ').trim();
        const words = text.split(/\s+/).filter(Boolean);
        const uniqueWords = new Set(words.map((w) => w.toLowerCase())).size;
        return text.length >= 220 && words.length >= 35 && uniqueWords >= 18;
      });

    const lines = response.split('\n');
    const taggedLines: string[] = [];
    const markerOrder: number[] = [];

    const pushMarkerOrder = (idx: number) => {
      if (!markerOrder.includes(idx)) markerOrder.push(idx);
    };

    for (const originalLine of lines) {
      const trimmed = originalLine.trim();
      if (trimmed.length < 40) {
        taggedLines.push(originalLine);
        continue;
      }

      // Skip obvious headings/separators/code blocks.
      if (/^#{1,6}\s/.test(trimmed) || /^[-*_]{3,}$/.test(trimmed) || /^```/.test(trimmed)) {
        taggedLines.push(originalLine);
        continue;
      }

      // Skip if line already has a citation-like marker.
      if (/\[\s*\d+[^\]]*\]/.test(trimmed)) {
        taggedLines.push(originalLine);
        continue;
      }

      const lineForMatch = trimmed
        .replace(/^[-*•]\s+/, '')
        .replace(/^\d+\.\s+/, '')
        .replace(/^\u2705\s+/, '')
        .trim();

      let bestIndex = -1;
      let bestScore = 0;

      for (let i = 0; i < candidates.length; i++) {
        const score = this.quickLineSourceScore(lineForMatch, candidates[i].combinedContent);
        if (score > bestScore) {
          bestScore = score;
          bestIndex = i;
        }
      }

      if (bestIndex >= 0 && bestScore >= 0.12) {
        pushMarkerOrder(bestIndex);
        const marker = `[§${bestIndex}]`;
        const lineWithMarker = /[.,;:!?]\s*$/.test(originalLine)
          ? originalLine.replace(/([.,;:!?])\s*$/, ` ${marker}$1`)
          : `${originalLine} ${marker}`;
        taggedLines.push(lineWithMarker);
      } else {
        taggedLines.push(originalLine);
      }
    }

    if (markerOrder.length === 0) {
      return {
        citations: [],
        renumberedResponse: response,
        usedSourceIndices: [],
        validationWarnings: ['Could not derive citations from response content'],
      };
    }

    const indexMap = new Map<number, number>();
    markerOrder.forEach((candidateIdx, i) => indexMap.set(candidateIdx, i + 1));

    const renumberedResponse = taggedLines
      .join('\n')
      .replace(/\[§(\d+)\]/g, (_m, g1: string) => {
        const candidateIdx = parseInt(g1, 10);
        const mapped = indexMap.get(candidateIdx);
        return mapped ? `[${mapped}]` : '';
      })
      .replace(/ +([.,;:!])/g, '$1')
      .trim();

    const citations: SimplifiedCitation[] = markerOrder.map((candidateIdx, i) => {
      const candidate = candidates[candidateIdx];
      return {
        document: candidate.pageGroup.documentTitle,
        page: candidate.pageGroup.page,
        combinedContent: candidate.combinedContent,
        sourceIndex: i + 1,
        chunkIds: candidate.pageGroup.chunks.map((c) => c.id),
        similarity: candidate.maxSimilarity,
      };
    });

    return {
      citations,
      renumberedResponse,
      usedSourceIndices: citations.map((c) => c.sourceIndex),
      validationWarnings: [],
    };
  }

  /**
   * Fast line-to-source relevance score for fallback citation assignment.
   */
  private quickLineSourceScore(line: string, sourceContent: string): number {
    const a = this.normalizeTextForComparison(line);
    const b = this.normalizeTextForComparison(sourceContent);
    if (!a || !b) return 0;

    const wordsA = new Set(a.split(/\s+/).filter((w) => w.length > 2));
    const wordsB = new Set(b.split(/\s+/).filter((w) => w.length > 2));
    if (wordsA.size === 0 || wordsB.size === 0) return 0;

    let intersection = 0;
    wordsA.forEach((w) => {
      if (wordsB.has(w)) intersection++;
    });

    const cosineLike = intersection / Math.sqrt(wordsA.size * wordsB.size);

    // Small phrase bonus.
    let phraseBonus = 0;
    const longTokens = Array.from(wordsA).filter((w) => w.length >= 6);
    for (const token of longTokens.slice(0, 6)) {
      if (b.includes(token)) {
        phraseBonus += 0.02;
      }
    }

    return Math.min(1, cosineLike + phraseBonus);
  }

  /**
   * Group search results by document and page
   */
  private groupByPage(searchResults: VectorSearchResult[]): PageGroup[] {
    const pageMap = new Map<string, PageGroup>();
    
    for (const result of searchResults) {
      const pageNumber = this.getEffectivePageNumber(result);
      
      if (pageNumber !== undefined) {
        const pageKey = `${result.document.id}_${pageNumber}`;
        
        if (!pageMap.has(pageKey)) {
          pageMap.set(pageKey, {
            documentId: result.document.id,
            documentTitle: result.document.title || result.document.fileName,
            page: pageNumber,
            chunks: []
          });
        }
        
        const pageGroup = pageMap.get(pageKey)!;
        pageGroup.chunks.push({
          id: result.chunk.id,
          content: result.chunk.content,
          similarity: result.similarity
        });
      }
    }
    
    return Array.from(pageMap.values());
  }

  /**
   * Get effective page number from search result
   */
  private getEffectivePageNumber(result: VectorSearchResult): number | undefined {
    // Priority 1: metadata.pageNumbers (for combined chunks)
    if (result.chunk.metadata?.pageNumbers && result.chunk.metadata.pageNumbers.length > 0) {
      return result.chunk.metadata.pageNumbers[0];
    }
    
    // Priority 2: chunk.page
    if (result.chunk.page && result.chunk.page > 0) {
      return result.chunk.page;
    }
    
    // Priority 3: metadata.pageNumber
    if (result.chunk.metadata?.pageNumber && result.chunk.metadata.pageNumber > 0) {
      return result.chunk.metadata.pageNumber;
    }
    
    // Priority 4: Extract from content
    const pagePatterns = [
      /page\s+(\d+)/i,
      /p\.?\s*(\d+)/i,
      /第(\d+)页/,
      /page\s+(\d+)\s+of/i,
    ];

    for (const pattern of pagePatterns) {
      const match = result.chunk.content.match(pattern);
      if (match && match[1]) {
        const extractedPage = parseInt(match[1], 10);
        if (extractedPage > 0) {
          return extractedPage;
        }
      }
    }
    
    return undefined;
  }

  /**
   * Remove duplicate simplified citations
   */
  private removeDuplicateSimplifiedCitations(citations: SimplifiedCitation[]): SimplifiedCitation[] {
    const seen = new Set<string>();
    const unique: SimplifiedCitation[] = [];

    for (const citation of citations) {
      const key = `${citation.document}_${citation.page}`;
      
      if (!seen.has(key)) {
        seen.add(key);
        unique.push(citation);
      }
    }

    return unique;
  }

  /**
   * Renumber citations in simplified response
   * FIXED: Handles comma-separated citations
   */
  private renumberSimplifiedCitations(
    response: string,
    citations: SimplifiedCitation[]
  ): string {
    console.log('\n=== CITATION RENUMBERING DEBUG START ===');
    console.log('[RENAMING INPUT]', {
      responseLength: response.length,
      hasNewlines: response.includes('\n'),
      newlineCount: (response.match(/\n/g) || []).length,
      bulletCount: (response.match(/^\* /gm) || []).length,
      firstFewLines: response.split('\n').slice(0, 5)
    });
    
    let renumbered = response;
    
    // Create set of valid source indices
    const validSourceIndices = new Set(citations.map(c => c.sourceIndex));
    
    // Create mapping from original indices to new indices
    const indexMap = new Map<number, number>();
    citations.forEach((citation, newIndex) => {
      indexMap.set(citation.sourceIndex, newIndex + 1);
    });

    // Replace citation groups [1, 2, 3]
    const citationGroupPattern = /\[([^\]]+)\]/g;
    
    renumbered = renumbered.replace(citationGroupPattern, (match, innerContent) => {
        const indices = this.parseCitationIndices(innerContent);
        
        const newIndices = indices
            .filter((idx: number) => validSourceIndices.has(idx))
            .map((idx: number) => indexMap.get(idx))
            .filter((idx: number | undefined): idx is number => idx !== undefined)
            .sort((a: number, b: number) => a - b);
            
        if (newIndices.length === 0) return '';
        
        return `[${newIndices.join(', ')}]`;
    });

    // Clean up punctuation spacing
    renumbered = renumbered.replace(/ +([.,;:!])/g, '$1');
    
    console.log('=== CITATION RENUMBERING DEBUG END ===\n');

    return renumbered.trim();
  }

  /**
   * Format simplified citations for display
   */
  formatSimplifiedCitationsForDisplay(citations: SimplifiedCitation[]): string {
    if (citations.length === 0) {
      return '';
    }

    const sources = citations.map((citation, index) => {
      return `${index + 1}. ${citation.document}. Page ${citation.page}`;
    });

    return '\n\n**Vancouver Style References:**\n' + sources.join('\n');
  }

  /**
   * Convert simplified citations to message citation format for storage
   */
  convertSimplifiedToMessageCitations(citations: SimplifiedCitation[]): MessageCitation[] {
    return citations.map((citation, index) => ({
      document: citation.document,
      page: citation.page,
      excerpt: citation.combinedContent,
      // Store additional metadata for debugging
      chunkIds: citation.chunkIds,
      similarity: citation.similarity
    }));
  }
}

// Singleton instance
export const citationService = new CitationService();
