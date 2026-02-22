'use client';

import React, { useState, useEffect, useMemo } from 'react';
import { libraryService } from '@/services/libraryService';
import type { LibraryItem } from '@/types/library';
import { documentProcessor } from '@/services/rag';
import { useDocumentStore } from '@/store';
import { Button, Loading } from '@/components/ui';
import { getIndexedDBServices } from '@/services/indexedDB';

interface DocumentLibraryProps {
  sessionId: string;
  onClose: () => void;
}

interface ProcessingStatus {
  [bookId: string]: {
    status: 'pending' | 'processing' | 'completed' | 'error';
    progress?: number;
    error?: string;
    documentId?: string;
  };
}

export const DocumentLibrary: React.FC<DocumentLibraryProps> = ({ sessionId, onClose }) => {
  const [books, setBooks] = useState<LibraryItem[]>([]);
  const [isLoadingList, setIsLoadingList] = useState(true);
  const [selectedCategory, setSelectedCategory] = useState<string>('All Sources');
  const [selectedBooks, setSelectedBooks] = useState<Set<string>>(new Set());
  const [isBatchProcessing, setIsBatchProcessing] = useState(false);
  const [processingStatus, setProcessingStatus] = useState<ProcessingStatus>({});
  const [error, setError] = useState<string | null>(null);

  const { userId, loadDocuments } = useDocumentStore();
  const getLibrarySourcePath = (bookId: string) => `library:${bookId}`;

  // Fetch books on mount
  useEffect(() => {
    const fetchBooks = async () => {
      try {
        const list = await libraryService.getAvailableBooks();
        setBooks(list);
      } catch (err) {
        setError("Failed to load the library. Please check your internet connection.");
      } finally {
        setIsLoadingList(false);
      }
    };
    fetchBooks();
  }, []);

  // Extract unique categories
  const categories = useMemo(() => {
    const uniqueCategories = Array.from(new Set(books.map(book => book.category)));
    return ['All Sources', ...uniqueCategories];
  }, [books]);

  // Filter books based on selected category
  const filteredBooks = useMemo(() => {
    if (selectedCategory === 'All Sources') {
      return books;
    }
    return books.filter(book => book.category === selectedCategory);
  }, [books, selectedCategory]);

  // Derived state for select all checkbox
  const areAllFilteredSelected = filteredBooks.length > 0 && filteredBooks.every(book => selectedBooks.has(book.id));

  // Calculate total progress for batch processing
  const totalProgress = useMemo(() => {
    if (selectedBooks.size === 0) return 0;
    let total = 0;
    selectedBooks.forEach(bookId => {
      const status = processingStatus[bookId];
      if (status?.status === 'completed') {
        total += 100;
      } else if (status?.progress) {
        total += status.progress;
      }
    });
    return Math.round(total / selectedBooks.size);
  }, [selectedBooks, processingStatus]);

  // Handle individual book selection
  const handleBookSelection = (bookId: string) => {
    const newSelectedBooks = new Set(selectedBooks);
    if (newSelectedBooks.has(bookId)) {
      newSelectedBooks.delete(bookId);
    } else {
      newSelectedBooks.add(bookId);
    }
    setSelectedBooks(newSelectedBooks);

    // No need to manually update state, it's derived
  };

  // Handle select all checkbox
  const handleSelectAll = () => {
    const newSelected = new Set(selectedBooks);

    if (areAllFilteredSelected) {
      // Uncheck: Remove all currently filtered books from selection
      filteredBooks.forEach(book => newSelected.delete(book.id));
    } else {
      // Check: Add all currently filtered books to selection
      filteredBooks.forEach(book => newSelected.add(book.id));
    }
    setSelectedBooks(newSelected);
  };

  // Check for cached books across all sessions - returns source document if found
  // This enables smart caching: if book exists in another session, we copy instead of re-downloading
  const findCachedBook = async (book: LibraryItem): Promise<{ document: any; isInCurrentSession: boolean } | null> => {
    console.log(`🔍 CACHE CHECK: Looking for cached book: "${book.name}"`);

    try {
      if (!userId) {
        console.log('🔍 CACHE CHECK: No userId available');
        return null;
      }

      // Get ALL documents for this user across ALL sessions
      const { documentService } = await getIndexedDBServices();
      const allDocuments = await documentService.getAllDocumentsForUser(userId);
      const librarySourcePath = getLibrarySourcePath(book.id);

      console.log(`🔍 CACHE CHECK: Searching ${allDocuments.length} documents across all sessions`);
      console.log(`🔍 CACHE CHECK: Documents:`, allDocuments.map(d => ({ filename: d.filename, title: d.title, sessionId: d.sessionId })));

      // Strict cache key match by library source ID to avoid wrong cross-book matches.
      const matchedDoc = allDocuments.find(doc => doc.originalPath === librarySourcePath);
      if (matchedDoc) {
        console.log(`🔍 CACHE CHECK: Matched by library source path: ${librarySourcePath}`);
      }

      if (matchedDoc) {
        const isInCurrentSession = matchedDoc.sessionId === sessionId;
        console.log(`🔍 CACHE HIT: Found "${book.name}" in ${isInCurrentSession ? 'CURRENT' : 'ANOTHER'} session`);
        return { document: matchedDoc, isInCurrentSession };
      }

      console.log(`🔍 CACHE MISS: "${book.name}" not found in any session`);
      return null;
    } catch (error) {
      console.error('🔍 CACHE CHECK ERROR:', error);
      return null;
    }
  };

  // Copy a book from another session to the current session (fast, no download)
  const copyBookFromCache = async (
    book: LibraryItem,
    sourceDoc: any,
    onProgress: (progress: number) => void
  ): Promise<string> => {
    console.log(`📋 CACHE COPY: Copying "${book.name}" from session ${sourceDoc.sessionId} to ${sessionId}`);

    const { documentService, embeddingService, annIndexService, routeIndexService } = await getIndexedDBServices();

    // Animate progress over 2 seconds (fake but satisfying UX)
    const animateProgress = async () => {
      for (let i = 0; i <= 100; i += 5) {
        onProgress(i);
        await new Promise(resolve => setTimeout(resolve, 100)); // 100ms * 20 steps = 2 seconds
      }
    };

    // Start animation and copy in parallel
    const animationPromise = animateProgress();

    // Get embeddings from source document
    const sourceEmbeddings = await embeddingService.getEmbeddingsByDocument(sourceDoc.id);
    console.log(`📋 CACHE COPY: Found ${sourceEmbeddings.length} embeddings to copy`);

    // Create new document in current session (with new ID)
    const newDocId = crypto.randomUUID();
    const newDocument = await documentService.createDocument({
      id: newDocId,
      sessionId: sessionId,
      filename: sourceDoc.filename,
      fileSize: sourceDoc.fileSize,
      pageCount: sourceDoc.pageCount,
      title: sourceDoc.title,
      originalPath: getLibrarySourcePath(book.id),
    }, userId!);

    // Copy embeddings with new IDs pointing to new document
    if (sourceEmbeddings.length > 0) {
      const chunkIdMap: Record<string, string> = {};
      const newEmbeddings = sourceEmbeddings.map(emb => {
        const newChunkId = crypto.randomUUID();
        chunkIdMap[emb.id] = newChunkId;
        return {
          ...emb,
          id: newChunkId,
          documentId: newDocId,
          sessionId: sessionId,
          createdAt: new Date(),
        };
      });

      await embeddingService.addEmbeddingsDirectly(newEmbeddings);
      console.log(`📋 CACHE COPY: Copied ${newEmbeddings.length} embeddings`);

      // Clone route prefilter index if present and remap chunk IDs to the copied chunk IDs.
      try {
        await routeIndexService.cloneRouteIndexForDocument(sourceDoc.id, newDocId, chunkIdMap);
      } catch (routeCloneError) {
        console.warn('📋 CACHE COPY: Route index clone failed, continuing without prefilter index', routeCloneError);
      }
    }

    // Clone ANN index assets if available so copied books keep fast retrieval
    await annIndexService.cloneIndexForDocument(sourceDoc.id, newDocId);

    // Mark document as completed
    await documentService.updateDocumentStatus(newDocId, 'completed', undefined, userId ?? undefined);

    // Wait for animation to finish (ensures smooth UX)
    await animationPromise;

    console.log(`📋 CACHE COPY: Successfully copied "${book.name}" to current session`);
    return newDocId;
  };

  // Process a single book (with smart caching) and return the resulting document ID if successful
  const processSingleBook = async (book: LibraryItem): Promise<string | undefined> => {
    console.log(`🔍 PROCESSING: Starting to process book "${book.name}"`);

    if (!userId) throw new Error("User ID is required");

    // Check if book is already cached somewhere
    const cached = await findCachedBook(book);

    if (cached) {
      if (cached.isInCurrentSession) {
        setProcessingStatus(prev => ({
          ...prev,
          [book.id]: { status: 'completed', progress: 100, documentId: cached.document.id }
        }));
        return cached.document.id;
      }

      // Book exists in ANOTHER session - copy it with fake progress animation
      console.log(`🔍 PROCESSING: Book "${book.name}" found in another session, copying...`);
      setProcessingStatus(prev => ({
        ...prev,
        [book.id]: { status: 'processing', progress: 0 }
      }));

      try {
        const newDocId = await copyBookFromCache(book, cached.document, (progress) => {
          setProcessingStatus(prev => ({
            ...prev,
            [book.id]: { status: 'processing', progress }
          }));
        });

        setProcessingStatus(prev => ({
          ...prev,
          [book.id]: { status: 'completed', progress: 100, documentId: newDocId }
        }));
        return newDocId;
      } catch (err) {
        console.error(`📋 CACHE COPY ERROR: Failed to copy "${book.name}", falling back to download`, err);
        // Fall through to normal download
      }
    }

    // Book not cached anywhere - proceed with normal download
    console.log(`🔍 PROCESSING: No cache found for "${book.name}", downloading fresh...`);

    console.log('🔍 PROCESS SINGLE BOOK DEBUG: Starting processing for book:', {
      bookId: book.id,
      bookName: book.name,
      sessionId,
      userId: userId.substring(0, 8) + '...',
      timestamp: new Date().toISOString()
    });

    setProcessingStatus(prev => ({
      ...prev,
      [book.id]: { status: 'processing', progress: 0 }
    }));

    try {
      console.log('🔍 DOWNLOAD DEBUG: Starting download for book:', book.name);
      // Download main package and optional routing companion in parallel.
      const [jsonData, routingCompanion] = await Promise.all([
        libraryService.downloadAndParseBook(book.url),
        libraryService.downloadRoutingCompanion(book.url),
      ]);
      console.log('🔍 DOWNLOAD DEBUG: Successfully downloaded and parsed book:', {
        bookName: book.name,
        chunksCount: jsonData.chunks?.length || 0,
        documentId: jsonData.document_metadata?.id,
        hasRoutingCompanion: Boolean(routingCompanion)
      });

      // Process into Database with progress tracking
      console.log(`[Library] Processing package into session ${sessionId}...`);
      console.log('🔍 PROCESSING DEBUG: Starting document processing for:', {
        bookName: book.name,
        sessionId,
        chunksCount: jsonData.chunks?.length || 0
      });

      const operationId = await documentProcessor.processPreprocessedPackage(
        sessionId,
        jsonData,
        userId,
        (progress) => {
          console.log('🔍 PROGRESS DEBUG: Progress update for book:', {
            bookName: book.name,
            processedChunks: progress.processedChunks,
            totalChunks: progress.totalChunks,
            currentChunk: progress.currentChunk,
            isComplete: progress.isComplete,
            progressPercent: Math.round((progress.processedChunks / progress.totalChunks) * 100)
          });

          setProcessingStatus(prev => ({
            ...prev,
            [book.id]: {
              status: 'processing',
              progress: Math.round((progress.processedChunks / progress.totalChunks) * 100)
            }
          }));
        },
        {
          librarySourceId: book.id,
          routingCompanion: routingCompanion ?? undefined
        }
      );

      console.log('🔍 PROCESSING DEBUG: Document processing completed for book:', {
        bookName: book.name,
        operationId,
        finalStatus: 'completed'
      });

      setProcessingStatus(prev => ({
        ...prev,
        [book.id]: {
          status: 'completed',
          progress: 100,
          documentId: jsonData.document_metadata?.id
        }
      }));

      return jsonData.document_metadata?.id;
    } catch (err) {
      console.error('🔍 PROCESSING ERROR DEBUG: Error processing book:', {
        bookName: book.name,
        error: err instanceof Error ? err.message : 'Unknown error',
        stack: err instanceof Error ? err.stack : 'No stack trace',
        timestamp: new Date().toISOString()
      });

      // Check if this is a duplicate error and handle it specially
      if (err instanceof Error && (err as any).isDuplicate) {
        console.log('🔍 DUPLICATE PREVENTION: Handling duplicate error for book:', book.name);
        setProcessingStatus(prev => ({
          ...prev,
          [book.id]: {
            status: 'error',
            error: 'Duplicate document - already in library'
          }
        }));
        return; // Don't continue with regular error handling
      }

      setProcessingStatus(prev => ({
        ...prev,
        [book.id]: {
          status: 'error',
          error: err instanceof Error ? err.message : 'Failed to download book'
        }
      }));
    }
  };

  // Handle batch processing
  const handleBatchDownload = async () => {
    if (!userId) return alert("Please log in first");
    if (selectedBooks.size === 0) return alert("Please select at least one book");

    setIsBatchProcessing(true);
    const selectedBooksList = books.filter(book => selectedBooks.has(book.id));
    const processedDocIds: Record<string, string> = {};

    try {
      // Process all selected books sequentially
      for (const book of selectedBooksList) {
        const docId = await processSingleBook(book);
        if (docId) {
          processedDocIds[book.id] = docId;
        }
      }

      // Wait a moment for the final status updates and database sync
      await new Promise(resolve => setTimeout(resolve, 1500));

      // Refresh UI to get the actual document status from database
      await loadDocuments(sessionId);

      // Get accurate documents from store (Zustand state is fresh here because of the await)
      const { documents: allDocs } = useDocumentStore.getState();

      // Count successful and failed downloads by checking actual document status
      let successful = 0;
      let failed = 0;

      for (const book of selectedBooksList) {
        // Try to find the document using the ID we captured during processing
        const trackedId = processedDocIds[book.id];
        let document = allDocs.find(doc => doc.id === trackedId);

        // Fallback strategies for finding the document
        if (!document) {
          document = allDocs.find(doc =>
            doc.originalPath === getLibrarySourcePath(book.id) ||
            doc.filename === book.name ||
            doc.title === book.name
          );

          if (!document) {
            const urlFilename = book.url.split('/').pop()?.split('.')[0];
            if (urlFilename) {
              document = allDocs.find(doc =>
                doc.filename.includes(urlFilename) ||
                doc.title?.includes(urlFilename)
              );
            }
          }
        }

        const actualStatus = document?.status;

        if (actualStatus === 'completed') {
          successful++;
          console.log(`🔍 SUCCESS: Found and confirmed book "${book.name}"`);
        } else {
          failed++;
          console.log(`🔍 FAILURE: Could not confirm status for "${book.name}" (Status: ${actualStatus || 'not found'})`);
        }
      }

      console.log('🔍 FINAL BATCH STATS:', { successful, failed, total: selectedBooksList.length });

      if (failed === 0) {
        alert("All books were successfully added!");
      } else if (successful > 0) {
        alert(`${successful} books were added. ${failed} failed.`);
      } else {
        alert("Failed to add the selected books.");
      }

      // Clear selections and close modal
      setSelectedBooks(new Set());
      setProcessingStatus({});
      onClose();

    } catch (err) {
      console.error(err);
      alert(`Error during batch processing: ${err instanceof Error ? err.message : 'Unknown error'}`);
    } finally {
      setIsBatchProcessing(false);
    }
  };

  // Handle single book download (legacy support)
  const handleDownload = async (book: LibraryItem) => {
    if (!userId) return alert("Please log in first");

    setSelectedBooks(new Set([book.id]));
    await handleBatchDownload();
  };

  return (
    <div className="fixed inset-0 z-50 bg-gray-50 dark:bg-slate-900">
      <div className="h-full w-full flex flex-col">
        {/* Header */}
        <div className="p-6 border-b border-gray-200 dark:border-slate-700 bg-white dark:bg-slate-900">
          <div className="flex flex-col mb-4">
            <h2 className="text-2xl font-bold text-gray-900 dark:text-white">Medical Library</h2>
            <p className="text-sm text-gray-500 dark:text-gray-400">
              Verified medical resources, ready for instant use.
              <br />
              <span className="inline-flex items-center gap-1.5 px-2.5 py-1 mt-2.5 text-xs font-semibold rounded-sm bg-blue-50 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 border border-blue-100 dark:border-blue-800/50 shadow-sm w-fit">
                <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M8.111 16.404a5.5 5.5 0 017.778 0M12 20h.01m-7.08-7.071c3.904-3.905 10.236-3.905 14.141 0M1.345 8.99c5.858-5.857 15.352-5.857 21.21 0" />
                </svg>
                Please add large books using WiFi
              </span>
            </p>
          </div>

        </div>

        {/* Content Area */}
        <div className="flex-1 overflow-y-auto p-6 relative z-10">
          {/* Controls Row - Moved inside scrollable area */}
          <div className="flex flex-col sm:flex-row gap-4 items-start sm:items-center justify-between mb-6">
            {/* Category Filter Pills */}
            <div className="flex-1 min-w-0 w-full sm:w-auto sm:overflow-x-auto sm:no-scrollbar sm:mask-linear-fade">
              <div className="flex flex-wrap sm:flex-nowrap items-center gap-2 pb-1">
                {categories.map(category => {
                  const isSelected = selectedCategory === category;
                  return (
                    <button
                      key={category}
                      onClick={() => setSelectedCategory(category)}
                      data-selected={isSelected}
                      className={`
                        library-category-pill
                        px-4 py-1.5 rounded-full text-sm font-medium whitespace-nowrap transition-all duration-200 border
                        ${isSelected
                          ? 'bg-gray-900 dark:bg-white text-white dark:text-black border-gray-900 dark:border-white'
                          : 'bg-transparent text-gray-700 dark:text-white border-gray-300 dark:border-white hover:border-gray-400 dark:hover:border-gray-200'}
                      `}
                    >
                      {category}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Selection Controls */}
            <div className="flex items-center gap-4">
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={areAllFilteredSelected}
                  onChange={handleSelectAll}
                  disabled={isBatchProcessing}
                  className="w-5 h-5 text-blue-600 bg-gray-100 border-gray-300 rounded focus:ring-blue-500 focus:ring-2"
                />
                <span className="text-sm font-medium text-gray-700 dark:text-gray-300">
                  Select All ({filteredBooks.length})
                </span>
              </label>

            </div>
          </div>
          {isLoadingList ? (
            <div className="flex flex-col items-center justify-center h-64 space-y-4">
              <Loading size="lg" />
              <p className="text-gray-500">Fetching catalog from server...</p>
            </div>
          ) : error ? (
            <div className="text-center text-red-500 p-10">
              <p className="text-lg font-semibold">Unable to connect</p>
              <p className="text-sm">{error}</p>
              <Button className="mt-4" onClick={() => window.location.reload()} variant="outline">Retry</Button>
            </div>
          ) : filteredBooks.length === 0 ? (
            <div className="text-center text-gray-500 p-10">
              <p className="text-lg font-semibold">No books found</p>
              <p className="text-sm">Try selecting a different category</p>
            </div>
          ) : (
            <div className="space-y-3">
              {filteredBooks.map((book) => {
                const isSelected = selectedBooks.has(book.id);
                const status = processingStatus[book.id];
                const isProcessing = status?.status === 'processing';
                const isCompleted = status?.status === 'completed';
                const hasError = status?.status === 'error';

                return (
                  <div
                    key={book.id}
                    className={`
                      bg-white dark:bg-slate-800 px-4 py-3 rounded-lg border
                      ${isProcessing ? 'border-blue-500 ring-1 ring-blue-500' :
                        isCompleted ? 'border-green-500 ring-1 ring-green-500' :
                          hasError ? 'border-red-500 ring-1 ring-red-500' :
                            'border-gray-200 dark:border-slate-700'}
                      ${isSelected ? 'ring-2 ring-blue-500' : ''}
                      shadow-sm hover:shadow-md transition-all duration-200
                    `}
                  >
                    <div className="flex items-start gap-3">
                      <div className="flex-1 min-w-0">
                        <h3 className="font-semibold text-base text-gray-900 dark:text-white leading-tight">
                          {book.name}
                        </h3>
                        <div className="mt-1 flex items-center gap-2">
                          <span className="text-xs text-gray-500 dark:text-gray-400">
                            {book.size}
                          </span>
                          {isCompleted && (
                            <span className="text-xs font-medium text-green-600 dark:text-green-400">
                              Added
                            </span>
                          )}
                          {hasError && (
                            <span className="text-xs font-medium text-red-600 dark:text-red-400">
                              Error
                            </span>
                          )}
                        </div>
                      </div>

                      <input
                        type="checkbox"
                        checked={isSelected}
                        onChange={() => handleBookSelection(book.id)}
                        disabled={isBatchProcessing}
                        className="w-5 h-5 text-blue-600 bg-gray-100 border-gray-300 rounded focus:ring-blue-500 focus:ring-2 cursor-pointer"
                      />
                    </div>

                    {/* Progress Status */}
                    {status && isProcessing && (
                      <div className="mt-2">
                        {isProcessing && (
                          <div className="space-y-2">
                            <div className="flex justify-between text-xs">
                              <span className="text-gray-600 dark:text-gray-300">Processing...</span>
                              <span className="text-gray-600 dark:text-gray-300">{status.progress}%</span>
                            </div>
                            <div className="w-full bg-gray-200 dark:bg-slate-700 rounded-full h-1.5">
                              <div
                                className="bg-blue-600 h-1.5 rounded-full transition-all duration-300"
                                style={{ width: `${status.progress}%` }}
                              ></div>
                            </div>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Fixed Footer with Add Selected Button */}
        {selectedBooks.size > 0 && (
          <div className="shrink-0 p-6 bg-gray-50 dark:bg-slate-900 border-t border-gray-200 dark:border-slate-700 z-20">
            <div className="flex flex-col items-center gap-3 mx-auto max-w-sm">
              <Button
                onClick={handleBatchDownload}
                disabled={isBatchProcessing}
                variant="primary"
                size="sm"
                className="flex items-center gap-2 px-4 py-2 shadow-lg rounded-lg"
              >
                {isBatchProcessing ? (
                  <>
                    <Loading size="sm" />
                    Processing ({selectedBooks.size})
                  </>
                ) : (
                  <>
                    Add Selected ({selectedBooks.size})
                  </>
                )}
              </Button>

              {isBatchProcessing && (
                <div className="w-full">
                  <div className="flex justify-between text-xs mb-1 text-gray-600 dark:text-gray-400">
                    <span>Overall Progress</span>
                    <span>{totalProgress}%</span>
                  </div>
                  <div className="w-full bg-gray-200 dark:bg-gray-700 rounded-full h-2">
                    <div
                      className="bg-blue-600 h-2 rounded-full transition-all duration-300 ease-out"
                      style={{ width: `${totalProgress}%` }}
                    ></div>
                  </div>
                </div>
              )}

              <p className="text-gray-500 dark:text-gray-400 text-xs text-center">
                {isBatchProcessing && "Please wait, it can take up to 1 minute ❤️"}
              </p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
