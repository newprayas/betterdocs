import React from 'react';
import { Citation } from '../../types';
import { Button } from '../ui/Button';

interface CitationPanelProps {
  citations: Citation[];
  maxVisible?: number;
  className?: string;
}

// Extended citation type with index for Vancouver style references
type ExtendedCitation = Citation & { citationIndex: number };

// Group citations by page number
const groupCitationsByPage = (citations: Citation[]): Map<string, ExtendedCitation[]> => {
  const grouped = new Map<string, ExtendedCitation[]>();
  
  citations.forEach((citation, index) => {
    // Use page number as key, fallback to index if no page
    const pageKey = citation.page ? `Page ${citation.page}` : `Source ${index + 1}`;
    
    if (!grouped.has(pageKey)) {
      grouped.set(pageKey, []);
    }
    
    // Add citation index for Vancouver style reference
    grouped.get(pageKey)!.push({
      ...citation,
      // Store the original index for Vancouver style numbering
      citationIndex: index + 1
    });
  });
  
  return grouped;
};

export const CitationPanel: React.FC<CitationPanelProps> = ({
  citations,
  maxVisible,
  className,
}) => {
  const [isExpanded, setIsExpanded] = React.useState(false);
  
  // Group citations by page
  const groupedCitations = groupCitationsByPage(citations);
  const pageGroups = Array.from(groupedCitations.entries());
  
  // Always show only one reference initially, regardless of maxVisible prop
  const visibleGroups = isExpanded
    ? pageGroups
    : pageGroups.slice(0, 1);

  if (citations.length === 0) {
    return null;
  }

  return (
    <div className={`space-y-3 ${className}`}>
      <div className="flex items-center gap-2 text-xs text-gray-600 dark:text-gray-400">
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
            d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
          />
        </svg>
        <span>Vancouver Style References ({pageGroups.length} page{pageGroups.length !== 1 ? 's' : ''})</span>
      </div>

      <div className="space-y-3">
        {visibleGroups.map(([pageTitle, pageCitations], index) => (
          <React.Fragment key={pageTitle}>
            <PageCitationGroup
              pageTitle={pageTitle}
              citations={pageCitations}
            />
            {/* Show "View all references" button after the first reference */}
            {index === 0 && pageGroups.length > 1 && !isExpanded && (
              <div className="flex justify-center">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setIsExpanded(!isExpanded)}
                  className="h-auto p-0 text-xs font-medium text-blue-600 dark:text-blue-400 hover:underline"
                >
                  View all references
                </Button>
              </div>
            )}
          </React.Fragment>
        ))}
        {/* Show "Show less" button when expanded */}
        {isExpanded && pageGroups.length > 1 && (
          <div className="flex justify-center">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setIsExpanded(!isExpanded)}
              className="h-auto p-0 text-xs font-medium text-blue-600 dark:text-blue-400 hover:underline"
            >
              Show less
            </Button>
          </div>
        )}
      </div>
    </div>
  );
};

// Component to display a group of citations from the same page
interface PageCitationGroupProps {
  pageTitle: string;
  citations: ExtendedCitation[];
}

const PageCitationGroup: React.FC<PageCitationGroupProps> = ({ pageTitle, citations }) => {
  const [isExpanded, setIsExpanded] = React.useState(false);
  
  // Combine all content from citations on this page
  const combinedContent = citations
    .map(c => c.excerpt || '')
    .filter(content => content.trim() !== '')
    .join('\n\n---\n\n');
  
  // Get all citation indices for Vancouver style references
  const citationIndices = citations.map(c => c.citationIndex);
  const citationRefs = citationIndices.map(index => `[${index}]`).join(', ');
  
  // Get document name from first citation
  const documentName = citations[0]?.document || 'Unknown Document';
  
  const previewLength = 300;
  const needsExpansion = combinedContent.length > previewLength;

  return (
    <div className="page-citation-group">
      {/* Page Header */}
      <div className="page-citation-header">
        <div className="flex items-center gap-3">
          <span className="text-sm font-bold text-blue-600 dark:text-blue-400">
            {citationRefs}
          </span>
          <h3 className="page-citation-title text-xs">
            {pageTitle}
          </h3>
          <span className="text-xs text-gray-600 dark:text-gray-400">
            {documentName}
          </span>
        </div>
        
        {citations.length > 1 && (
          <span className="text-xs bg-purple-100 dark:bg-purple-900 text-purple-700 dark:text-purple-300 px-2 py-1 rounded-full">
            {citations.length} citation{citations.length > 1 ? 's' : ''}
          </span>
        )}
      </div>
      
      {/* Combined Content */}
      {combinedContent && (
        <div className="page-citation-content">
          <div className={`
            ${isExpanded ? '' : 'line-clamp-4'}
            transition-all duration-200
          `}>
            {isExpanded ? combinedContent : combinedContent.substring(0, previewLength) + (needsExpansion ? '...' : '')}
          </div>
          
          {needsExpansion && (
            <button
              onClick={() => setIsExpanded(!isExpanded)}
              className="text-xs text-blue-500 hover:text-blue-600 dark:text-blue-400 dark:hover:text-blue-300 mt-2 font-medium"
            >
              {isExpanded ? 'Show less' : 'Show full text'}
            </button>
          )}
        </div>
      )}
    </div>
  );
};