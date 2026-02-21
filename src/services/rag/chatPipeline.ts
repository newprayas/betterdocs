import { getIndexedDBServices } from '../indexedDB';
import { chatService, embeddingService } from '../gemini';
import { groqService } from '../groq/groqService';
import { vectorSearchService } from './vectorSearch';
import { documentProcessor } from './documentProcessor';
import { citationService } from './citationService';
import { ResponseFormatter } from './responseFormatter';
import { MessageSender, type MessageCreate, type Message } from '@/types';
import type { ChatStreamEvent } from '../gemini/chatService';
import type { SimplifiedCitationGroup } from '@/types/citation';
import type { EmbeddingChunk, VectorSearchResult } from '@/types/embedding';
import { cosineSimilarity } from '@/utils/vectorUtils';

export class ChatPipeline {
  private indexedDBServices = getIndexedDBServices();

  /**
   * Enhance user query with context information
   */
  private async enhanceQueryWithContext(sessionId: string, content: string): Promise<string> {
    try {
      console.log('\n=== QUERY ENHANCEMENT PROCESS START ===');
      console.log('[ORIGINAL QUERY]', content);

      // Get session information
      const session = await this.indexedDBServices.sessionService.getSession(sessionId);
      const sessionName = session?.name || 'Unknown Session';
      console.log('[SESSION INFO]', `Name: ${sessionName}, ID: ${sessionId}`);

      // Get enabled documents for the session
      if (!session) {
        console.log('[CONTEXT ENHANCEMENT]', 'Session not found - returning original query');
        console.log('=== QUERY ENHANCEMENT PROCESS END ===\n');
        return content;
      }
      const enabledDocuments = await this.indexedDBServices.documentService.getEnabledDocumentsBySession(sessionId, session.userId);
      console.log('[DOCUMENTS FOUND]', `${enabledDocuments.length} enabled documents`);

      // Extract document names (use title if available, otherwise filename)
      const documentNames = enabledDocuments.map(doc => doc.title || doc.filename).filter(Boolean);

      // If no documents are enabled, return the original query
      if (documentNames.length === 0) {
        console.log('[CONTEXT ENHANCEMENT]', 'No enabled documents found - returning original query');
        console.log('=== QUERY ENHANCEMENT PROCESS END ===\n');
        return content;
      }

      // Format the related documents string
      const relatedDocuments = documentNames.join(', ');
      console.log('[CONTEXT DOCUMENTS]', relatedDocuments);

      // Create the enhanced query with context
      const enhancedQuery = `${content} [Context - ${sessionName} and related to ${relatedDocuments}]`;

      console.log('[ENHANCED QUERY]', enhancedQuery);
      console.log('=== QUERY ENHANCEMENT PROCESS END ===\n');

      return enhancedQuery;
    } catch (error) {
      console.error('[CONTEXT ENHANCEMENT ERROR]', error);
      console.log('=== QUERY ENHANCEMENT PROCESS END (WITH ERROR) ===\n');
      // If there's an error, return the original query
      return content;
    }
  }

  private normalizeCommonMedicalTypos(text: string): string {
    return text
      .replace(/\bmanamgnet\b/gi, 'management')
      .replace(/\bmanagment\b/gi, 'management')
      .replace(/\bmanagemnt\b/gi, 'management')
      .replace(/\btrematnet\b/gi, 'treatment')
      .replace(/\btretment\b/gi, 'treatment')
      .replace(/\buclers\b/gi, 'ulcers')
      .replace(/\bulser\b/gi, 'ulcer')
      .replace(/\bdiffren(?:t|ti)ate\b/gi, 'differentiate');
  }

