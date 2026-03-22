import { create } from 'zustand';
import { devtools, persist } from 'zustand/middleware';
import type { ChatStore } from './types';
import { Message, MessageSender } from '@/types/message';
import { getIndexedDBServices } from '../services/indexedDB';
import { chatPipeline } from '../services/rag/chatPipeline';
import { drugModeService } from '../services/drug';
import { askDrugModeService } from '../services/drug/askDrugModeService';
import { brandExtractionService } from '../services/drug';
import { groqService } from '../services/groq/groqService';
import { useSessionStore } from './sessionStore';
import { userIdLogger } from '../utils/userIdDebugLogger';
import type { SessionChatMode } from '@/types';

const PRELOAD_SESSION_TIMEOUT_MS = 4000;
const PIPELINE_TIMEOUT_MS = 90000;

const DRUG_MODE_DIRECT_ROUTE_PATTERN =
  /\b(dose|doses|dosage|dosing|schedule|regimen|how much|how many|brand|brands|brand name|brand names|trade name|trade names|company|companies|price|prices|cost|costs)\b/i;

const shouldUseDirectDrugModePath = (content: string): boolean =>
  DRUG_MODE_DIRECT_ROUTE_PATTERN.test(content);

const DRUG_FOLLOW_UP_INTENT_PATTERNS: Array<{ pattern: RegExp; normalizedIntent: string }> = [
  { pattern: /\b(indications?|uses?)\b/i, normalizedIntent: 'indications' },
  { pattern: /\b(side[\s-]?effects?|adverse effects?)\b/i, normalizedIntent: 'side effects' },
  { pattern: /\b(contra[\s-]?indications?)\b/i, normalizedIntent: 'contraindications' },
  { pattern: /\b(pregnancy)\b/i, normalizedIntent: 'pregnancy' },
  { pattern: /\b(breast[\s-]?feeding)\b/i, normalizedIntent: 'breast feeding' },
  { pattern: /\b(renal(?:\s+dose|\s+impairment)?)\b/i, normalizedIntent: 'renal impairment' },
  { pattern: /\b(hepatic(?:\s+dose|\s+impairment)?)\b/i, normalizedIntent: 'hepatic impairment' },
  { pattern: /\b(safety(?:\s+information)?)\b/i, normalizedIntent: 'safety information' },
  { pattern: /\b(details?|all about|everything|tell me about|full details?)\b/i, normalizedIntent: 'details' },
  { pattern: /\b(dose|doses|dosage|dosing|schedule|regimen|how much|how many)\b/i, normalizedIntent: 'dose' },
  { pattern: /\b(brand|brands|brand names?|trade names?|company|companies|price|prices|cost|costs)\b/i, normalizedIntent: 'brands' },
];

const DRUG_BROAD_QUERY_PATTERN =
  /\b(?:drugs?|medicines?)\s+(?:for|used for)\b|\bwhich\s+(?:drug|drugs|medicine|medicines)\b/i;

const DRUG_CONTEXTUAL_PRONOUN_PATTERN =
  /\b(it|this|that|same drug|same medicine|same one|this one|that one)\b/i;

const DRUG_CONDITION_TARGET_HINT_PATTERN =
  /\b(encephalopathy|disease|syndrome|infection|disorder|pain|fever|diabetes|hypertension|asthma|migraine|anemia|anaemia|jaundice|hepatitis|cirrhosis|impairment|failure|obstruction|allergy|allergic|renal|hepatic|cardiac|pulmonary|neuropathy|stroke|seizure|epilepsy|colitis|gastritis|ulcer|pregnancy|lactation|breast[\s-]?feeding)\b/i;

const DRUG_CONDITION_TARGET_SUFFIX_PATTERN =
  /\b[a-z][a-z-]*(?:itis|osis|opathy|emia|uria|algia|rrhea|rrhoea|iasis)\b/i;

