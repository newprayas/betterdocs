import { geminiService } from './geminiService';
import type { Message } from '@/types/message';
import type { VectorSearchResult } from '@/types/embedding';
import type { AppSettings } from '@/types/settings';

export interface ChatStreamEvent {
  type: 'start' | 'chunk' | 'citation' | 'progress' | 'thinking' | 'end' | 'error' | 'status' | 'textChunk' | 'citations' | 'done';
  content?: string;
  citation?: any;
  error?: string;
  message?: string;
  citations?: any[];
  progress?: {
    stage: 'embedding' | 'searching' | 'generating' | 'processing';
    percentage: number;
    message: string;
  };
  metadata?: {
    tokensGenerated?: number;
    tokensPerSecond?: number;
    timeElapsed?: number;
  };
}

export class ChatService {
  async generateResponse(
    messages: Message[],
    context: VectorSearchResult[],
    settings: AppSettings
  ): Promise<string> {
    try {
      const contextText = this.buildContext(context);
      const prompt = this.buildPrompt(messages[messages.length - 1]?.content || '', contextText);

      return await geminiService.generateResponse(
        prompt,
        undefined,
        undefined,
        {
          temperature: settings.temperature,
          maxTokens: settings.maxTokens,
        }
      );
    } catch (error) {
      console.error('Error generating chat response:', error);
      throw new Error('Failed to generate chat response');
    }
  }

  async generateStreamingResponse(
    messages: Message[],
    context: VectorSearchResult[],
    settings: AppSettings,
    onEvent: (event: ChatStreamEvent) => void
  ): Promise<void> {
    try {
      const contextText = this.buildContext(context);
      const prompt = this.buildPrompt(messages[messages.length - 1]?.content || '', contextText);

      onEvent({ type: 'start' });

      const stream = await geminiService.generateStreamingResponse(
        prompt,
        undefined,
        undefined,
        {
          temperature: settings.temperature,
          maxTokens: settings.maxTokens,
          onChunk: (chunk: string) => {
            onEvent({ type: 'chunk', content: chunk });
          },
        }
      );

      // Process the stream
      let fullResponse = '';
      for await (const chunk of stream) {
        fullResponse += chunk;
      }

      // Extract citations if needed
      const citations = this.extractCitations(fullResponse, context);
      if (citations.length > 0) {
        onEvent({ type: 'citation', citation: citations });
      }

      onEvent({ type: 'end' });
    } catch (error) {
      console.error('Error generating streaming response:', error);
      onEvent({ 
        type: 'error', 
        error: error instanceof Error ? error.message : 'Unknown error occurred' 
      });
    }
  }

  private buildPrompt(userMessage: string, context: string): string {
    if (!context) {
      return `I cannot answer this question as no document context has been provided. Please upload relevant documents first.

Question: ${userMessage}`;
    }

    return `CRITICAL INSTRUCTIONS - READ CAREFULLY:
1. You MUST ONLY use information from the provided context below
2. You are FORBIDDEN from using any general knowledge or external information
3. If the context does not contain the answer, you MUST respond with "I cannot answer this question based on the provided documents."
4. Do NOT attempt to answer questions about topics not covered in the context
5. NEVER answer questions about current events, politics, celebrities, or general knowledge not in the documents
6. Every single statement you make must be directly supported by the provided context

CRITICAL CITATION ACCURACY REQUIREMENTS:
- BEFORE citing any source, VERIFY that the information you're presenting actually appears in that source
- Each citation [number] MUST reference a source that CONTAINS the specific information you're citing
- NEVER cite a source that discusses a different topic, even if it's related
- Example: If you're defining "cataract", ONLY cite sources that actually contain the cataract definition
- DO NOT cite sources about ophthalmoscopy or ultrasound when defining cataract
- Read each source carefully and ensure the content matches what you're claiming
- If you're unsure whether a source contains the information, DO NOT cite it
- It is BETTER to have fewer citations than to cite irrelevant sources

CITATION VERIFICATION PROCESS:
1. Make a factual claim
2. IMMEDIATELY check if the source [number] actually contains this information
3. If YES, add the citation
4. If NO, either find the correct source or remove the claim
5. Double-check: Does source [number] really say what I'm claiming?

VANCOUVER CITATION STYLE:
- Use numbered citations in square brackets: [1], [2], [3]
- Citations must be numbered sequentially in order they appear
- Place citations immediately after the information they support
- Every factual statement must have a citation
- Citations are mandatory for all claims
- WARNING: Citing incorrect sources will mislead users and is unacceptable

Context Documents:
${context}

Question: ${userMessage}

Remember: Answer ONLY using the provided context with proper Vancouver style citations. CITATION ACCURACY IS YOUR HIGHEST PRIORITY. If the context doesn't contain the answer, say so explicitly.`;
  }

