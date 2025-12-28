import React, { useState, useMemo } from 'react';
import { Document } from '../../types';
import { DocumentCard, DocumentCardCompact } from './DocumentCard';
import { EmptyState } from '../common/EmptyState';
import { Input } from '../ui/Input';
import { Button } from '../ui/Button';
import clsx from 'clsx';

interface DocumentListProps {
  documents: Document[];
  loading?: boolean;
  onDocumentToggle?: (document: Document) => void;
  variant?: 'grid' | 'list' | 'compact';
  showSearch?: boolean;
  className?: string;
}

export const DocumentList: React.FC<DocumentListProps> = ({
  documents,
  loading = false,
  onDocumentToggle,
  variant = 'grid',
  showSearch = true,
  className,
}) => {
  const [searchQuery, setSearchQuery] = useState('');

  // Filter and sort documents
  const filteredDocuments = useMemo(() => {
    let result = documents;

    // Filter by search query
    if (searchQuery) {
      result = documents.filter(doc =>
        doc.filename.toLowerCase().includes(searchQuery.toLowerCase()) ||
        doc.title?.toLowerCase().includes(searchQuery.toLowerCase())
      );
    }

    // Sort: Enabled first, then Alphabetical
    return [...result].sort((a, b) => {
      // 1. Enabled status (Active first)
      if (a.enabled && !b.enabled) return -1;
      if (!a.enabled && b.enabled) return 1;

      // 2. Alphabetical by title or filename
      const titleA = (a.title || a.filename).toLowerCase();
      const titleB = (b.title || b.filename).toLowerCase();
      return titleA.localeCompare(titleB);
    });
  }, [documents, searchQuery]);

  if (loading) {
    return (
      <div className={clsx('space-y-4', className)}>
        {Array.from({ length: 3 }).map((_, index) => (
          <div key={index} className="animate-pulse">
            <div className="bg-gray-200 dark:bg-gray-700 rounded-lg h-24" />
          </div>
        ))}
      </div>
    );
  }

  if (documents.length === 0) {
    return (
      <EmptyState
        title="No documents uploaded"
        description="Upload documents to start asking questions about their content"
        icon={
          <svg
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
            />
          </svg>
        }
        className={className}
      />
    );
  }

  if (filteredDocuments.length === 0) {
    return (
      <EmptyState
        title="No documents found"
        description="Try adjusting your search or filter criteria"
        icon={
          <svg
            className="w-12 h-12 text-gray-400"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
            />
          </svg>
        }
        className={className}
      />
    );
  }

  // Compact variant for sidebar
  if (variant === 'compact') {
    return (
      <div className={clsx('space-y-1 sm:space-y-2', className)}>
        {filteredDocuments.map((document) => (
          <DocumentCardCompact
            key={document.id}
            document={document}
            onToggle={onDocumentToggle}
          />
        ))}
      </div>
    );
  }

  return (
    <div className={clsx('space-y-3 sm:space-y-4', className)}>
      {/* Pro Tip Disclaimer - Only show if more than 5 books are active */}
      {documents.filter(d => d.enabled).length > 5 && (
        <div className="bg-amber-50 dark:bg-amber-900/20 border border-amber-100 dark:border-amber-800 rounded-lg p-3 flex items-start sm:items-center gap-3">
          <div className="text-lg">💡</div>
          <p className="text-sm text-amber-800 dark:text-amber-200">
            Keep only <span className="font-semibold">4-5 most relevant books active</span> to get the best answers!
          </p>
        </div>
      )}

      {/* Search */}
      {showSearch && (
        <div className="w-full">
          <Input
            type="text"
            placeholder="Search documents..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            leftIcon={
              <svg
                className="w-4 h-4"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
                />
              </svg>
            }
          />
        </div>
      )}

      {/* Document Count */}
      <div className="text-xs sm:text-sm text-gray-500 dark:text-gray-400">
        {filteredDocuments.length} document{filteredDocuments.length !== 1 ? 's' : ''}
        {searchQuery && ` found for "${searchQuery}"`}
      </div>

      {/* Document Grid/List */}
      {variant === 'grid' ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 sm:gap-4">
          {filteredDocuments.map((document) => (
            <DocumentCard
              key={document.id}
              document={document}
              onToggle={onDocumentToggle}
            />
          ))}
        </div>
      ) : (
        <div className="space-y-3 sm:space-y-4">
          {filteredDocuments.map((document) => (
            <DocumentCard
              key={document.id}
              document={document}
              onToggle={onDocumentToggle}
            />
          ))}
        </div>
      )}
    </div>
  );
};

// Sidebar version with minimal controls
export const DocumentListSidebar: React.FC<{
  documents: Document[];
  onDocumentToggle?: (document: Document) => void;
  className?: string;
}> = ({ documents, onDocumentToggle, className }) => {
  return (
    <DocumentList
      documents={documents}
      variant="compact"
      showSearch={false}
      onDocumentToggle={onDocumentToggle}
      className={className}
    />
  );
};