  private sanitizeRewriterOutput(raw: string): string {
    const firstLine = raw
      .split('\n')
      .map((line) => line.trim())
      .find((line) => line.length > 0) || '';

    return firstLine
      .replace(/^standalone\s+query\s*:\s*/i, '')
      .replace(/^rewritten\s+query\s*:\s*/i, '')
      .replace(/^[-*]\s+/, '')
      .replace(/^["'`]|["'`]$/g, '')
      .trim();
  }

  private isInsufficientEvidenceResponse(text: string): boolean {
    const normalized = text.toLowerCase().replace(/\s+/g, ' ').trim();
    if (!normalized) return false;
    return (
      normalized.includes('i cannot answer this question based on the provided documents') ||
      normalized.includes('cannot answer this question based on the provided documents') ||
      normalized.includes('insufficient information in the provided documents') ||
      normalized.includes('not enough information in the provided documents')
    );
  }

  private getChunkPageNumber(chunk: EmbeddingChunk): number | null {
    if (chunk.page && chunk.page > 0) return chunk.page;
    if (chunk.metadata?.pageNumber && chunk.metadata.pageNumber > 0) return chunk.metadata.pageNumber;
    if (chunk.metadata?.pageNumbers && chunk.metadata.pageNumbers.length > 0) {
      const first = chunk.metadata.pageNumbers.find((p) => p > 0);
      if (first) return first;
    }
    return null;
  }

  private includeNeighborPageChunks(
    baseResults: VectorSearchResult[],
    sessionEmbeddings: EmbeddingChunk[],
    queryEmbedding: Float32Array,
    minSimilarity: number = 0.6
  ): VectorSearchResult[] {
    if (baseResults.length === 0 || sessionEmbeddings.length === 0) {
      console.log(
        '[NEIGHBOR PAGES] Skipped (insufficient input): baseResults=%d embeddings=%d',
        baseResults.length,
        sessionEmbeddings.length
      );
      return baseResults;
    }

    const existingChunkIds = new Set(baseResults.map((r) => r.chunk.id));
    const docInfoById = new Map(baseResults.map((r) => [r.document.id, r.document]));
    const pagesByDoc = new Map<string, number[]>();
    const targetNeighborPages = new Set<string>();

    for (const result of baseResults) {
      const page = this.getChunkPageNumber(result.chunk);
      if (!page) continue;
      const current = pagesByDoc.get(result.document.id) || [];
      current.push(page);
      pagesByDoc.set(result.document.id, current);
    }

    for (const [documentId, pages] of pagesByDoc.entries()) {
      if (pages.length === 0) continue;

      const uniqueSortedPages = Array.from(new Set(pages)).sort((a, b) => a - b);
      let blockStart = uniqueSortedPages[0];
      let previous = uniqueSortedPages[0];

      for (let i = 1; i < uniqueSortedPages.length; i++) {
        const current = uniqueSortedPages[i];
        if (current === previous + 1) {
          previous = current;
          continue;
        }

        // Close previous contiguous block [blockStart..previous]
        if (blockStart > 1) {
          targetNeighborPages.add(`${documentId}:${blockStart - 1}`);
        }
        targetNeighborPages.add(`${documentId}:${previous + 1}`);

        // Start a new block.
        blockStart = current;
        previous = current;
      }

      // Close final block.
      if (blockStart > 1) {
        targetNeighborPages.add(`${documentId}:${blockStart - 1}`);
      }
      targetNeighborPages.add(`${documentId}:${previous + 1}`);
    }

    const targetNeighborPageList = Array.from(targetNeighborPages).sort();
    console.log(
      '[NEIGHBOR PAGES] Candidate edge pages=%d threshold=%.2f pages=%o',
      targetNeighborPageList.length,
      minSimilarity,
      targetNeighborPageList
    );

    if (targetNeighborPages.size === 0) {
      console.log('[NEIGHBOR PAGES] No candidate edge pages from retrieved blocks.');
      return baseResults;
    }

    const bestCandidateByPage = new Map<string, { chunk: EmbeddingChunk; similarity: number }>();
    let matchedNeighborPageChunks = 0;
    let passedThresholdChunks = 0;
    for (const chunk of sessionEmbeddings) {
      if (existingChunkIds.has(chunk.id)) continue;

      const page = this.getChunkPageNumber(chunk);
      if (!page) continue;

      const pageKey = `${chunk.documentId}:${page}`;
      if (!targetNeighborPages.has(pageKey)) continue;
      matchedNeighborPageChunks += 1;

      const similarity = cosineSimilarity(queryEmbedding, chunk.embedding);
      if (similarity < minSimilarity) continue;
      passedThresholdChunks += 1;

      const current = bestCandidateByPage.get(pageKey);
      if (!current || similarity > current.similarity) {
        bestCandidateByPage.set(pageKey, { chunk, similarity });
      }
    }

    const additions = Array.from(bestCandidateByPage.values())
      .sort((a, b) => b.similarity - a.similarity)
      .map(({ chunk, similarity }) => {
        const existingDocInfo = docInfoById.get(chunk.documentId);
        const title = existingDocInfo?.title || chunk.metadata?.documentTitle || chunk.source || 'Document';
        const fileName = existingDocInfo?.fileName || chunk.source || title;
        return {
          chunk,
          similarity,
          document: {
            id: chunk.documentId,
            title,
            fileName
          }
        } as VectorSearchResult;
      });

    if (additions.length > 0) {
      console.log(
        '[NEIGHBOR PAGES] Added %d edge-neighbor chunk(s) [threshold=%.2f]: %o',
        additions.length,
        minSimilarity,
        additions.map((r) => ({
          chunkId: r.chunk.id,
          documentId: r.document.id,
          page: this.getChunkPageNumber(r.chunk),
          similarity: r.similarity
        }))
      );
    } else {
      console.log(
        '[NEIGHBOR PAGES] Attempted but added 0 chunk(s): candidatePages=%d matchedChunks=%d passedThreshold=%d threshold=%.2f',
        targetNeighborPages.size,
        matchedNeighborPageChunks,
        passedThresholdChunks,
        minSimilarity
      );
    }

    return [...baseResults, ...additions].sort((a, b) => b.similarity - a.similarity);
  }

  /**
   * Rewrites the user query based on chat history to make it standalone.
   * Solves the "What are its causes?" problem.
   */
  private async generateStandaloneQuery(
    content: string,
    history: any[]
  ): Promise<string> {
    const normalizedOriginal = this.normalizeCommonMedicalTypos(content.trim().replace(/\s+/g, ' '));
    const recentHistory = (history || []).slice(-6).map(msg =>
      `${msg.role === 'user' ? 'User' : 'Assistant'}: ${msg.content}`
    ).join('\n');

    const prompt = `
Task: Rewrite the user's latest query into ONE standalone medical search query.

Rules:
1) Keep the user's intent exactly.
2) Resolve pronouns using conversation history (it/this/that/they).
3) Fix spelling/typos (medical and non-medical).
4) If query has fewer than 3 words, expand it into a clear natural query.
5) Normalize common short forms when useful:
   - rx/tx -> treatment/management
   - dx -> diagnosis
   - inv -> investigations
6) Do NOT answer the question.
7) Output ONLY the rewritten query text in one line.

Conversation History:
${recentHistory || 'No prior history'}

Latest User Query:
${normalizedOriginal}
`.trim();

    try {
      const rewrittenQuery = await groqService.generateResponse(
        prompt,
        "You rewrite medical search queries for retrieval.",
        'llama3.1-8b',
        {
          temperature: 0.1,
          maxTokens: 80,
        }
      );

      const cleanedQuery = this.sanitizeRewriterOutput(rewrittenQuery);

      // Tiny guardrail #1: reject empty/1-word rewrite.
      const wordCount = cleanedQuery.split(/\s+/).filter(Boolean).length;
      if (!cleanedQuery || wordCount <= 1) {
        console.warn('[QUERY REWRITER]', `Rejected weak rewrite "${cleanedQuery}". Falling back to "${normalizedOriginal}"`);
        return normalizedOriginal;
      }

      console.log('[QUERY REWRITER]', `Original: "${normalizedOriginal}" -> Rewritten: "${cleanedQuery}"`);
      return cleanedQuery;

    } catch (error) {
      console.error('[QUERY REWRITER ERROR]', error);
      return normalizedOriginal;
    }
  }

  /**
   * Send a message and get AI response with RAG context
   */
  async sendMessage(
    sessionId: string,
    content: string,
    onStreamEvent?: (event: ChatStreamEvent) => void,
    userMessage?: MessageCreate
  ): Promise<void> {
    try {
      console.log('\n=== CHAT PIPELINE PROCESS START ===');
      console.log('[USER INPUT]', `Session: ${sessionId}, Query: "${content}"`);

      // User message is now passed in as a parameter (already saved in chatStore)
      console.log('[MESSAGE STATUS]', 'User message already stored in database by chatStore');

      // Update progress: Query Rewriting (25%)
      if (onStreamEvent) {
        onStreamEvent({ type: 'status', message: 'Query Rewriting' });
      }
      // Note: We'll update the store progress in the chatStore's sendMessage function

      // Get enabled documents for the session
      const sessionForDocuments = await this.indexedDBServices.sessionService.getSession(sessionId);
      if (!sessionForDocuments) {
        throw new Error('Session not found');
      }

      // 1. FETCH HISTORY (NEW STEP)
      // We need the history BEFORE we do the search
      console.log('[HISTORY]', 'Fetching chat history for context awareness...');
      const history = await this.indexedDBServices.messageService.getMessagesBySession(
        sessionId,
        sessionForDocuments.userId
      );

      // Get Settings for model info
      const settings = await this.indexedDBServices.settingsService.getSettings(sessionForDocuments.userId);
      const retrievalMode = settings?.retrievalMode || 'legacy_hybrid';
      console.log('[RETRIEVAL MODE]', retrievalMode);

      // 2. GENERATE STANDALONE QUERY (NEW STEP)
      // This converts "What are its causes?" -> "What are the causes of cataract?"
      console.log('[REWRITING]', 'Generating standalone query...');
      const standaloneQuery = await this.generateStandaloneQuery(content, history);

      // 🔴 PROMINENT LOG: Show the converted query for tracking
      console.log('🔴 Converted query -:', `"${standaloneQuery}"`);

      // Update progress: Embedding Generation (50%)
      if (onStreamEvent) {
        onStreamEvent({ type: 'status', message: 'Embedding Generation' });
      }

      // 3. ENHANCE THE REWRITTEN QUERY, NOT THE ORIGINAL
      // Modify this line to pass 'standaloneQuery' instead of 'content'
      const enhancedQuery = await this.enhanceQueryWithContext(sessionId, standaloneQuery);
      const retrievalQuery = enhancedQuery;
      console.log('[FINAL SEARCH QUERY]', enhancedQuery);

      const documents = await this.indexedDBServices.documentService.getDocumentsBySession(sessionId, sessionForDocuments.userId);
      console.log('[DOCUMENT STATUS]', `Found ${documents.length} total documents in session ${sessionId}`);
      console.log('[DOCUMENT STATUS]', 'Document details:', documents.map(doc => ({
        id: doc.id,
        filename: doc.filename,
        enabled: doc.enabled,
        status: doc.status
      })));

      const enabledDocuments = documents.filter(doc => doc.enabled);
      console.log('[DOCUMENT STATUS]', `${enabledDocuments.length}/${documents.length} documents enabled`);

      // Also check if there are any embeddings available for enabled documents
      const indexedDBEmbeddingService = this.indexedDBServices.embeddingService;
      let embeddings: EmbeddingChunk[] = [];

      if (enabledDocuments.length > 0) {
        embeddings = await indexedDBEmbeddingService.getEnabledEmbeddingsBySession(sessionId, sessionForDocuments.userId);
      }

      console.log('[EMBEDDING STATUS]', `${embeddings.length} embeddings found for enabled documents`);

      if (enabledDocuments.length === 0 || embeddings.length === 0) {
        // No enabled documents or no embeddings available, just chat without context
        console.log('[PROCESSING MODE]', 'Direct response (no RAG context available)');
        await this.generateDirectResponse(sessionId, content, onStreamEvent);
        console.log('=== CHAT PIPELINE PROCESS END ===\n');
        return;
      }

      // 4. GENERATE EMBEDDING USING THE REWRITTEN QUERY
      console.log('[EMBEDDING GENERATION]', 'Creating vector embedding for enhanced query...');
      const queryEmbedding = await embeddingService.generateEmbedding(retrievalQuery);
      console.log('[EMBEDDING GENERATED]', `Vector created with ${queryEmbedding.length} dimensions`);

      // Update progress: Vector Search (75%)
      if (onStreamEvent) {
        onStreamEvent({ type: 'status', message: 'Vector Search' });
      }

      // 5. PERFORM SEARCH USING THE REWRITTEN QUERY
      console.log('[VECTOR SEARCH]', 'Performing hybrid search...');
      let searchResults = await vectorSearchService.searchHybridEnhanced(
        queryEmbedding,
        sessionId,
        retrievalQuery, // Use retrieval-expanded query for better recall
        {
          maxResults: 12,
          useDynamicWeighting: true,
          textWeight: 0.3,
          vectorWeight: 0.7,
          retrievalMode,
          userId: sessionForDocuments.userId // Ensure userId is passed
        }
      );

      // Safety net: if rewrite caused zero-hit retrieval, retry once with the original user query.
      if (searchResults.length === 0 && standaloneQuery.trim().toLowerCase() !== content.trim().toLowerCase()) {
        console.warn('[SEARCH FALLBACK]', 'No results for rewritten query. Retrying with original query.');
        const fallbackEnhancedQuery = await this.enhanceQueryWithContext(sessionId, content);
        const fallbackRetrievalQuery = fallbackEnhancedQuery;
        const fallbackEmbedding = await embeddingService.generateEmbedding(fallbackRetrievalQuery);
        const fallbackResults = await vectorSearchService.searchHybridEnhanced(
          fallbackEmbedding,
          sessionId,
          fallbackRetrievalQuery,
          {
            maxResults: 12,
            useDynamicWeighting: true,
            textWeight: 0.3,
            vectorWeight: 0.7,
            retrievalMode,
            userId: sessionForDocuments.userId
          }
        );
        if (fallbackResults.length > 0) {
          console.log('[SEARCH FALLBACK]', `Recovered ${fallbackResults.length} result(s) using original query.`);
          searchResults = fallbackResults;
        }
      }

      // Neighbor-page inclusion: include page N-1 / N+1 chunks to preserve section continuity.
      searchResults = this.includeNeighborPageChunks(searchResults, embeddings, queryEmbedding, 0.6);

      console.log('[SEARCH RESULTS]', `${searchResults.length} relevant chunks found`);
      console.log('✅ CHUNKS USED =', searchResults.length);

      // Update progress: Response Generation (90%)
      if (onStreamEvent) {
        onStreamEvent({ type: 'status', message: 'Response Generation' });
      }

      // Log detailed search results for debugging
      console.log('[SEARCH RESULTS DETAIL]', 'Detailed search results:');
      searchResults.forEach((result, index) => {
        console.log(`[SEARCH RESULT ${index}]`, {
          chunkId: result.chunk.id,
          documentTitle: result.document.title,
          similarity: result.similarity,
          chunkPage: result.chunk.page,
          metadataPageNumber: result.chunk.metadata?.pageNumber,
          isCombined: result.chunk.metadata?.isCombined,
          originalChunkCount: result.chunk.metadata?.originalChunkCount,
          combinedChunkIds: result.chunk.metadata?.combinedChunkIds,
          contentPreview: result.chunk.content.substring(0, 150) + '...'
        });
      });

      // Build context from search results
      console.log('[CONTEXT BUILDING]', 'Constructing context from search results...');
      const context = this.buildContext(searchResults);
      console.log('[CONTEXT CREATED]', `Context string length: ${context.length} characters`);

      // ... The rest of the function (Context Building, LLM Generation) remains the same ...
      // IMPORTANT: The final LLM call (generateSimplifiedContextualResponse)
      // should use the standalone query for better context understanding

      await this.generateSimplifiedContextualResponse(
        sessionId,
        standaloneQuery, // Use the rewritten query instead of original content
        this.buildContext(searchResults),
        searchResults,
        onStreamEvent
      );

      console.log('=== CHAT PIPELINE PROCESS END ===\n');

    } catch (error) {
      console.error('[PIPELINE ERROR]', 'Error in chat pipeline:', error);

      // Save error message
      const errorMessage: MessageCreate = {
        sessionId,
        content: 'Sorry, I encountered an error while processing your message. Please try again.',
        role: MessageSender.ASSISTANT,
      };

      await this.indexedDBServices.messageService.createMessage(errorMessage);
      console.log('[ERROR HANDLED]', 'Error message saved to database');
      console.log('=== CHAT PIPELINE PROCESS END (WITH ERROR) ===\n');
    }
  }

  /**
   * Generate response without document context
   */
  private async generateDirectResponse(
    sessionId: string,
    content: string,
    onStreamEvent?: (event: ChatStreamEvent) => void
  ): Promise<void> {
    console.log('\n=== DIRECT RESPONSE MODE (NO RAG) ===');
    console.log('[DIRECT MODE]', 'Generating response without document context');

    // Generate direct response without context
    // Generate direct response without context
    const session = await this.indexedDBServices.sessionService.getSession(sessionId);
    if (!session) {
      throw new Error('Session not found');
    }

    const settings = await this.indexedDBServices.settingsService.getSettings(session.userId);
    const messages = await this.indexedDBServices.messageService.getMessagesBySession(sessionId, session.userId);
    console.log('[CHAT HISTORY]', `Found ${messages.length} previous messages`);

    let fullResponse = '';
    let citations: any[] = [];
    const groqModel = settings?.groqModel || 'gpt-oss-120b';
    const temperature = settings?.temperature || 0.7;
    const maxTokens = settings?.maxTokens || 2048;

    // Build conversation history for inference service
    const groqPrompt = messages.map(msg =>
      `${msg.role === 'user' ? 'User' : 'Assistant'}: ${msg.content}`
    ).join('\n') + `\nUser: ${content}`;

    await groqService.generateStreamingResponse(
      groqPrompt,
      "You are a helpful medical AI assistant.",
      groqModel,
      {
        temperature,
        maxTokens,
        onChunk: (chunk: string) => {
          fullResponse += chunk;
        }
      }
    );

    console.log('[DIRECT RESPONSE]', `Generated ${fullResponse.length} characters`);

    // Save assistant message
    const assistantMessage: MessageCreate = {
      sessionId,
      content: fullResponse,
      role: MessageSender.ASSISTANT,
      citations: citations.length > 0 ? citations : undefined,
    };

    await this.indexedDBServices.messageService.createMessage(assistantMessage);
    console.log('[RESPONSE SAVED]', 'Direct response stored in database');

    if (onStreamEvent) {
      onStreamEvent({
        type: 'done',
        content: fullResponse,
        citations: citations.length > 0 ? citations : undefined
      });
    }

    console.log('=== DIRECT RESPONSE MODE END ===\n');
  }

  /**
   * Generate response with document context
   */
  private async generateContextualResponse(
    sessionId: string,
    content: string,
    context: string,
    searchResults: any[],
    onStreamEvent?: (event: ChatStreamEvent) => void
  ): Promise<void> {
    console.log('\n=== CONTEXTUAL RESPONSE MODE (WITH RAG) ===');
    console.log('[RAG MODE]', 'Generating response with document context');
    console.log('[CONTEXT SUMMARY]', `Providing ${searchResults.length} context sources to LLM`);

    // Get session for system prompt
    // Get session for system prompt and userId
    const session = await this.indexedDBServices.sessionService.getSession(sessionId);
    if (!session) {
      throw new Error('Session not found');
    }
    const systemPrompt = this.getDefaultSystemPrompt(searchResults);
    console.log('[SYSTEM PROMPT]', 'Using default system prompt');

    const settings = await this.indexedDBServices.settingsService.getSettings(session.userId);
    console.log('[RAG SETTINGS]', 'Settings loaded for contextual response');
    console.log('[RAG SETTINGS]', `API Key present: ${settings?.geminiApiKey ? 'YES' : 'NO'}`);
    console.log('[RAG SETTINGS]', `Temperature: ${settings?.temperature}`);
    console.log('[RAG SETTINGS]', `Max tokens: ${settings?.maxTokens}`);

    const messages = await this.indexedDBServices.messageService.getMessagesBySession(sessionId, session.userId);
    console.log('[CHAT HISTORY]', `Found ${messages.length} previous messages`);

    let fullResponse = '';

    const groqModel = settings?.groqModel || 'gpt-oss-120b';

    await groqService.generateStreamingResponse(
      `Context:\n${context}\n\nQuestion: ${content}`,
      systemPrompt,
      groqModel,
      {
        temperature: settings?.temperature || 0.7,
        maxTokens: settings?.maxTokens || 2048,
        onChunk: (chunk: string) => {
          fullResponse += chunk;
        }
      }
    );

    console.log('=== CONTEXTUAL RESPONSE MODE END ===\n');
  }

  /**
   * NEW: Generate response with simplified page-based citation system
   */
  private async generateSimplifiedContextualResponse(
    sessionId: string,
    content: string,
    context: string,
    searchResults: any[],
    onStreamEvent?: (event: ChatStreamEvent) => void
  ): Promise<void> {
    console.log('\n=== SIMPLIFIED CONTEXTUAL RESPONSE MODE (WITH RAG) ===');
    console.log('[SIMPLIFIED RAG MODE]', 'Generating response with simplified page-based citations');
    console.log('[SIMPLIFIED CONTEXT]', `Providing ${searchResults.length} context sources to LLM`);

    // Get session for system prompt
    // Get session for system prompt and userId
    const session = await this.indexedDBServices.sessionService.getSession(sessionId);
    if (!session) {
      throw new Error('Session not found');
    }
    const systemPrompt = this.getSimplifiedSystemPrompt(searchResults);
    console.log('[SIMPLIFIED SYSTEM PROMPT]', 'Using default simplified system prompt');

    const settings = await this.indexedDBServices.settingsService.getSettings(session.userId);
    console.log('[SIMPLIFIED RAG SETTINGS]', 'Settings loaded for simplified contextual response');

    const messages = await this.indexedDBServices.messageService.getMessagesBySession(sessionId, session.userId);
    console.log('[SIMPLIFIED CHAT HISTORY]', `Found ${messages.length} previous messages`);

    let fullResponse = '';

    // Build context-aware prompt for inference service
    const groqModel = settings?.groqModel || 'gpt-oss-120b';

    // Construct simplified history and context
    const recentMessages = messages.slice(-5).map(m =>
      `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`
    ).join('\n');

    const groqPrompt = `
      Context from documents:
      ---
      ${context}
      ---
      
      Conversation History:
      ${recentMessages}
      
      New Question: ${content}
    `;

    try {
      await groqService.generateStreamingResponse(
        groqPrompt,
        systemPrompt,
        groqModel,
        {
          temperature: settings?.temperature || 0.7,
          maxTokens: settings?.maxTokens || 2048,
          onChunk: (chunk: string) => {
            fullResponse += chunk;
          }
        }
      );

      console.log('[SIMPLIFIED RESPONSE COMPLETE]', `Generated ${fullResponse.length} characters`);

      // Format response to bullet points before processing citations
      const settingsForFormatting = settings || {
        userId: session.userId,
        geminiApiKey: '',
        groqApiKey: '',
        groqModel: 'gpt-oss-120b',
        model: 'gemma-3-27b-it',
        geminiModel: 'gemma-3-27b-it',
        temperature: 0.7,
        maxTokens: 2048,
        similarityThreshold: 0.7,
        chunkSize: 1000,
        chunkOverlap: 200,
        retrievalMode: 'legacy_hybrid' as const,
        theme: 'dark' as const,
        fontSize: 'medium' as const,
        showSources: true,
        autoSave: true,
        dataRetention: 'never' as const,
        enableAnalytics: false,
        crashReporting: false,
        debugMode: false,
        logLevel: 'error' as const
      };

      if (onStreamEvent) {
        onStreamEvent({ type: 'status', message: 'Response Formatting' });
      }

      const formattedResponse = await ResponseFormatter.formatToBulletPoints(fullResponse, settingsForFormatting);
      console.log('[BULLET FORMATTING]', `Converted to bullet points: ${formattedResponse.length} characters`);

      const isNoEvidenceResponse = this.isInsufficientEvidenceResponse(formattedResponse || fullResponse);

      // Process citations using simplified system
      const citationResult: SimplifiedCitationGroup = citationService.processSimplifiedCitations(formattedResponse, searchResults);

      // Convert simplified citations to message citation format for storage
      let citationMetadata = citationService.convertSimplifiedToMessageCitations(citationResult.citations);

      // If model explicitly says evidence is insufficient, do not attach normal source cards.
      if (isNoEvidenceResponse) {
        citationMetadata = [];
      }

      // Reliability fallback: if inline [n] citations are missing, still show source references.
      if (!isNoEvidenceResponse && citationMetadata.length === 0 && searchResults.length > 0) {
        console.warn('[CITATION FALLBACK]', `No parsed inline citations found. Attaching fallback references from top ${Math.min(searchResults.length, 6)} results.`);
        citationMetadata = this.buildFallbackCitationsFromSearchResults(searchResults, 6);
      }

      // Final hard guard: ensure text citation markers and reference panel are always in sync.
      const consistentCitationOutput = this.enforceCitationConsistency(
        citationResult.renumberedResponse,
        citationMetadata
      );
      const responseWithQueryHeader = this.prependAnsweredQueryHeader(
        consistentCitationOutput.content,
        content
      );

      // Save assistant message with formatted response
      const assistantMessage: MessageCreate = {
        sessionId,
        content: responseWithQueryHeader,
        role: MessageSender.ASSISTANT,
        citations: consistentCitationOutput.citations,
      };

      await this.indexedDBServices.messageService.createMessage(assistantMessage);

      if (onStreamEvent) {
        onStreamEvent({
          type: 'done',
          content: responseWithQueryHeader,
          citations: consistentCitationOutput.citations
        });
      }
    } catch (error) {
      console.error('[SIMPLIFIED RAG MODE ERROR]', 'Inference provider error:', error);
      if (onStreamEvent) {
        onStreamEvent({
          type: 'error',
          message: error instanceof Error ? error.message : 'Failed to generate response via inference provider'
        });
      }
    }

    console.log('=== SIMPLIFIED CONTEXTUAL RESPONSE MODE END ===\n');
  }

  /**
   * Get simplified system prompt for page-based citation system
   */
  private getSimplifiedSystemPrompt(searchResults?: any[]): string {
    const availableSources = searchResults?.length || 0;

    return `You are a helpful AI assistant that answers questions based on the provided document context.

CRITICAL CONSTRAINT - READ CAREFULLY:
- You MUST ONLY use information from the provided context documents
- You are FORBIDDEN from using any general knowledge, external information, or knowledge from your training data
- If the context does not contain the answer, you MUST respond with "I cannot answer this question based on the provided documents."
- Do NOT attempt to answer questions about topics not covered in the context (e.g., "who is the president", current events, general knowledge)
- Every single statement you make must be supported by the provided context
- NEVER answer questions about politics, current events, celebrities, sports, or any topic not in the documents

CONTEXT USAGE:
- Use ONLY the provided context to inform your answers
- Base your responses ENTIRELY on the given documents
- Don't mention "according to the context" or similar phrases

MEDICAL ABBREVIATIONS AND TERMINOLOGY:
When processing medical queries, understand and use these common medical terms and abbreviations:
- "rx" or "Rx" means treatment of a certain condition
- "Tx" or "tx" means treatment
- "Dx" or "dx" means diagnosis (you should search for history, clinical features, and investigations of the condition)
- "inv" or "Inv" means investigations or diagnostic tests
- "Give details about": means Give ALL the information you can find about the given query from the sources in a summarized way
- "Features" or "Clinical Features": means ONLY History and Clinical Examination findings of that disease or condition. This EXCLUDES investigation/lab findings. Focus on symptoms (what patient reports) and signs (what doctor finds on examination)
- "Management" or "Treatment": means the therapeutic approach - treatment guidelines, protocols, drugs/medications given, dosages, and any surgical or invasive interventions. Focus on HOW to treat the condition

RESPONSE DEPTH INSTRUCTIONS:
- Provide COMPREHENSIVE, IN-DEPTH, and DETAILED answers. Do not be overly concise.
- When discussing classifications, types, or clinical features, provide FULL details from the context, including descriptions, causes, and distinguishing characteristics.
- Use paragraphs for detailed explanations and bullet points for lists.
- Do NOT summarize if detailed information is available in the documents.
- If the context provides specific clinical details (like "healing ulcer" vs "spreading ulcer"), you MUST include all those details.

SIMPLIFIED VANCOUVER CITATION REQUIREMENTS:
- ALWAYS cite your sources using Vancouver style: [1], [2], [3] format
- Each citation represents a PAGE from a document that contains the information you're citing
- All chunks from the same page are already combined into a single citation
- Use citations for ALL factual claims, statistics, quotes, and specific information
- Citations are MANDATORY - every factual statement must have a citation
- Place citations immediately after the information they support
- Citations must be numbered sequentially in the order they appear in your response
- CRITICAL: Only use citation numbers that correspond to the provided context sources (1 through ${availableSources})
- NEVER invent citation numbers or use numbers outside of available range
- Every factual paragraph or bullet must include at least one citation marker [n]

RESPONSE GUIDELINES:
- Be accurate and helpful
- Provide comprehensive, detailed answers
- Handle unit conversions for medical/technical data
- Maintain a professional but conversational tone
- If multiple documents provide conflicting information, acknowledge the discrepancy
- Do NOT use markdown tables unless the user explicitly asks for a table
- Prefer headings, short paragraphs, and bullet lists for better mobile readability

ANSWER STRUCTURE:
1. Direct answer to the question
2. Supporting details with VERIFIED page-based citations (Use paragraphs for details)
3. Additional relevant context if available

Remember: Your goal is to provide accurate, well-cited responses based SOLELY on the provided document context. CITATION ACCURACY IS YOUR HIGHEST PRIORITY.`;
  }

  /**
   * Build context string from search results following Flutter app's approach
   * Enhanced with clearer source labeling and content previews
   * IMPROVED: Better page number detection and clearer source identification
   */
  private buildContext(searchResults: any[]): string {
    if (searchResults.length === 0) {
      return '';
    }

    console.log('\n=== CONTEXT BUILDING DEBUG ===');
    console.log('[BUILDING CONTEXT]', `Processing ${searchResults.length} search results for context`);

    const contextParts: string[] = [];
    contextParts.push('Retrieved Context Sources:\n');

    for (let i = 0; i < searchResults.length; i++) {
      const result = searchResults[i];
      const chunk = result.chunk;
      const document = result.document;

      // Enhanced page number detection - same logic as citation service
      let pageInfo = '';
      if (chunk.metadata?.pageNumbers && chunk.metadata.pageNumbers.length > 0) {
        pageInfo = ` (Page ${chunk.metadata.pageNumbers[0]})`;
      } else if (chunk.page && chunk.page > 0) {
        pageInfo = ` (Page ${chunk.page})`;
      } else if (chunk.metadata?.pageNumber && chunk.metadata.pageNumber > 0) {
        pageInfo = ` (Page ${chunk.metadata.pageNumber})`;
      } else {
        // Try to extract from content
        const pagePatterns = [
          /page\s+(\d+)/i,
          /p\.?\s*(\d+)/i,
          /第(\d+)页/,
          /page\s+(\d+)\s+of/i,
        ];

        for (const pattern of pagePatterns) {
          const match = chunk.content.match(pattern);
          if (match && match[1]) {
            const extractedPage = parseInt(match[1], 10);
            if (extractedPage > 0) {
              pageInfo = ` (Page ${extractedPage})`;
              break;
            }
          }
        }
      }

      // Create content preview for better source identification
      const contentPreview = this.createContentPreview(chunk.content);
      const similarityScore = result.similarity ? ` (Similarity: ${(result.similarity * 100).toFixed(1)}%)` : '';

      console.log(`[CONTEXT SOURCE ${i + 1}]`, {
        documentTitle: document.title,
        pageInfo: pageInfo.trim(),
        similarity: result.similarity,
        chunkId: chunk.id,
        contentPreview: contentPreview,
        isCombined: chunk.metadata?.isCombined,
        originalChunkCount: chunk.metadata?.originalChunkCount
      });

      contextParts.push(`[${i + 1}] ${document.title}${pageInfo}${similarityScore}`);
      contextParts.push(`Preview: ${contentPreview}`);
      contextParts.push('');
      contextParts.push(`Full Content:`);
      contextParts.push(chunk.content.trim());
      contextParts.push('');
      contextParts.push('---');
      contextParts.push('');
    }

    const finalContext = contextParts.join('\n').trim();
    console.log('[CONTEXT BUILT]', `Final context length: ${finalContext.length} characters`);
    console.log('=== CONTEXT BUILDING DEBUG END ===\n');

    return finalContext;
  }

  /**
   * Create a brief content preview to help identify relevant sources
   */
  private createContentPreview(content: string, maxLength: number = 150): string {
    // Remove extra whitespace but preserve newlines for list formatting
    const cleanedContent = content.trim().replace(/[ \t]+/g, ' ');

    if (cleanedContent.length <= maxLength) {
      return cleanedContent;
    }

    // Try to end at a sentence boundary
    const truncated = cleanedContent.substring(0, maxLength);
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
   * Fallback citation builder when the model does not emit [n] markers.
   * Uses top retrieved chunks, deduplicated by document+page.
   */
  private buildFallbackCitationsFromSearchResults(searchResults: any[], limit: number = 6): any[] {
    const fallbackCitations: any[] = [];
    const seenKeys = new Set<string>();

    const isLowContent = (text: string): boolean => {
      const compact = (text || '').replace(/\s+/g, ' ').trim();
      if (compact.length < 220) return true;
      const alphaChars = compact.replace(/[^A-Za-z]/g, '').length;
      const words = compact.split(/\s+/).filter(Boolean);
      const uniqueWords = new Set(words.map((w) => w.toLowerCase())).size;
      return alphaChars < 100 || words.length < 35 || uniqueWords < 18;
    };

    const preferred = searchResults.filter((result) => !isLowContent(result.chunk?.content || ''));
    const candidates = preferred.length > 0 ? preferred : searchResults;

    for (const result of candidates) {
      const documentName = result.document?.title || result.document?.fileName || 'Unknown Document';
      const page =
        result.chunk?.metadata?.pageNumbers?.[0] ??
        result.chunk?.page ??
        result.chunk?.metadata?.pageNumber;

      const dedupeKey = `${documentName}::${page ?? 'unknown'}`;
      if (seenKeys.has(dedupeKey)) continue;
      seenKeys.add(dedupeKey);

      fallbackCitations.push({
        document: documentName,
        page: typeof page === 'number' ? page : undefined,
        excerpt: (result.chunk?.content || '').slice(0, 2000),
      });

      if (fallbackCitations.length >= limit) break;
    }

    return fallbackCitations;
  }

  /**
   * Keep inline [n] markers and references panel perfectly aligned.
   * Removes out-of-range markers, then compacts numbering to 1..N.
   */
  private enforceCitationConsistency(
    content: string,
    citations: any[]
  ): { content: string; citations: any[] } {
    const normalizedBrackets = content
      .replace(/[【［]/g, '[')
      .replace(/[】］]/g, ']');

    if (!citations || citations.length === 0) {
      // No references available: remove dangling numeric citation markers.
      return {
        content: normalizedBrackets
          .replace(/\[[^\]]+\]/g, '')
          .replace(/\b\d+†L\d+(?:-L?\d+)?\b/g, '')
          .replace(/ +([.,;:!])/g, '$1')
          .trim(),
        citations: [],
      };
    }

    const extractIndices = (innerContent: string): number[] => {
      const indices: number[] = [];
      const seen = new Set<number>();
      for (const segment of innerContent.split(',')) {
        const match = segment.match(/^\s*(\d+)/);
        if (!match) continue;
        const idx = parseInt(match[1], 10);
        if (Number.isNaN(idx) || seen.has(idx)) continue;
        seen.add(idx);
        indices.push(idx);
      }
      return indices;
    };

    const maxIndex = citations.length;
    let normalized = normalizedBrackets.replace(/\[([^\]]+)\]/g, (_match, inner: string) => {
      const inRange = extractIndices(inner)
        .filter((n) => n >= 1 && n <= maxIndex)
        .sort((a, b) => a - b);
      if (inRange.length === 0) return '';
      return `[${inRange.join(', ')}]`;
    });

    // Remove leftover non-standard citation artifacts.
    normalized = normalized
      .replace(/\b\d+†L\d+(?:-L?\d+)?\b/g, '')
      .replace(/\[\s*(?:\+|†)[^\]]*\]/g, '');

    const used = new Set<number>();
    normalized.replace(/\[([^\]]+)\]/g, (_match, inner: string) => {
      extractIndices(inner).forEach((n) => used.add(n));
      return '';
    });