  private buildContext(contextResults: VectorSearchResult[]): string {
    if (contextResults.length === 0) {
      return '';
    }

    return contextResults
      .map((result, index) => {
        const { chunk, document } = result;
        const source = document.title || document.fileName;
        const page = chunk.metadata.pageNumber ? ` (Page ${chunk.metadata.pageNumber})` : '';
        
        // Handle combined chunks with special formatting
        let contentPrefix = '';
        if (chunk.metadata.isCombined) {
          const chunkCount = chunk.metadata.originalChunkCount || 1;
          contentPrefix = `[Combined from ${chunkCount} chunks on this page]\n`;
        }
        
        return `[${index + 1}] From "${source}"${page}:
${contentPrefix}${chunk.content}`;
      })
      .join('\n\n');
  }

  private extractCitations(response: string, context: VectorSearchResult[]): any[] {
    // Enhanced citation extraction with validation
    const citationPattern = /\[(\d+)\]/g;
    const citations: any[] = [];
    const usedIndices = new Set<number>();
    let match;
    
    while ((match = citationPattern.exec(response)) !== null) {
      const originalIndex = parseInt(match[1], 10);
      const zeroBasedIndex = originalIndex - 1; // Convert to 0-based index
      
      // Validate citation index is within range
      if (zeroBasedIndex >= 0 && zeroBasedIndex < context.length) {
        const result = context[zeroBasedIndex];
        
        // Skip duplicates
        const citationKey = `${result.document.title || result.document.fileName}_${result.chunk.metadata?.pageNumber || 'unknown'}`;
        if (!usedIndices.has(zeroBasedIndex)) {
          usedIndices.add(zeroBasedIndex);
          
          // Create citation with enhanced metadata for combined chunks
          const citation: any = {
            document: result.document.title || result.document.fileName,
            page: result.chunk.metadata.pageNumber,
            excerpt: result.chunk.content, // Use full content (which may be combined)
            sourceIndex: originalIndex,
            chunkId: result.chunk.id,
          };
          
          // Add combined chunk metadata if applicable
          if (result.chunk.metadata.isCombined) {
            citation.isCombined = true;
            citation.originalChunkCount = result.chunk.metadata.originalChunkCount;
            citation.combinedChunkIds = result.chunk.metadata.combinedChunkIds;
          }
          
          citations.push(citation);
        }
      } else {
        console.warn(`Invalid citation [${originalIndex}]: Index out of range (available: 1-${context.length})`);
      }
    }

    return citations;
  }

  async validateResponse(response: string): Promise<boolean> {
    try {
      // Basic validation checks
      if (!response || response.trim().length === 0) {
        return false;
      }

      // Check for reasonable length
      if (response.length > 10000) {
        return false;
      }

      // Check for coherent text (basic check)
      const words = response.split(/\s+/);
      if (words.length < 3) {
        return false;
      }

      return true;
    } catch (error) {
      console.error('Error validating response:', error);
      return false;
    }
  }

