import { create } from 'zustand';
import { devtools, persist } from 'zustand/middleware';
import type { DocumentStore } from './types';
import { Document, DocumentUpdate, DocumentProgress } from '@/types/document';
import { getIndexedDBServices } from '../services/indexedDB';
import { userIdLogger } from '../utils/userIdDebugLogger';

// Helper function to get services (client-side only)
const getDocumentService = () => {
  if (typeof window !== 'undefined') {
    const services = getIndexedDBServices();
    return services.documentService;
  }
  return null;
};

export const useDocumentStore = create<DocumentStore>()(
  devtools(
    persist(
      (set, get) => ({
        // State
        documents: [],
        progressMap: {},
        isUploading: false,
        error: null,
        userId: null,

        // Actions
        setUserId: (userId: string | null) => {
          userIdLogger.logStoreUpdate('DocumentStore', userId, 'setUserId');
          set({ userId });
        },

        clearDocuments: () => {
          userIdLogger.logStoreUpdate('DocumentStore', null, 'clearDocuments');
          set({ documents: [], progressMap: {}, error: null, userId: null });
        },

        loadDocuments: async (sessionId: string) => {
          // Only run on client side
          if (typeof window === 'undefined') {
            console.warn('[DOCUMENT STORE] Skipping loadDocuments during SSR');
            return;
          }
          
          const { userId } = get();
          
          try {
            console.log('🔍 DOCUMENT STORE DEBUG: Starting loadDocuments for session:', sessionId);
            const documentService = getDocumentService();
            if (!documentService) {
              console.error('🔍 DOCUMENT STORE DEBUG: Document service not available');
              throw new Error('Document service not available');
            }

            if (!userId) {
              const errorMsg = 'User ID not found. Please log in.';
              console.error('🔍 DOCUMENT STORE DEBUG: User ID not found');
              userIdLogger.logError('DocumentStore.loadDocuments', errorMsg, null);
              set({ error: errorMsg });
              return;
            }

            const operationId = userIdLogger.logOperationStart('DocumentStore', 'loadDocuments', userId);

            console.log('🔍 DOCUMENT STORE DEBUG: Calling getDocumentsBySession');
            console.log('🔍 DUPLICATE DEBUG: Loading documents from IndexedDB at:', new Date().toISOString());
            userIdLogger.logServiceCall('DocumentStore', 'documentService', 'getDocumentsBySession', userId);
            const documents = await documentService.getDocumentsBySession(sessionId, userId);

            console.log('🔍 DOCUMENT STORE DEBUG: Documents retrieved from database:', {
              sessionId,
              count: documents.length,
              documents: documents.map(doc => ({
                id: doc.id,
                filename: doc.filename,
                enabled: doc.enabled,
                status: doc.status,
                processedAt: doc.processedAt
              }))
            });

            console.log('🔍 DOCUMENT STORE DEBUG: About to update store state');
            console.log('🔍 DUPLICATE DEBUG: Updating document store state at:', new Date().toISOString());
            
            userIdLogger.logOperationEnd('DocumentStore', operationId, userId);
            set({ documents });

            console.log('🔍 DOCUMENT STORE DEBUG: Store state updated, verifying...');
            const currentState = get();
            console.log('🔍 DUPLICATE DEBUG: Document store state updated at:', new Date().toISOString());
            console.log('🔍 DOCUMENT STORE DEBUG: Current store state:', {
              documentCount: currentState.documents.length,
              documents: currentState.documents.map(doc => ({
                id: doc.id,
                filename: doc.filename,
                enabled: doc.enabled,
                status: doc.status,
                processedAt: doc.processedAt
              }))
            });

            console.log('[DOCUMENT STORE] Loaded documents:', {
              sessionId,
              count: documents.length,
              documents: documents.map(doc => ({
                id: doc.id,
                filename: doc.filename,
                enabled: doc.enabled,
                status: doc.status,
                processedAt: doc.processedAt
              }))
            });
          } catch (error) {
            userIdLogger.logError('DocumentStore.loadDocuments', error instanceof Error ? error : String(error), userId);
            console.error('🔍 DOCUMENT STORE DEBUG: Failed to load documents:', error);
            console.error('[DOCUMENT STORE] Failed to load documents:', error);
            set({
              error: error instanceof Error ? error.message : 'Failed to load documents',
            });
          }
        },

        uploadDocuments: async (sessionId: string, files: File[]) => {
          // Only run on client side
          if (typeof window === 'undefined') {
            console.warn('[DOCUMENT STORE] Skipping uploadDocuments during SSR');
            throw new Error('Cannot upload documents during SSR');
          }
          
          const { userId } = get();
          if (!userId) {
            const errorMsg = 'User ID not found. Please log in.';
            userIdLogger.logError('DocumentStore.uploadDocuments', errorMsg, null);
            set({ error: errorMsg });
            return;
          }

          set({ isUploading: true, error: null });

          try {
            const documentService = getDocumentService();
            if (!documentService) {
              throw new Error('Document service not available');
            }

            for (const file of files) {
              // Create document entry
              const document = await documentService.createDocument({
                sessionId,
                filename: file.name,
                fileSize: file.size,
                mimeType: file.type,
              }, userId);

              // Set initial progress
              set(state => ({
                progressMap: {
                  ...state.progressMap,
                  [document.id]: {
                    status: 'pending',
                    progress: 0,
                  },
                },
              }));

              // TODO: Implement actual file processing
              // For now, simulate processing
              setTimeout(() => {
                set(state => ({
                  progressMap: {
                    ...state.progressMap,
                    [document.id]: {
                      status: 'completed',
                      progress: 100,
                    },
                  },
                }));

                // Update document status
                const docService = getDocumentService();
                if (docService) {
                  docService.updateDocument(document.id, {
                    status: 'completed',
                    processedAt: new Date(),
                  }, userId);
                }
              }, 2000);
            }

            set({ isUploading: false });
          } catch (error) {
            set({
              isUploading: false,
              error: error instanceof Error ? error.message : 'Failed to upload documents',
            });
          }
        },

        updateDocument: async (id: string, data: DocumentUpdate) => {
          try {
            const documentService = getDocumentService();
            if (!documentService) {
              throw new Error('Document service not available');
            }
            const { userId } = get();
            if (!userId) {
              const errorMsg = 'User ID not found. Please log in.';
              userIdLogger.logError('DocumentStore.updateDocument', errorMsg, null);
              set({ error: errorMsg });
              return;
            }
            
            const operationId = userIdLogger.logOperationStart('DocumentStore', 'updateDocument', userId);
            userIdLogger.logServiceCall('DocumentStore', 'documentService', 'updateDocument', userId);
            await documentService.updateDocument(id, data, userId);
            userIdLogger.logOperationEnd('DocumentStore', operationId, userId);

            set(state => ({
              documents: state.documents.map(doc =>
                doc.id === id ? { ...doc, ...data } : doc
              ),
            }));
          } catch (error) {
            set({
              error: error instanceof Error ? error.message : 'Failed to update document',
            });
          }
        },

        toggleDocumentEnabled: async (id: string) => {
          try {
            const documentService = getDocumentService();
            if (!documentService) {
              throw new Error('Document service not available');
            }

            // Get current document to toggle its enabled status
            const currentDoc = get().documents.find(doc => doc.id === id);
            if (!currentDoc) {
              throw new Error('Document not found');
            }

            const { userId } = get();
            if (!userId) {
              const errorMsg = 'User ID not found. Please log in.';
              userIdLogger.logError('DocumentStore.toggleDocumentEnabled', errorMsg, null);
              set({ error: errorMsg });
              return;
            }
            
            const operationId = userIdLogger.logOperationStart('DocumentStore', 'toggleDocumentEnabled', userId);
            const newEnabledStatus = !currentDoc.enabled;
            userIdLogger.logServiceCall('DocumentStore', 'documentService', 'toggleDocumentEnabled', userId);
            await documentService.toggleDocumentEnabled(id, userId);
            userIdLogger.logOperationEnd('DocumentStore', operationId, userId);

            set(state => ({
              documents: state.documents.map(doc =>
                doc.id === id ? { ...doc, enabled: newEnabledStatus } : doc
              ),
            }));
          } catch (error) {
            set({
              error: error instanceof Error ? error.message : 'Failed to toggle document enabled status',
            });
          }
        },

        deleteDocument: async (id: string) => {
          try {
            console.log('🗑️ DocumentStore: Starting deleteDocument with ID:', id);
            
            const documentService = getDocumentService();
            if (!documentService) {
              console.error('❌ DocumentStore: Document service not available');
              throw new Error('Document service not available');
            }

            const { userId } = get();
            if (!userId) {
              const errorMsg = 'User ID not found. Please log in.';
              console.error('❌ DocumentStore: User ID not found');
              userIdLogger.logError('DocumentStore.deleteDocument', errorMsg, null);
              set({ error: errorMsg });
              return;
            }
            
            const operationId = userIdLogger.logOperationStart('DocumentStore', 'deleteDocument', userId);
            console.log('🗑️ DocumentStore: About to call documentService.deleteDocument');
            
            // First, perform the IndexedDB deletion
            userIdLogger.logServiceCall('DocumentStore', 'documentService', 'deleteDocument', userId);
            await documentService.deleteDocument(id, userId);
            console.log('✅ DocumentStore: Successfully deleted document from IndexedDB:', id);
            userIdLogger.logOperationEnd('DocumentStore', operationId, userId);

            // Update the state after successful IndexedDB deletion
            console.log('🗑️ DocumentStore: Updating store state to remove document');
            set(state => {
              const newProgressMap = { ...state.progressMap };
              delete newProgressMap[id];
              return {
                documents: state.documents.filter(doc => doc.id !== id),
                progressMap: newProgressMap
              };
            });
            console.log('✅ DocumentStore: Document deletion process completed successfully');
          } catch (error) {
            console.error('❌ DocumentStore: Failed to delete document:', {
              id,
              error: error instanceof Error ? error.message : error,
              stack: error instanceof Error ? error.stack : undefined
            });
            // Set error state to be handled by UI components
            const errorMessage = error instanceof Error ? error.message : 'Failed to delete document';
            set({ error: errorMessage });
            // Re-throw the error so the calling component can handle it
            throw error;
          }
        },

        setProgress: (documentId: string, progress: DocumentProgress) => {
          set(state => ({
            progressMap: {
              ...state.progressMap,
              [documentId]: progress,
            },
          }));
        },

        clearProgress: (documentId: string) => {
          set(state => {
            const newProgressMap = { ...state.progressMap };
            delete newProgressMap[documentId];
            return { progressMap: newProgressMap };
          });
        },

        setUploading: (isUploading: boolean) => {
          set({ isUploading });
        },

        setError: (error: string | null) => {
          set({ error });
        },
      }),
      {
        name: 'document-store',
        partialize: (state) => ({
          documents: state.documents,
          userId: state.userId,
        }),
      }
    )
  )
);