    if (used.size === 0) {
      return {
        content: normalized.replace(/ +([.,;:!])/g, '$1').trim(),
        citations,
      };
    }

    const sortedUsed = Array.from(used).sort((a, b) => a - b);
    const indexMap = new Map<number, number>();
    sortedUsed.forEach((oldIndex, i) => indexMap.set(oldIndex, i + 1));

    normalized = normalized.replace(/\[([^\]]+)\]/g, (_match, inner: string) => {
      const remapped = extractIndices(inner)
        .map((n) => indexMap.get(n))
        .filter((n): n is number => typeof n === 'number')
        .sort((a, b) => a - b);
      if (remapped.length === 0) return '';
      return `[${remapped.join(', ')}]`;
    });

    const compactedCitations = sortedUsed.map((oldIndex) => citations[oldIndex - 1]).filter(Boolean);

    return {
      content: normalized.replace(/ +([.,;:!])/g, '$1').trim(),
      citations: compactedCitations,
    };
  }

  /**
   * Show users the exact query text answered by the model.
   */
  private prependAnsweredQueryHeader(content: string, answeredQuery: string): string {
    const safeQuery = (answeredQuery || '').trim();
    if (!safeQuery) return content;

    const existing = content.trimStart();
    const headerRegex = /^\*\*Answer for:\*\*\s*".*?"\s*\n/i;
    if (headerRegex.test(existing)) {
      return content;
    }

    return `**Answer for:** "${safeQuery}"\n\n${content}`;
  }


  /**
   * Get enhanced system prompt based on Flutter app's approach
   */
  private getDefaultSystemPrompt(searchResults?: any[]): string {
    const availableSources = searchResults?.length || 0;

    return `You are a helpful AI assistant that answers questions based on the provided document context.

CRITICAL CONSTRAINT - READ CAREFULLY:
- You MUST ONLY use information from the provided context documents
- You are FORBIDDEN from using any general knowledge, external information, or knowledge from your training data
- If the context does not contain the answer, you MUST respond with "I cannot answer this question based on the provided documents."
- Do NOT attempt to answer questions about topics not covered in the context (e.g., "who is the president", current events, general knowledge)
- Every single statement you make must be supported by the provided context
- NEVER answer questions about politics, current events, celebrities, sports, or any topic not in the documents
- If someone asks "who is the president" or similar general knowledge questions, you must respond that you cannot answer based on the provided documents

CONTEXT USAGE:
- Use ONLY the provided context to inform your answers
- Base your responses ENTIRELY on the given documents
- Don't mention "according to the context" or similar phrases
- If context doesn't contain relevant information, say so clearly

MEDICAL ABBREVIATIONS AND TERMINOLOGY:
When processing medical queries, understand and use these common medical terms and abbreviations:
- "rx" or "Rx" means treatment or prescription
- "Tx" or "tx" means treatment
- "Dx" or "dx" means diagnosis (you should search for history, clinical features, and investigations of the condition)
- "inv" or "Inv" means investigations or diagnostic tests
- "Features" or "Clinical Features": means ONLY History and Clinical Examination findings of that disease or condition. This EXCLUDES investigation/lab findings. Focus on symptoms (what patient reports) and signs (what doctor finds on examination)
- "Management" or "Treatment": means the therapeutic approach - treatment guidelines, protocols, drugs/medications given, dosages, and any surgical or invasive interventions. Focus on HOW to treat the condition

CRITICAL CITATION ACCURACY REQUIREMENTS:
- BEFORE citing any source, VERIFY that the information you're presenting actually appears in that source
- Each citation [number] MUST reference a source that CONTAINS the specific information you're citing
- NEVER cite a source that discusses a different topic, even if it's related
- Example: If you're defining "cataract", ONLY cite sources that actually contain the cataract definition
- DO NOT cite sources about ophthalmoscopy or ultrasound when defining cataract
- Read each source carefully and ensure the content matches what you're claiming
- If you're unsure whether a source contains the information, DO NOT cite it
- It is BETTER to have fewer citations than to cite irrelevant sources

VANCOUVER CITATION REQUIREMENTS:
- ALWAYS cite your sources using Vancouver style: [1], [2], [3] format
- Each citation must reference the specific document chunk that DIRECTLY supports your statement
- Use citations for ALL factual claims, statistics, quotes, and specific information
- Citations are MANDATORY - every factual statement must have a citation
- Don't cite general knowledge or common sense statements (but you shouldn't be using these anyway)
- Place citations immediately after the information they support
- Citations must be numbered sequentially in the order they appear in your response
- CRITICAL: Only use citation numbers that correspond to the provided context sources (1 through ${availableSources})
- NEVER invent citation numbers or use numbers outside the available range
- Each citation number must match exactly one source from the provided context
- WARNING: Citing incorrect sources will mislead users and is unacceptable
- Every factual paragraph or bullet must include at least one citation marker [n]

RESPONSE GUIDELINES:
- Be accurate and helpful
- Provide comprehensive but concise answers
- Handle unit conversions for medical/technical data (e.g., temperatures, weights)
- Maintain a professional but conversational tone
- If multiple documents provide conflicting information, acknowledge the discrepancy
- Do NOT use markdown tables unless the user explicitly asks for a table
- Prefer headings, short paragraphs, and bullet lists for better mobile readability

CITATION VERIFICATION PROCESS:
1. Make a factual claim
2. IMMEDIATELY check if the source [number] actually contains this information
3. If YES, add the citation
4. If NO, either find the correct source or remove the claim
5. Double-check: Does source [number] really say what I'm claiming?

ANSWER STRUCTURE:
1. Direct answer to the question
2. Supporting details with VERIFIED citations
3. Additional relevant context if available

Remember: Your goal is to provide accurate, well-cited responses based SOLELY on the provided document context. NEVER use external knowledge. If the context doesn't contain the answer, explicitly state that you cannot answer based on the provided documents. CITATION ACCURACY IS YOUR HIGHEST PRIORITY.`;
  }

  /**
   * Clear chat history for a session
   */
  async clearHistory(sessionId: string): Promise<void> {
    await this.indexedDBServices.messageService.deleteMessagesBySession(sessionId);
  }

  /**
   * Get message history for a session
   */
  async getHistory(sessionId: string): Promise<Message[]> {
    // Get session to verify ownership and get userId
    const session = await this.indexedDBServices.sessionService.getSession(sessionId);
    if (!session) {
      throw new Error('Session not found');
    }
    return await this.indexedDBServices.messageService.getMessagesBySession(sessionId, session.userId);
  }

  /**
   * Validate streaming chunk for quality control
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

    // Check for response getting too long
    if (fullResponse.length > 8000) {
      warnings.push('Response approaching maximum length');
    }

    return { isValid, warnings };
  }
}

// Singleton instance
export const chatPipeline = new ChatPipeline();
