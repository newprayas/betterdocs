'use client';

import React, { useState, useEffect, useMemo } from 'react';
import { libraryService } from '@/services/libraryService';
import type { LibraryItem } from '@/types/library';
import { documentProcessor } from '@/services/rag';
import { useDocumentStore } from '@/store';
import { Button, Card, Loading } from '@/components/ui';
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

    const { documentService, embeddingService, annIndexService } = await getIndexedDBServices();

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
      const newEmbeddings = sourceEmbeddings.map(emb => ({
        ...emb,
        id: crypto.randomUUID(),
        documentId: newDocId,
        sessionId: sessionId,
        createdAt: new Date(),
      }));

      await embeddingService.addEmbeddingsDirectly(newEmbeddings);
      console.log(`📋 CACHE COPY: Copied ${newEmbeddings.length} embeddings`);
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
      // Download & Decompress
      const jsonData = await libraryService.downloadAndParseBook(book.url);
      console.log('🔍 DOWNLOAD DEBUG: Successfully downloaded and parsed book:', {
        bookName: book.name,
        chunksCount: jsonData.chunks?.length || 0,
        documentId: jsonData.document_metadata?.id
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
        { librarySourceId: book.id }
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
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4 backdrop-blur-sm">
      <Card className="w-full max-w-5xl h-[85vh] flex flex-col bg-gray-50 dark:bg-slate-900 shadow-2xl relative">

        {/* Absolute Close Button */}
        <button
          onClick={onClose}
          disabled={isBatchProcessing}
          className="absolute top-4 right-4 p-2 text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-slate-800 rounded-full transition-colors z-30 disabled:opacity-50"
          aria-label="Close"
        >
          <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>

        {/* Header */}
        <div className="p-6 border-b border-gray-200 dark:border-slate-700 bg-white dark:bg-slate-900 rounded-t-lg">
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
        <div className="flex-1 overflow-y-auto p-6 pb-24 relative z-10">
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
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
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
                      relative bg-white dark:bg-slate-800 p-5 rounded-xl border
                      ${isProcessing ? 'border-blue-500 ring-1 ring-blue-500' :
                        isCompleted ? 'border-green-500 ring-1 ring-green-500' :
                          hasError ? 'border-red-500 ring-1 ring-red-500' :
                            'border-gray-200 dark:border-slate-700'}
                      ${isSelected ? 'ring-2 ring-blue-500' : ''}
                      shadow-sm hover:shadow-md transition-all duration-200 flex flex-col
                    `}
                  >
                    {/* Selection Checkbox */}
                    <div className="absolute top-5 left-5">
                      <input
                        type="checkbox"
                        checked={isSelected}
                        onChange={() => handleBookSelection(book.id)}
                        disabled={isBatchProcessing}
                        className="w-5 h-5 text-blue-600 bg-gray-100 border-gray-300 rounded focus:ring-blue-500 focus:ring-2 cursor-pointer"
                      />
                    </div>

                    {/* Category Badge */}
                    <div className="absolute top-5 right-5">
                      <span className="px-2 py-1 text-[10px] uppercase tracking-wider font-bold bg-gray-100 dark:bg-slate-700 text-gray-600 dark:text-gray-300 rounded-md">
                        {book.category}
                      </span>
                    </div>

                    {/* Icon & Info */}
                    <div className="mb-4 ml-8">
                      <div className="w-12 h-12 bg-blue-100 dark:bg-blue-900/30 rounded-lg flex items-center justify-center mb-4 text-2xl">
                        📚
                      </div>
                      <h3 className="font-bold text-lg text-gray-900 dark:text-white leading-tight mb-2">
                        {book.name}
                      </h3>
                      <p className="text-sm text-gray-500 dark:text-gray-400 line-clamp-2 min-h-[2.5rem]">
                        File: {book.filename}
                      </p>
                    </div>

                    {/* Progress Status */}
                    {status && (
                      <div className="mb-4 ml-8">
                        {isProcessing && (
                          <div className="space-y-2">
                            <div className="flex justify-between text-xs">
                              <span className="text-white dark:text-white">Processing...</span>
                              <span className="text-white dark:text-white">{status.progress}%</span>
                            </div>
                            <div className="w-full bg-gray-200 rounded-full h-1.5">
                              <div
                                className="bg-blue-600 h-1.5 rounded-full transition-all duration-300"
                                style={{ width: `${status.progress}%` }}
                              ></div>
                            </div>
                          </div>
                        )}
                        {isCompleted && (
                          <div className="flex items-center gap-2 text-green-600 text-sm">
                            <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 20 20">
                              <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
                            </svg>
                            <span>Completed</span>
                          </div>
                        )}
                        {hasError && (
                          <div className="flex items-center gap-2 text-red-600 text-sm">
                            <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 20 20">
                              <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z" clipRule="evenodd" />
                            </svg>
                            <span>Error: {status.error}</span>
                          </div>
                        )}
                      </div>
                    )}

                    {/* Meta Info */}
                    <div className="mt-auto pt-4 border-t border-gray-100 dark:border-slate-700/50">
                      <span className="text-xs font-mono text-gray-400">
                        {book.size}
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Fixed Footer with Add Selected Button */}
        {selectedBooks.size > 0 && (
          <div className="absolute bottom-0 left-0 right-0 p-6 bg-gray-50 dark:bg-slate-900 border-t border-gray-200 dark:border-slate-700 rounded-t-xl z-20">
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
      </Card>
    </div>
  );
};
