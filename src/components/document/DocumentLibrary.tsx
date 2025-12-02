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

  // Check for duplicate books directly in IndexedDB
  const checkForDuplicate = async (book: LibraryItem): Promise<boolean> => {
    console.log(`🔍 DUPLICATE CHECK: Starting duplicate check for book: "${book.name}"`);
    console.log(`🔍 DUPLICATE CHECK: Timestamp: ${new Date().toISOString()}`);
    console.log(`🔍 DUPLICATE CHECK: Book details:`, {
      id: book.id,
      name: book.name,
      filename: book.filename,
      description: book.description,
      category: book.category
    });
    
    try {
      // Check if userId is available before proceeding
      if (!userId) {
        console.log('🔍 DUPLICATE CHECK: No userId available, cannot check for duplicates');
        return false;
      }
      
      // Get documents directly from IndexedDB to avoid timing issues with document store
      const { documentService } = await getIndexedDBServices();
      const documents = await documentService.getDocumentsBySession(sessionId, userId);
      
      console.log(`🔍 DUPLICATE CHECK: Comparing against ${documents.length} existing documents from IndexedDB`);
      console.log(`🔍 DUPLICATE CHECK: IndexedDB query performed at: ${new Date().toISOString()}`);
      
      // Log all existing documents for detailed comparison
      console.log(`🔍 DUPLICATE CHECK: Existing documents in IndexedDB:`, documents.map(doc => ({
        id: doc.id,
        filename: doc.filename,
        title: doc.title,
        sessionId: doc.sessionId,
        status: doc.status,
        enabled: doc.enabled,
        createdAt: doc.createdAt
      })));
      
      // PRIMARY CHECK: Compare book.filename with document.filename (this is the most reliable match)
      console.log(`🔍 DUPLICATE CHECK: Checking book.filename vs doc.filename (PRIMARY CHECK)`);
      const bookFilenameMatch = documents.some(doc => {
        const matches = doc.filename === book.filename;
        console.log(`🔍 DUPLICATE CHECK: Comparing book.filename "${book.filename}" with doc.filename "${doc.filename}" = ${matches}`);
        return matches;
      });
      if (bookFilenameMatch) {
        console.log(`🔍 DUPLICATE FOUND: Book filename match for "${book.filename}"`);
        alert(`"${book.name}" is already in your library. Skipping duplicate.`);
        return true;
      }
      
      // SECONDARY CHECK: Compare book.filename with document.title (in case title was set to filename)
      console.log(`🔍 DUPLICATE CHECK: Checking book.filename vs doc.title (SECONDARY CHECK)`);
      const bookFilenameTitleMatch = documents.some(doc => {
        const matches = doc.title === book.filename;
        console.log(`🔍 DUPLICATE CHECK: Comparing book.filename "${book.filename}" with doc.title "${doc.title}" = ${matches}`);
        return matches;
      });
      if (bookFilenameTitleMatch) {
        console.log(`🔍 DUPLICATE FOUND: Book filename vs title match for "${book.filename}"`);
        alert(`"${book.name}" is already in your library. Skipping duplicate.`);
        return true;
      }
      
      // TERTIARY CHECK: Compare book.name with document.filename (for backwards compatibility)
      console.log(`🔍 DUPLICATE CHECK: Checking book.name vs doc.filename (TERTIARY CHECK)`);
      const nameToFilenameMatch = documents.some(doc => {
        const matches = doc.filename === book.name;
        console.log(`🔍 DUPLICATE CHECK: Comparing book.name "${book.name}" with doc.filename "${doc.filename}" = ${matches}`);
        return matches;
      });
      if (nameToFilenameMatch) {
        console.log(`🔍 DUPLICATE FOUND: Book name to filename match for "${book.name}"`);
        alert(`"${book.name}" is already in your library. Skipping duplicate.`);
        return true;
      }
      
      // QUATERNARY CHECK: Compare book.name with document.title (for backwards compatibility)
      console.log(`🔍 DUPLICATE CHECK: Checking book.name vs doc.title (QUATERNARY CHECK)`);
      const nameToTitleMatch = documents.some(doc => {
        const matches = doc.title === book.name;
        console.log(`🔍 DUPLICATE CHECK: Comparing book.name "${book.name}" with doc.title "${doc.title}" = ${matches}`);
        return matches;
      });
      if (nameToTitleMatch) {
        console.log(`🔍 DUPLICATE FOUND: Book name to title match for "${book.name}"`);
        alert(`"${book.name}" is already in your library. Skipping duplicate.`);
        return true;
      }
      
      // CASE-INSENSITIVE CHECKS: As fallbacks
      console.log(`🔍 DUPLICATE CHECK: Checking case-insensitive book.filename vs doc.filename`);
      const caseInsensitiveFilenameMatch = documents.some(doc => {
        const matches = doc.filename.toLowerCase() === book.filename.toLowerCase();
        console.log(`🔍 DUPLICATE CHECK: Comparing "${book.filename.toLowerCase()}" with "${doc.filename.toLowerCase()}" = ${matches}`);
        return matches;
      });
      if (caseInsensitiveFilenameMatch) {
        console.log(`🔍 DUPLICATE FOUND: Case-insensitive filename match for "${book.filename}"`);
        alert(`"${book.name}" is already in your library (case-insensitive match). Skipping duplicate.`);
        return true;
      }
      
      console.log(`🔍 DUPLICATE CHECK: Checking case-insensitive book.name vs doc.filename`);
      const caseInsensitiveNameMatch = documents.some(doc => {
        const matches = doc.filename.toLowerCase() === book.name.toLowerCase();
        console.log(`🔍 DUPLICATE CHECK: Comparing "${book.name.toLowerCase()}" with "${doc.filename.toLowerCase()}" = ${matches}`);
        return matches;
      });
      if (caseInsensitiveNameMatch) {
        console.log(`🔍 DUPLICATE FOUND: Case-insensitive name match for "${book.name}"`);
        alert(`"${book.name}" is already in your library (case-insensitive match). Skipping duplicate.`);
        return true;
      }
      
      console.log(`🔍 NO DUPLICATE: No duplicate found for "${book.name}" (filename: ${book.filename})`);
      return false; // No duplicate found
    } catch (error) {
      console.error('🔍 DUPLICATE CHECK ERROR: Error checking for duplicates in IndexedDB:', error);
      // If we can't check IndexedDB, fall back to document store as a last resort
      console.log('🔍 DUPLICATE CHECK: Falling back to document store due to IndexedDB error');
      const { documents } = useDocumentStore.getState();
      console.log(`🔍 DUPLICATE CHECK: Comparing against ${documents.length} existing documents from document store (fallback)`);
      
      const bookFilenameMatch = documents.some(doc => doc.filename === book.filename);
      if (bookFilenameMatch) {
        console.log(`🔍 DUPLICATE FOUND: Book filename match for "${book.filename}" (fallback check)`);
        alert(`"${book.name}" is already in your library. Skipping duplicate.`);
        return true;
      }
      
      console.log(`🔍 NO DUPLICATE: No duplicate found for "${book.name}" (fallback check)`);
      return false;
    }
  };

  // Process a single book
  const processSingleBook = async (book: LibraryItem): Promise<void> => {
    console.log(`🔍 PROCESSING: Starting to process book "${book.name}"`);
    console.log(`🔍 DUPLICATE CHECK: Performing duplicate check for "${book.name}"`);
    
    // Check for duplicates before processing (now async)
    const isDuplicate = await checkForDuplicate(book);
    if (isDuplicate) {
      console.log(`🔍 PROCESSING: Book "${book.name}" skipped due to being a duplicate`);
      // Mark as skipped to show in UI
      setProcessingStatus(prev => ({
        ...prev,
        [book.id]: {
          status: 'error',
          error: 'Duplicate document - already in library'
        }
      }));
      return;
    }
    
    console.log(`🔍 PROCESSING: Continuing with normal processing for "${book.name}" (no duplicate found)`);
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
    const selectedBooksList = filteredBooks.filter(book => selectedBooks.has(book.id));

    try {
      // Process all selected books sequentially to avoid race conditions in duplicate checking
      for (const book of selectedBooksList) {
        await processSingleBook(book);
      }

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

      alert("Books were added, you can start chatting!");

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
      <Card className="w-full max-w-5xl h-[85vh] flex flex-col bg-gray-50 dark:bg-slate-900 shadow-2xl relative">

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
                        {book.description}
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
                        {book.size} • v{book.version}
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