const DRUG_CONTEXT_EXPLICIT_PATTERNS = [
  /^([A-Za-z][A-Za-z0-9\s+'().\-]{0,80}?)\s+(?:brands?|brand names?|trade names?|dose|doses|dosage|dosing|schedule|regimen|indications?|uses?|side[\s-]?effects?|contra[\s-]?indications?|pregnancy|breast[\s-]?feeding|renal(?:\s+dose|\s+impairment)?|hepatic(?:\s+dose|\s+impairment)?|safety(?:\s+information)?|details?|full details?|all about|everything)\b/i,
  /^(?:what(?:'s| is)?\s+)?(?:the\s+)?(?:dose|dosage|dosing|schedule|regimen|brands?|brand names?|trade names?|companies|prices?|costs?|indications?|uses?|side[\s-]?effects?|contra[\s-]?indications?|pregnancy|breast[\s-]?feeding|renal(?:\s+dose|\s+impairment)?|hepatic(?:\s+dose|\s+impairment)?|safety(?:\s+information)?|details?|full details?|all about|everything)\s+(?:of|for|about)\s+(.+)$/i,
  /^(?:tell\s+me\s+about)\s+(.+)$/i,
];

const AMBIGUOUS_DRUG_FOLLOW_UP_MODEL = 'llama-3.3-70b-versatile';

const sanitizeDrugContextName = (value: string): string =>
  value
    .trim()
    .replace(/^['"`]+|['"`]+$/g, '')
    .replace(/[?!.,;:]+$/g, '')
    .trim();

const extractExplicitDrugNameFromQuery = (content: string): string | null => {
  const compact = content.trim();
  if (!compact || DRUG_BROAD_QUERY_PATTERN.test(compact)) return null;

  for (const pattern of DRUG_CONTEXT_EXPLICIT_PATTERNS) {
    const match = compact.match(pattern)?.[1];
    if (match) {
      const cleaned = sanitizeDrugContextName(match);
      if (cleaned) return cleaned;
    }
  }

  return null;
};

const inferDrugFollowUpIntent = (content: string): string | null => {
  for (const { pattern, normalizedIntent } of DRUG_FOLLOW_UP_INTENT_PATTERNS) {
    if (pattern.test(content)) return normalizedIntent;
  }
  return null;
};

const looksLikeConditionTarget = (value: string): boolean => {
  const compact = value.trim();
  if (!compact) return false;
  return DRUG_CONDITION_TARGET_HINT_PATTERN.test(compact) || DRUG_CONDITION_TARGET_SUFFIX_PATTERN.test(compact);
};

const isLikelyDrugFollowUpQuery = (content: string): boolean => {
  const compact = content.trim();
  if (!compact || DRUG_BROAD_QUERY_PATTERN.test(compact)) return false;
  if (extractExplicitDrugNameFromQuery(compact)) return false;

  const hasIntent = Boolean(inferDrugFollowUpIntent(compact));
  const hasPronoun = DRUG_CONTEXTUAL_PRONOUN_PATTERN.test(compact);
  const shortQuery = compact.split(/\s+/).length <= 8;
  return (hasIntent && shortQuery) || hasPronoun;
};

const isDoseForConditionFollowUpQuery = (content: string): boolean => {
  const compact = content.trim();
  if (!compact || DRUG_BROAD_QUERY_PATTERN.test(compact)) return false;
  if (!/\b(dose|doses|dosage|dosing|schedule|regimen|how much|how many)\b/i.test(compact)) return false;
  if (!/\bfor\b/i.test(compact)) return false;
  if (DRUG_CONTEXTUAL_PRONOUN_PATTERN.test(compact)) return false;

  const trailingTarget = compact.match(/\bfor\s+(.+)$/i)?.[1];
  if (!trailingTarget) return false;

  return looksLikeConditionTarget(trailingTarget);
};

const rewriteObviousDrugFollowUpQuery = (
  content: string,
  lastDrugName: string,
): string | null => {
  const compact = content.trim();
  if (!compact || DRUG_BROAD_QUERY_PATTERN.test(compact) || extractExplicitDrugNameFromQuery(compact)) {
    return null;
  }

  if (DRUG_CONTEXTUAL_PRONOUN_PATTERN.test(compact)) {
    return compact.replace(DRUG_CONTEXTUAL_PRONOUN_PATTERN, lastDrugName);
  }

  const intent = inferDrugFollowUpIntent(compact);
  if (!intent) return null;

  if (/^(?:and\s+|what about\s+)+/i.test(compact) || compact.split(/\s+/).length <= 5) {
    if (intent === 'details') return `details of ${lastDrugName}`;
    if (intent === 'brands') return `brands of ${lastDrugName}`;
    if (intent === 'dose') return `dose of ${lastDrugName}`;
    return `${intent} of ${lastDrugName}`;
  }

  return null;
};

const rewriteAmbiguousDrugFollowUpQuery = async (
  content: string,
  lastDrugName: string,
): Promise<string | null> => {
  const systemPrompt = `You rewrite short follow-up drug questions only when they clearly refer to the previously discussed drug.

Rules:
- Return valid JSON only.
- Output schema: {"action":"rewrite"|"keep","rewritten_query":string}
- Rewrite only if the user is clearly asking a follow-up about the previous drug.
- If the user starts a new condition search or unrelated request, keep the original query.
- Keep the rewritten query short and natural.
- Do not invent drug names or conditions.
- If unsure, use "keep".`;

  const prompt = `Previous drug:
${lastDrugName}

New user query:
${content}`;

  try {
    const raw = await groqService.generateResponseWithGroq(
      prompt,
      systemPrompt,
      AMBIGUOUS_DRUG_FOLLOW_UP_MODEL,
      { temperature: 0, maxTokens: 120, timeoutMs: 8000 },
    );
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;
    const parsed = JSON.parse(jsonMatch[0]) as { action?: string; rewritten_query?: string };
    if (parsed.action !== 'rewrite') return null;
    const rewritten = String(parsed.rewritten_query || '').trim();
    return rewritten || null;
  } catch (error) {
    console.warn('[DRUG FOLLOW-UP REWRITE] Ambiguous rewrite skipped:', error);
    return null;
  }
};

// Helper function to get services (client-side only)
const getMessageService = () => {
  if (typeof window !== 'undefined') {
    const services = getIndexedDBServices();
    return services.messageService;
  }
  return null;
};

const withTimeout = async <T>(
  promise: Promise<T>,
  timeoutMs: number,
  timeoutMessage: string
): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(timeoutMessage));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
};

export const useChatStore = create<ChatStore>()(
  devtools(
    persist(
      (set, get) => ({
        // State
        messages: [],
        messageCache: {}, // Cache for preloaded messages
        isStreaming: false,
        streamingContent: '',
        streamingCitations: [],
        error: null,
        isLoading: false,
        isReadingSources: false,
        progressPercentage: 0,
        currentProgressStep: '',
        isPreloading: false,
        preloadingProgress: 0,
        pipelineStartedAt: null,

        // Rate limiting state
        questionTimestamps: [],
        isRateLimited: false,
        rateLimitWaitSeconds: 0,
        sessionModeBySession: {},
        drugSuggestionsBySession: {},
        skipNextDrugFollowUpRewriteBySession: {},
        drugContextBySession: {},

        // Actions
        loadMessages: async (sessionId: string) => {
          const { userId: currentUserId } = useSessionStore.getState();
          const operationId = userIdLogger.logOperationStart('ChatStore', 'loadMessages', currentUserId);

          // Check cache first
          const { messageCache } = get();
          if (messageCache[sessionId]) {
            console.log(`⚡️ [ChatStore] Instant load from cache for session ${sessionId} (${messageCache[sessionId].length} msgs)`);
            set({ messages: messageCache[sessionId], isLoading: false, error: null });
            // We still fetch in background to ensure freshness, but UI is already populated
          } else {
            // Set loading state immediately and clear previous messages to avoid flickering
            set({ isLoading: true, error: null, messages: [] });
          }

          // Background warm-up for retrieval path (non-blocking).
          chatPipeline.preloadSessionRetrievalData(sessionId).catch((error) => {
            console.warn('[ChatStore] Retrieval warm-up skipped:', error);
          });

          try {
            const messageService = getMessageService();
            if (!messageService) {
              throw new Error('Message service not available');
            }

            // Get services
            const services = getIndexedDBServices();

            // Run session validation and message fetching in parallel
            userIdLogger.logServiceCall('ChatStore', 'sessionService', 'getSession', currentUserId);
            userIdLogger.logServiceCall('ChatStore', 'messageService', 'getMessagesBySession', currentUserId);

            const [session, messages] = await Promise.all([
              services.sessionService.getSession(sessionId, currentUserId || undefined),
              messageService?.getMessagesBySession(sessionId, currentUserId || undefined, 20) // Fetch only last 20 messages initially
            ]);

            // Check if session exists
            if (!session) {
              throw new Error('Session not found');
            }

            userIdLogger.logOperationEnd('ChatStore', operationId, currentUserId);

            // Update state and cache
            set(state => ({
              messages: messages || [],
              isLoading: false,
              messageCache: {
                ...state.messageCache,
                [sessionId]: messages || []
              }
            }));
          } catch (error) {
            userIdLogger.logError('ChatStore.loadMessages', error instanceof Error ? error : String(error), currentUserId);
            set({
              error: error instanceof Error ? error.message : 'Failed to load messages',
              isLoading: false,
            });
          }
        },

        preloadMessages: async (sessionIds: string[]) => {
          const { userId: currentUserId } = useSessionStore.getState();
          const messageService = getMessageService();
          if (!messageService || !currentUserId) {
            set({ isPreloading: false, preloadingProgress: 0 });
            return;
          }

          // Filter out sessions that are already cached
          const { messageCache } = get();
          const sessionsToFetch = sessionIds.filter(id => !messageCache[id]);

          if (sessionsToFetch.length === 0) {
            console.log('✨ [ChatStore] All top sessions already cached. No preloading needed.');
            set({ isPreloading: false, preloadingProgress: 100 });
            return;
          }

          console.log(`🔥 [ChatStore] Preloading ${sessionsToFetch.length} sessions:`, sessionsToFetch);
          set({ isPreloading: true, preloadingProgress: 0 });

          try {
            let completedCount = 0;
            const totalToFetch = sessionsToFetch.length;

            // Fetch messages for each session in parallel
            const results = await Promise.all(
              sessionsToFetch.map(async (sessionId) => {
                try {
                  const messages = await withTimeout(
                    messageService.getMessagesBySession(sessionId, currentUserId, 20),
                    PRELOAD_SESSION_TIMEOUT_MS,
                    `Preload timeout for session ${sessionId}`
                  );

                  // Update progress
                  completedCount++;
                  set({ preloadingProgress: (completedCount / totalToFetch) * 100 });

                  return { sessionId, messages };
                } catch (e) {
                  console.warn(`Failed to preload session ${sessionId}`, e);
                  return null;
                }
              })
            );

            // Update cache with results
            set(state => {
              const newCache = { ...state.messageCache };
              results.forEach(result => {
                if (result) {
                  newCache[result.sessionId] = result.messages;
                }
              });
              return {
                messageCache: newCache,
                isPreloading: false,
                preloadingProgress: 100
              };
            });

            console.log(`✅ [ChatStore] Preloaded ${results.filter(r => r !== null).length} sessions into cache`);
          } catch (error) {
            console.error('Failed to preload messages:', error);
            set({ isPreloading: false, preloadingProgress: 0 });
          }
        },

        sendMessage: async (sessionId: string, content: string) => {
          const { userId: currentUserId } = useSessionStore.getState();
          const operationId = userIdLogger.logOperationStart('ChatStore', 'sendMessage', currentUserId);
          let isSettled = false;
          const rawSessionMode = get().sessionModeBySession[sessionId] || 'chat';
          const sessionMode: SessionChatMode =
            rawSessionMode === 'ask-drug' ? 'drug' : rawSessionMode;
          const priorDrugContext = get().drugContextBySession[sessionId] || null;
          const skipNextDrugFollowUpRewrite =
            get().skipNextDrugFollowUpRewriteBySession[sessionId] || false;
          const contentHasBroadDrugListIntent = DRUG_BROAD_QUERY_PATTERN.test(content);
          const originalExplicitDrugName = extractExplicitDrugNameFromQuery(content);
          const originalExplicitDrugContextName =
            originalExplicitDrugName && !looksLikeConditionTarget(originalExplicitDrugName)
              ? originalExplicitDrugName
              : null;

          let effectiveContent = content;
          if (skipNextDrugFollowUpRewrite) {
            console.log('[DRUG FOLLOW-UP REWRITE][SKIP][CLICKED-ACTION]', {
              sessionId,
              originalQuery: content,
              effectiveContent,
              lastDrugName: priorDrugContext?.lastDrugName || null,
            });

            set((state) => ({
              skipNextDrugFollowUpRewriteBySession: {
                ...state.skipNextDrugFollowUpRewriteBySession,
                [sessionId]: false,
              },
            }));
          } else if (sessionMode === 'drug' && priorDrugContext?.lastDrugName) {
            if (isDoseForConditionFollowUpQuery(content) && !originalExplicitDrugContextName) {
              effectiveContent = `dose of ${priorDrugContext.lastDrugName}`;
              console.log('[DRUG FOLLOW-UP REWRITE][DOSE-FOR-CONDITION]', {
                originalQuery: content,
                rewrittenQuery: effectiveContent,
                lastDrugName: priorDrugContext.lastDrugName,
              });
            } else if (!contentHasBroadDrugListIntent) {
              const obviousRewrite = rewriteObviousDrugFollowUpQuery(content, priorDrugContext.lastDrugName);
              if (obviousRewrite) {
                effectiveContent = obviousRewrite;
                console.log('[DRUG FOLLOW-UP REWRITE][APP]', {
                  originalQuery: content,
                  rewrittenQuery: effectiveContent,
                  lastDrugName: priorDrugContext.lastDrugName,
                });
              } else if (isLikelyDrugFollowUpQuery(content)) {
                const rewritten = await rewriteAmbiguousDrugFollowUpQuery(
                  content,
                  priorDrugContext.lastDrugName,
                );
                if (rewritten) {
                  effectiveContent = rewritten;
                  console.log('[DRUG FOLLOW-UP REWRITE][LLM]', {
                    originalQuery: content,
                    rewrittenQuery: effectiveContent,
                    lastDrugName: priorDrugContext.lastDrugName,
                  });
                }
              }
            }
          }

          const shouldRouteToDrugMode =
            sessionMode === 'drug' && shouldUseDirectDrugModePath(effectiveContent);

          const failPipeline = (message: string) => {
            if (isSettled) return;
            isSettled = true;
            set({
              error: message,
              isStreaming: false,
              streamingContent: '',
              streamingCitations: [],
              isReadingSources: false,
              progressPercentage: 0,
              currentProgressStep: '',
              pipelineStartedAt: null,
            });
          };

          const userMessage: Message = {
            id: crypto.randomUUID(),
            content: effectiveContent,
            role: MessageSender.USER,
            timestamp: new Date(),
            sessionId,
          };
          const pipelineRunner =
            sessionMode === 'drug'
              ? shouldRouteToDrugMode
                ? (onEvent: Parameters<typeof drugModeService.sendMessage>[2]) =>
                    drugModeService.sendMessage(sessionId, effectiveContent, onEvent)
                : (onEvent: Parameters<typeof askDrugModeService.sendMessage>[2]) =>
                    askDrugModeService.sendMessage(sessionId, effectiveContent, onEvent)
              : (onEvent: Parameters<typeof chatPipeline.sendMessage>[2]) =>
                  chatPipeline.sendMessage(sessionId, effectiveContent, onEvent, userMessage);

          const explicitDrugName = extractExplicitDrugNameFromQuery(effectiveContent);
          const explicitDrugContextName =
            explicitDrugName && !looksLikeConditionTarget(explicitDrugName) ? explicitDrugName : null;
          const reusedPriorDrugForConditionDose =
            sessionMode === 'drug' &&
            Boolean(priorDrugContext?.lastDrugName) &&
            effectiveContent !== content &&
            effectiveContent.toLowerCase().startsWith('dose of ');
          const shouldClearDrugContext =
            sessionMode === 'drug' &&
            DRUG_BROAD_QUERY_PATTERN.test(effectiveContent) &&
            !explicitDrugContextName;
          const nextDrugContextName =
            sessionMode !== 'drug'
              ? null
              : shouldClearDrugContext
                ? null
                : reusedPriorDrugForConditionDose && priorDrugContext?.lastDrugName
                  ? priorDrugContext.lastDrugName
                  : explicitDrugContextName;

          set(state => {
            const newMessages = [...state.messages, userMessage];
            return {
              messages: newMessages,
              error: null,
              isStreaming: false, // Don't show streaming content
              isReadingSources: true, // Show "Reading sources" instead
              progressPercentage: 0,
              currentProgressStep:
                sessionMode === 'chat'
                  ? 'Query Rewriting'
                  : shouldRouteToDrugMode
                    ? 'Drug Dataset'
                    : 'Ask Drug Query Parsing',
              pipelineStartedAt: Date.now(),
              drugSuggestionsBySession: {
                ...state.drugSuggestionsBySession,
                [sessionId]: [],
              },
              drugContextBySession:
                sessionMode === 'drug'
                  ? shouldClearDrugContext
                    ? Object.fromEntries(
                        Object.entries(state.drugContextBySession).filter(([key]) => key !== sessionId),
                      )
                    : nextDrugContextName
                      ? {
                          ...state.drugContextBySession,
                          [sessionId]: {
                            lastDrugName: nextDrugContextName,
                            updatedAt: Date.now(),
                          },
                        }
                      : state.drugContextBySession
                  : state.drugContextBySession,
              // Update cache immediately
              messageCache: {
                ...state.messageCache,
                [sessionId]: newMessages
              }
            };
          });

          try {
            const messageService = getMessageService();
            if (!messageService) {
              throw new Error('Message service not available');
            }

            // Save user message to IndexedDB
            userIdLogger.logServiceCall('ChatStore', 'messageService', 'createMessage', currentUserId);
            await messageService.createMessage(userMessage);

            // Update session timestamp to move it to the top
            const services = getIndexedDBServices();
            services.sessionService
              .updateSession(sessionId, { updatedAt: new Date() }, currentUserId || undefined)
              .catch((error) => {
                console.warn('[ChatStore] Non-blocking session timestamp update failed:', error);
              });

            // Use the actual chat pipeline to generate response
            // Pass the already created userMessage to avoid duplication
            await withTimeout(
              pipelineRunner(
                (event) => {
                  if (isSettled) return;

                  if (event.type === 'status') {
                    // Update progress based on status message
                    console.log('Chat status:', event.message);
                    const { setProgressState } = get();

                    switch (event.message) {
                      case 'Query Rewriting':
                        setProgressState(25, 'Query Rewriting');
                        break;
                      case 'Embedding Generation':
                        setProgressState(50, 'Embedding Generation');
                        break;
                      case 'Vector Search':
                        setProgressState(75, 'Vector Search');
                        break;
                      case 'Answer Generation':
                        setProgressState(90, 'Answer Generation');
                        break;
                      case 'Answer Formatting':
                        setProgressState(95, 'Answer Formatting');
                        break;
                      case 'Drug Dataset':
                        setProgressState(20, 'Drug Dataset');
                        break;
                      case 'Drug Query Parsing':
                        setProgressState(45, 'Drug Query Parsing');
                        break;
                      case 'Drug Search':
                        setProgressState(70, 'Drug Search');
                        break;
                      case 'Extracting drug data...':
                        setProgressState(85, 'Extracting drug data...');
                        break;
                      case 'Verifying drug data rules...':
                        setProgressState(95, 'Verifying drug data rules...');
                        break;
                      case 'Calculating dosing schedules...':
                        setProgressState(98, 'Calculating dosing schedules...');
                        break;
                      case 'Drug Answer Generation':
                        setProgressState(90, 'Drug Answer Generation');
                        break;
                      case 'Ask Drug Query Parsing':
                        setProgressState(40, 'Ask Drug Query Parsing');
                        break;
                      case 'Ask Drug Search':
                        setProgressState(70, 'Ask Drug Search');
                        break;
                      case 'Ask Drug Answer Generation':
                        setProgressState(90, 'Ask Drug Answer Generation');
                        break;
                      default:
                        // For other status messages, don't update progress
                        break;
                    }
                  } else if (event.type === 'done') {
                    isSettled = true;
                    const { content: finalContent, citations: finalCitations } = event;

                  // Reload messages to get the final response
                  // Get session to verify ownership and get userId
                  const services = getIndexedDBServices();
                  // Get userId from sessionStore
                  const { userId: finalUserId } = useSessionStore.getState();
                  const { setProgressState } = get();

                  // OPTIMISTIC UPDATE: If we have content, update UI immediately
                  if (finalContent) {
                    console.log('⚡️ [ChatStore] Optimistic update with final content');

                    set(state => {
                      // Create message object
                      const assistantMessage: Message = {
                        id: crypto.randomUUID(), // Local ID
                        sessionId,
                        content: finalContent,
                        role: MessageSender.ASSISTANT,
                        timestamp: new Date(),
                        citations: finalCitations
                      };

                      const newMessages = [...state.messages, assistantMessage];

                      return {
                        messages: newMessages,
                        isStreaming: false, // Stop streaming interface
                        streamingContent: '',
                        streamingCitations: [],
                        isReadingSources: false,
                        progressPercentage: 100,
                        currentProgressStep: 'Complete',
                        pipelineStartedAt: null,
                        // Update cache immediately
                        messageCache: {
                          ...state.messageCache,
                          [sessionId]: newMessages
                        }
                      };
                    });
                  }

                  userIdLogger.logServiceCall('ChatStore', 'sessionService', 'getSession (done callback)', finalUserId);

                  // Use robust async error handling to prevent UI hanging
                  (async () => {
                    try {
                      const session = await services.sessionService.getSession(sessionId, finalUserId || undefined);

                      if (!session) {
                        throw new Error(`Session ${sessionId} not found during completion callback`);
                      }

                      userIdLogger.logServiceCall('ChatStore', 'messageService', 'getMessagesBySession (done callback)', session.userId);
                      const messages = await messageService.getMessagesBySession(sessionId, session.userId);

                      userIdLogger.logOperationEnd('ChatStore', operationId, finalUserId);

                      // If we didn't do optimistic update (legacy path), update now
                      if (!finalContent) {
                        const { setProgressState } = get();
                        setProgressState(100, 'Complete');
                      }

                      set(state => ({
                        messages,
                        isStreaming: false,
                        streamingContent: '',
                        streamingCitations: [],
                        isReadingSources: false,
                        pipelineStartedAt: null,
                        // Update cache with final messages
                        messageCache: {
                          ...state.messageCache,
                          [sessionId]: messages
                        }
                      }));
                    } catch (error) {
                      console.error('[ChatStore] Error checking for new messages in done callback:', error);
                      userIdLogger.logError('ChatStore.sendMessage.doneCallback', error instanceof Error ? error : String(error), finalUserId);

                      // Fallback: If we didn't have content and DB failed, show error
                      // If we DID have content, we just log the warning (UI is already fine)
                      if (!finalContent) {
                        const { setProgressState } = get();
                        setProgressState(100, 'Complete');
                        set({
                          isStreaming: false,
                          streamingContent: '',
                          streamingCitations: [],
                          isReadingSources: false,
                          pipelineStartedAt: null,
                          // Don't clear messages, just stop loading state
                          error: 'Response generated, but failed to refresh chat history. Pull to refresh.',
                        });
                      }
                    }
                  })();
                  } else if (event.type === 'suggestions') {
                    set((state) => ({
                      drugSuggestionsBySession: {
                        ...state.drugSuggestionsBySession,
                        [sessionId]: event.suggestions || [],
                      },
                    }));
                  } else if (event.type === 'error') {
                    isSettled = true;
                    userIdLogger.logError('ChatStore.sendMessage (pipeline error)', event.message || 'Unknown error', currentUserId);
                    set({
                      error: event.message || 'Failed to generate response',
                      isStreaming: false,
                    streamingContent: '',
                    streamingCitations: [],
                    isReadingSources: false,
                    progressPercentage: 0,
                    currentProgressStep: '',
                    pipelineStartedAt: null,
                  });
                }
                }
              ),
              PIPELINE_TIMEOUT_MS,
              'Request timed out. Please try again.'
            );

            // Defensive fallback: pipeline returned but never emitted done/error.
            if (!isSettled) {
              failPipeline('Request ended unexpectedly. Please try again.');
            }
          } catch (error) {
            userIdLogger.logError('ChatStore.sendMessage', error instanceof Error ? error : String(error), currentUserId);
            failPipeline(error instanceof Error ? error.message : 'Failed to send message');
          }
        },

        extractBrandsFromLatestAnswer: async (sessionId: string) => {
          const { userId: currentUserId } = useSessionStore.getState();
          const operationId = userIdLogger.logOperationStart('ChatStore', 'extractBrandsFromLatestAnswer', currentUserId);
          let isSettled = false;

          const failPipeline = (message: string) => {
            if (isSettled) return;
            isSettled = true;
            set({
              error: message,
              isStreaming: false,
              streamingContent: '',
              streamingCitations: [],
              isReadingSources: false,
              progressPercentage: 0,
              currentProgressStep: '',
              pipelineStartedAt: null,
            });
          };

          const rawSessionMode = get().sessionModeBySession[sessionId] || 'chat';
          const sessionMode: SessionChatMode =
            rawSessionMode === 'ask-drug' ? 'drug' : rawSessionMode;

          if (sessionMode !== 'chat') {
            failPipeline('Brand extraction is only available in Chat Mode.');
            return;
          }

          const latestAssistantMessage = [...get().messages]
            .reverse()
            .find((message) => message.role === MessageSender.ASSISTANT && message.sessionId === sessionId);

          if (!latestAssistantMessage?.content?.trim()) {
            failPipeline('No completed assistant answer is available to extract brands from.');
            return;
          }

          set({
            error: null,
            isStreaming: false,
            streamingContent: '',
            streamingCitations: [],
            isReadingSources: true,
            progressPercentage: 0,
            currentProgressStep: 'Brand Parsing',
            pipelineStartedAt: Date.now(),
          });

          try {
            const messageService = getMessageService();
            if (!messageService) {
              throw new Error('Message service not available');
            }

            await withTimeout(
              brandExtractionService.extractBrandsFromAnswer(
                sessionId,
                {
                  sourceMode: sessionMode,
                  answerText: latestAssistantMessage.content,
                },
                (event) => {
                  if (isSettled) return;

                  if (event.type === 'status') {
                    console.log('Chat status:', event.message);
                    const { setProgressState } = get();

                    switch (event.message) {
                      case 'Brand Parsing':
                        setProgressState(35, 'Brand Parsing');
                        break;
                      case 'Brand Lookup':
                        setProgressState(70, 'Brand Lookup');
                        break;
                      case 'Brand Answer Generation':
                        setProgressState(90, 'Brand Answer Generation');
                        break;
                      default:
                        break;
                    }
                  } else if (event.type === 'userMessage') {
                    const syntheticUserContent = event.content?.trim();
                    if (!syntheticUserContent) return;

                    set((state) => {
                      const syntheticUserMessage: Message = {
                        id: crypto.randomUUID(),
                        sessionId,
                        content: syntheticUserContent,
                        role: MessageSender.USER,
                        timestamp: new Date(),
                      };

                      const newMessages = [...state.messages, syntheticUserMessage];
                      return {
                        messages: newMessages,
                        messageCache: {
                          ...state.messageCache,
                          [sessionId]: newMessages,
                        },
                      };
                    });
                  } else if (event.type === 'done') {
                    isSettled = true;
                    const { content: finalContent, citations: finalCitations } = event;
                    const services = getIndexedDBServices();
                    const { userId: finalUserId } = useSessionStore.getState();

                    if (finalContent) {
                      set((state) => {
                        const assistantMessage: Message = {
                          id: crypto.randomUUID(),
                          sessionId,
                          content: finalContent,
                          role: MessageSender.ASSISTANT,
                          timestamp: new Date(),
                          citations: finalCitations,
                        };

                        const newMessages = [...state.messages, assistantMessage];
                        return {
                          messages: newMessages,
                          isStreaming: false,
                          streamingContent: '',
                          streamingCitations: [],
                          isReadingSources: false,
                          progressPercentage: 100,
                          currentProgressStep: 'Complete',
                          pipelineStartedAt: null,
                          messageCache: {
                            ...state.messageCache,
                            [sessionId]: newMessages,
                          },
                        };
                      });
                    }

                    (async () => {
                      try {
                        const session = await services.sessionService.getSession(sessionId, finalUserId || undefined);
                        if (!session) {
                          throw new Error(`Session ${sessionId} not found during brand extraction completion callback`);
                        }

                        const messages = await messageService.getMessagesBySession(sessionId, session.userId);
                        userIdLogger.logOperationEnd('ChatStore', operationId, finalUserId);

                        set((state) => ({
                          messages,
                          isStreaming: false,
                          streamingContent: '',
                          streamingCitations: [],
                          isReadingSources: false,
                          pipelineStartedAt: null,
                          messageCache: {
                            ...state.messageCache,
                            [sessionId]: messages,
                          },
                        }));
                      } catch (error) {
                        console.error('[ChatStore] Error checking for new messages in brand extraction done callback:', error);
                        userIdLogger.logError('ChatStore.extractBrandsFromLatestAnswer.doneCallback', error instanceof Error ? error : String(error), finalUserId);

                        if (!finalContent) {
                          set({
                            isStreaming: false,
                            streamingContent: '',
                            streamingCitations: [],
                            isReadingSources: false,
                            pipelineStartedAt: null,
                            error: 'Brand response generated, but failed to refresh chat history. Pull to refresh.',
                          });
                        }
                      }
                    })();
                  } else if (event.type === 'error') {
                    isSettled = true;
                    userIdLogger.logError('ChatStore.extractBrandsFromLatestAnswer (pipeline error)', event.message || 'Unknown error', currentUserId);
                    set({
                      error: event.message || 'Failed to generate brand response',
                      isStreaming: false,
                      streamingContent: '',
                      streamingCitations: [],
                      isReadingSources: false,
                      progressPercentage: 0,
                      currentProgressStep: '',
                      pipelineStartedAt: null,
                    });
                  }
                },
              ),
              PIPELINE_TIMEOUT_MS,
              'Brand extraction request timed out. Please try again.',
            );

            if (!isSettled) {
              failPipeline('Brand extraction ended unexpectedly. Please try again.');
            }
          } catch (error) {
            userIdLogger.logError('ChatStore.extractBrandsFromLatestAnswer', error instanceof Error ? error : String(error), currentUserId);
            failPipeline(error instanceof Error ? error.message : 'Failed to extract brands from the latest answer');
          }
        },

        clearHistory: async (sessionId: string) => {
          try {
            const messageService = getMessageService();
            if (!messageService) {
              throw new Error('Message service not available');
            }
            const services = getIndexedDBServices();
            const { userId: currentUserId } = useSessionStore.getState();
            await messageService.deleteMessagesBySession(sessionId, currentUserId || undefined);
            await services.sessionService.updateSession(
              sessionId,
              { latestRewriteQueryResponse: null },
              currentUserId || undefined
            );
            set(state => ({
              messages: [],
              error: null,
              drugContextBySession: Object.fromEntries(
                Object.entries(state.drugContextBySession).filter(([key]) => key !== sessionId)
              ),
              // Clear from cache
              messageCache: {
                ...state.messageCache,
                [sessionId]: []
              }
            }));
          } catch (error) {
            set({
              error: error instanceof Error ? error.message : 'Failed to clear messages',
            });
          }
        },

        setStreamingState: (isStreaming: boolean, content?: string, citations?: any[]) => {
          set({
            isStreaming,
            streamingContent: content || '',
            streamingCitations: citations || [],
          });
        },

        addMessage: (message: Message) => {
          set(state => {
            const newMessages = [...state.messages, message];
            return {
              messages: newMessages,
              // Update cache
              messageCache: {
                ...state.messageCache,
                [message.sessionId]: newMessages
              }
            };
          });
        },

        setError: (error: string | null) => {
          set({ error });
        },

        setReadingSourcesState: (isReadingSources: boolean) => {
          set({ isReadingSources });
        },

        setProgressState: (percentage: number, step: string) => {
          set({
            progressPercentage: percentage,
            currentProgressStep: step
          });
        },

        resetTransientState: (errorMessage?: string) => {
          set({
            isStreaming: false,
            streamingContent: '',
            streamingCitations: [],
            isReadingSources: false,
            progressPercentage: 0,
            currentProgressStep: '',
            pipelineStartedAt: null,
            error: errorMessage || null,
          });
        },

        // Rate limiting methods
        checkRateLimit: () => {
          const { questionTimestamps } = get();
          const now = Date.now();
          const oneMinuteAgo = now - 60000;

          // Filter to get questions in the last minute
          const recentQuestions = questionTimestamps.filter(ts => ts > oneMinuteAgo);

          // Allow up to 3 questions in the last minute. Block from the 4th.
          if (recentQuestions.length < 3) {
            return 0;
          }

          // Calculate when the oldest recent question will expire (+ 1 second buffer)
          const oldestRecentQuestion = Math.min(...recentQuestions);
          const waitTime = Math.ceil((oldestRecentQuestion + 60000 - now) / 1000) + 1;

          console.log('[RATE LIMIT]', {
            recentQuestions: recentQuestions.length,
            waitTime,
            oldestRecentQuestion: new Date(oldestRecentQuestion).toISOString()
          });

          return Math.max(0, waitTime);
        },

        setRateLimitState: (isLimited: boolean, waitSeconds: number) => {
          set({
            isRateLimited: isLimited,
            rateLimitWaitSeconds: waitSeconds
          });
        },

        recordQuestion: () => {
          const { questionTimestamps } = get();
          const now = Date.now();
          const oneMinuteAgo = now - 60000;

          // Keep only recent timestamps + the new one
          const updatedTimestamps = [
            ...questionTimestamps.filter(ts => ts > oneMinuteAgo),
            now
          ];

          console.log('[RATE LIMIT]', 'Recording question. Total in last minute:', updatedTimestamps.length);

          set({ questionTimestamps: updatedTimestamps });
        },

        setSessionModeForSession: (sessionId: string, mode: SessionChatMode) => {
          console.log('[SESSION MODE]', 'Persisting session mode', {
            sessionId,
            mode,
          });

          set((state) => ({
            sessionModeBySession: {
              ...state.sessionModeBySession,
              [sessionId]: mode,
            },
          }));
        },

        setDrugSuggestionsForSession: (sessionId: string, suggestions: string[]) => {
          set((state) => ({
            drugSuggestionsBySession: {
              ...state.drugSuggestionsBySession,
              [sessionId]: suggestions,
            },
          }));
        },

        clearDrugSuggestionsForSession: (sessionId: string) => {
          set((state) => ({
            drugSuggestionsBySession: {
              ...state.drugSuggestionsBySession,
              [sessionId]: [],
            },
          }));
        },

        markSkipNextDrugFollowUpRewriteForSession: (sessionId: string) => {
          console.log('[DRUG FOLLOW-UP REWRITE][MARK][CLICKED-ACTION]', {
            sessionId,
          });
          set((state) => ({
            skipNextDrugFollowUpRewriteBySession: {
              ...state.skipNextDrugFollowUpRewriteBySession,
              [sessionId]: true,
            },
          }));
        },

        getSessionMode: (sessionId: string) => {
          return get().sessionModeBySession[sessionId] || 'chat';
        },
      }),
      {
        name: 'chat-store',
        partialize: (state) => ({
          sessionModeBySession: state.sessionModeBySession,
          drugContextBySession: state.drugContextBySession,
        }),
      }
    )
  )
);