  formatResponse(response: string, citations: any[] = []): string {
    let formatted = response;

    // Add citation sources at the end if citations exist
    if (citations.length > 0) {
      formatted += '\n\nSources:\n';
      citations.forEach((citation, index) => {
        const pageInfo = citation.page ? `, Page ${citation.page}` : '';
        formatted += `${index + 1}. ${citation.document}${pageInfo}\n`;
      });
    }

    return formatted;
  }

  async generateTitle(firstMessage: string): Promise<string> {
    try {
      const prompt = `Generate a short, descriptive title (max 5 words) for a conversation that starts with this message: "${firstMessage}"`;
      
      const title = await geminiService.generateResponse(prompt);
      
      // Clean up and truncate if needed
      return title
        .replace(/^["']|["']$/g, '') // Remove quotes
        .substring(0, 50)
        .trim();
    } catch (error) {
      console.error('Error generating title:', error);
      // Fallback to first few words of the message
      return firstMessage
        .split(/\s+/)
        .slice(0, 5)
        .join(' ')
        .substring(0, 50);
    }
  }

  /**
   * Estimate token count from text (rough approximation)
   */
  private estimateTokenCount(text: string): number {
    // Rough estimation: ~4 characters per token for English
    return Math.ceil(text.length / 4);
  }

  /**
   * Validate streaming response in real-time
   */
  private validateStreamingChunk(chunk: string, fullResponse: string): {
    isValid: boolean;
    warnings: string[];
  } {
    const warnings: string[] = [];
    let isValid = true;

    // Check for repeated content (possible loops)
    if (fullResponse.length > 100 && chunk.length > 0) {
      const recentText = fullResponse.slice(-100);
      if (recentText.includes(chunk) && chunk.length > 10) {
        warnings.push('Possible content repetition detected');
        isValid = false;
      }
    }

    // Check for excessive citation density
    const citationMatches = (fullResponse + chunk).match(/\[\d+\]/g);
    if (citationMatches && citationMatches.length > 10) {
      warnings.push('High citation density detected');
    }

    return { isValid, warnings };
  }

  /**
   * Detect if response is getting too long
   */
  private isResponseTooLong(response: string, maxTokens: number): boolean {
    const estimatedTokens = this.estimateTokenCount(response);
    return estimatedTokens > maxTokens * 0.9; // 90% of max tokens
  }

  /**
   * Extract citations in real-time as they appear with validation
   */
  private extractCitationsRealTime(text: string, context: VectorSearchResult[]): Array<{
    index: number;
    position: number;
    citation: any;
  }> {
    const citationPattern = /\[(\d+)\]/g;
    const citations: Array<{ index: number; position: number; citation: any }> = [];
    const usedIndices = new Set<number>();
    let match;

    while ((match = citationPattern.exec(text)) !== null) {
      const originalIndex = parseInt(match[1], 10);
      const zeroBasedIndex = originalIndex - 1; // Convert to 0-based index
      
      // Validate citation index
      if (zeroBasedIndex >= 0 && zeroBasedIndex < context.length) {
        // Skip duplicates
        if (!usedIndices.has(zeroBasedIndex)) {
          usedIndices.add(zeroBasedIndex);
          const result = context[zeroBasedIndex];
          
          // Create citation with enhanced metadata for combined chunks
          const citation: any = {
            document: result.document.title || result.document.fileName,
            page: result.chunk.metadata.pageNumber,
            excerpt: result.chunk.content, // Use full content (which may be combined)
            sourceIndex: originalIndex,
            chunkId: result.chunk.id,
          };
          
          // Add combined chunk metadata if applicable
          if (result.chunk.metadata.isCombined) {
            citation.isCombined = true;
            citation.originalChunkCount = result.chunk.metadata.originalChunkCount;
            citation.combinedChunkIds = result.chunk.metadata.combinedChunkIds;
          }
          
          citations.push({
            index: originalIndex, // Keep 1-based for display
            position: match.index,
            citation,
          });
        }
      } else {
        console.warn(`Invalid citation [${originalIndex}] in real-time extraction: Index out of range (available: 1-${context.length})`);
      }
    }

    return citations;
  }
}

// Singleton instance
export const chatService = new ChatService();