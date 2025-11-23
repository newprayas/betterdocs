'use client';

import React, { useState, useEffect, useMemo } from 'react';
import { libraryService } from '@/services/libraryService';
import type { LibraryItem } from '@/types/library';
import { documentProcessor } from '@/services/rag';
import { useDocumentStore } from '@/store';
import { Button, Card, Loading } from '@/components/ui';

interface DocumentLibraryProps {
  sessionId: string;
  onClose: () => void;
}

interface ProcessingStatus {
  [bookId: string]: {
    status: 'pending' | 'processing' | 'completed' | 'error';
    progress?: number;
    error?: string;
  };
}

export const DocumentLibrary: React.FC<DocumentLibraryProps> = ({ sessionId, onClose }) => {
  const [books, setBooks] = useState<LibraryItem[]>([]);
  const [isLoadingList, setIsLoadingList] = useState(true);
  const [selectedCategory, setSelectedCategory] = useState<string>('All Sources');
  const [selectedBooks, setSelectedBooks] = useState<Set<string>>(new Set());
  const [selectAll, setSelectAll] = useState(false);
  const [isBatchProcessing, setIsBatchProcessing] = useState(false);
  const [processingStatus, setProcessingStatus] = useState<ProcessingStatus>({});
  const [error, setError] = useState<string | null>(null);

  const { userId, loadDocuments } = useDocumentStore();

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

  // Handle individual book selection
  const handleBookSelection = (bookId: string) => {
    const newSelectedBooks = new Set(selectedBooks);
    if (newSelectedBooks.has(bookId)) {
      newSelectedBooks.delete(bookId);
    } else {
      newSelectedBooks.add(bookId);
    }
    setSelectedBooks(newSelectedBooks);

    // Update select all checkbox state
    setSelectAll(newSelectedBooks.size === filteredBooks.length && filteredBooks.length > 0);
  };

  // Handle select all checkbox
  const handleSelectAll = () => {
    if (selectAll) {
      setSelectedBooks(new Set());
    } else {
      setSelectedBooks(new Set(filteredBooks.map(book => book.id)));
    }
    setSelectAll(!selectAll);
  };

  // Process a single book
  const processSingleBook = async (book: LibraryItem): Promise<void> => {
    if (!userId) throw new Error("User ID is required");

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
        }
      );

      console.log('🔍 PROCESSING DEBUG: Document processing completed for book:', {
        bookName: book.name,
        operationId,
        finalStatus: 'completed'
      });

      setProcessingStatus(prev => ({
        ...prev,
        [book.id]: { status: 'completed', progress: 100 }
      }));
    } catch (err) {
      console.error('🔍 PROCESSING ERROR DEBUG: Error processing book:', {
        bookName: book.name,
        error: err instanceof Error ? err.message : 'Unknown error',
        stack: err instanceof Error ? err.stack : 'No stack trace',
        timestamp: new Date().toISOString()
      });

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
    const selectedBooksList = filteredBooks.filter(book => selectedBooks.has(book.id));

    try {
      // Process all selected books
      await Promise.all(selectedBooksList.map(book => processSingleBook(book)));

      // Wait a moment for the final status updates
      await new Promise(resolve => setTimeout(resolve, 1000));

      // Refresh UI to get the actual document status from database
      await loadDocuments(sessionId);

      // CRITICAL FIX: Get accurate success/failure counts by checking actual document status
      // rather than relying on processingStatus which might have race conditions
      const { documents } = useDocumentStore.getState();

      console.log('🔍 SUCCESS COUNT DEBUG: Documents in store after processing:', documents.length);
      console.log('🔍 SUCCESS COUNT DEBUG: Processing status:', processingStatus);

      // Enhanced logging for debugging document matching
      console.log('🔍 DOCUMENT STORE DEBUG: All documents in store:', documents.map(doc => ({
        id: doc.id,
        filename: doc.filename,
        title: doc.title,
        status: doc.status,
        sessionId: doc.sessionId,
        enabled: doc.enabled
      })));

      console.log('🔍 SELECTED BOOKS DEBUG: All selected books:', selectedBooksList.map(book => ({
        id: book.id,
        name: book.name,
        url: book.url
      })));

      // Count successful and failed downloads by checking actual document status
      let successful = 0;
      let failed = 0;

      for (const book of selectedBooksList) {
        console.log('🔍 MATCHING DEBUG: Attempting to match book:', {
          bookId: book.id,
          bookName: book.name,
          bookUrl: book.url
        });

        // Enhanced matching logic with multiple fallback strategies
        let document = documents.find(doc =>
          doc.filename === book.name ||
          doc.title === book.name ||
          doc.id.includes(book.id)
        );

        // If not found with exact matches, try fuzzy matching
        if (!document) {
          console.log('🔍 MATCHING DEBUG: Exact match failed, trying fuzzy matching');

          // Try matching by extracting filename from URL
          const urlFilename = book.url.split('/').pop()?.split('.')[0];
          if (urlFilename) {
            document = documents.find(doc =>
              doc.filename.includes(urlFilename) ||
              doc.title?.includes(urlFilename) ||
              doc.id.includes(urlFilename)
            );
            console.log('🔍 MATCHING DEBUG: URL filename matching:', {
              urlFilename,
              found: !!document
            });
          }

          // Try matching by book ID parts (in case of UUID regeneration)
          if (!document && book.id.includes('_')) {
            const bookIdParts = book.id.split('_');
            for (const part of bookIdParts) {
              if (part.length > 3) { // Only use meaningful parts
                document = documents.find(doc =>
                  doc.id.includes(part) ||
                  doc.filename.includes(part) ||
                  doc.title?.includes(part)
                );
                if (document) {
                  console.log('🔍 MATCHING DEBUG: Found by ID part:', part);
                  break;
                }
              }
            }
          }

          // Try matching by normalized name (lowercase, no special chars)
          if (!document) {
            const normalizedName = book.name.toLowerCase().replace(/[^a-z0-9]/g, '');
            document = documents.find(doc => {
              const normalizedFilename = doc.filename.toLowerCase().replace(/[^a-z0-9]/g, '');
              const normalizedTitle = doc.title?.toLowerCase().replace(/[^a-z0-9]/g, '') || '';
              const normalizedId = doc.id.toLowerCase().replace(/[^a-z0-9]/g, '');
              return normalizedFilename.includes(normalizedName) ||
                normalizedTitle.includes(normalizedName) ||
                normalizedId.includes(normalizedName);
            });
            console.log('🔍 MATCHING DEBUG: Normalized name matching:', {
              normalizedName,
              found: !!document
            });
          }
        }

        console.log('🔍 DOCUMENT STATUS DEBUG:', {
          bookId: book.id,
          bookName: book.name,
          documentFound: !!document,
          documentId: document?.id,
          documentFilename: document?.filename,
          documentTitle: document?.title,
          documentStatus: document?.status,
          processingStatus: processingStatus[book.id]?.status
        });

        // Use actual document status if available, fallback to processing status
        const actualStatus = document?.status || processingStatus[book.id]?.status;

        if (actualStatus === 'completed') {
          successful++;
          console.log('🔍 COUNT DEBUG: Counted as successful - Book:', book.name, 'Document:', document?.filename);
        } else if (actualStatus === 'failed' || actualStatus === 'error') {
          failed++;
          console.log('🔍 COUNT DEBUG: Counted as failed - Book:', book.name, 'Status:', actualStatus);
        } else {
          // If status is unclear, check processing status as fallback
          if (processingStatus[book.id]?.status === 'completed') {
            successful++;
            console.log('🔍 COUNT DEBUG: Counted as successful (processing status) - Book:', book.name);
          } else if (processingStatus[book.id]?.status === 'error') {
            failed++;
            console.log('🔍 COUNT DEBUG: Counted as failed (processing status) - Book:', book.name);
          } else {
            // Unknown status - count as failed for safety
            failed++;
            console.log('🔍 COUNT DEBUG: Counted as failed (unknown status) - Book:', book.name, 'Actual status:', actualStatus);
          }
        }
      }

      console.log('🔍 FINAL COUNT DEBUG:', { successful, failed, total: selectedBooksList.length });

      if (failed === 0) {
        alert(`Successfully added ${successful} document(s) to your library!`);
      } else {
        alert(`Added ${successful} document(s). ${failed} document(s) failed to process.`);
      }

      // Clear selections and close modal
      setSelectedBooks(new Set());
      setSelectAll(false);
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
      <Card className="w-full max-w-5xl h-[85vh] flex flex-col bg-gray-50 dark:bg-slate-900 shadow-2xl">

        {/* Header */}
        <div className="p-6 border-b border-gray-200 dark:border-slate-700 bg-white dark:bg-slate-900 rounded-t-lg">
          <div className="flex justify-between items-center mb-4">
            <div>
              <h2 className="text-2xl font-bold text-gray-900 dark:text-white">Medical Library</h2>
              <p className="text-sm text-gray-500 dark:text-gray-400">
                Verified medical resources, ready for instant use.
              </p>
            </div>
            <Button variant="primary" onClick={onClose} disabled={isBatchProcessing}>
              <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </Button>
          </div>

          {/* Controls Row */}
          <div className="flex flex-col sm:flex-row gap-4 items-start sm:items-center justify-between">
            {/* Category Filter Pills */}
            <div className="flex-1 min-w-0 overflow-x-auto no-scrollbar mask-linear-fade">
              <div className="flex items-center gap-2 pb-1">
                {categories.map(category => {
                  const isSelected = selectedCategory === category;
                  return (
                    <button
                      key={category}
                      onClick={() => setSelectedCategory(category)}
                      className={`
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
                  checked={selectAll}
                  onChange={handleSelectAll}
                  disabled={isBatchProcessing}
                  className="w-5 h-5 text-blue-600 bg-gray-100 border-gray-300 rounded focus:ring-blue-500 focus:ring-2"
                />
                <span className="text-sm font-medium text-gray-700 dark:text-gray-300">
                  Select All ({filteredBooks.length})
                </span>
              </label>

              {selectedBooks.size > 0 && (
                <div>
                  <Button
                    onClick={handleBatchDownload}
                    disabled={isBatchProcessing}
                    variant="primary"
                    size="sm"
                    className="flex items-center gap-2 px-2 py-0.5"
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
                  <p className="text-white text-sm mt-2">
                    {isBatchProcessing && "Please wait, it can take up to 1 minute ❤️"}
                  </p>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Content Area */}
        <div className="flex-1 overflow-y-auto p-6">
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
                    <div className="absolute top-5 left-5 z-10">
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
                        {book.description}
                      </p>
                    </div>

                    {/* Progress Status */}
                    {status && (
                      <div className="mb-4 ml-8">
                        {isProcessing && (
                          <div className="space-y-2">
                            <div className="flex justify-between text-xs">
                              <span className="text-gray-500">Processing...</span>
                              <span className="text-gray-500">{status.progress}%</span>
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
                        {book.size} • v{book.version}
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </Card>
    </div>
  );
};