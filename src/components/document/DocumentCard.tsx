import React, { useState } from 'react';
import { Document } from '../../types';
import { Button } from '../ui/Button';
import { Card } from '../ui/Card';
import { Switch } from '../ui/Switch';
import { useConfirmDialog } from '../common/ConfirmDialog';
import { useTestModal } from '../ui/TestModal';
import { useDocumentStore } from '../../store';
import { formatFileSize } from '../../utils';
import clsx from 'clsx';

interface DocumentCardProps {
  document: Document;
  onToggle?: (document: Document) => void;
  className?: string;
}

export const DocumentCard: React.FC<DocumentCardProps> = ({
  document,
  onToggle,
  className,
}) => {
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const { deleteDocument, toggleDocumentEnabled } = useDocumentStore();
  const { confirm, ConfirmDialog } = useConfirmDialog();
  const { openModal: openTestModal, closeModal: closeTestModal, TestModal, isOpen: isTestModalOpen } = useTestModal();

  const handleToggle = async (enabled: boolean) => {
    try {
      await toggleDocumentEnabled(document.id);
      if (onToggle) {
        onToggle({ ...document, enabled });
      }
    } catch (error) {
      console.error('Failed to toggle document:', error);
    }
  };

  const handleDelete = async () => {
    const startTime = Date.now();
    console.log('🗑️ DocumentCard: Starting delete process for document:', {
      id: document.id,
      filename: document.filename,
      status: document.status,
      enabled: document.enabled,
      timestamp: new Date().toISOString()
    });
    
    setDeleteError(null);
    
    console.log('🔍 DocumentCard: About to open delete confirmation dialog', {
      timestamp: new Date().toISOString()
    });
    
    try {
      console.log('🔍 DocumentCard: Calling confirm with options', {
        title: 'Delete Document',
        message: `Are you sure you want to delete "${document.filename}"? This action cannot be undone.`,
        timestamp: new Date().toISOString()
      });
      
      const confirmStartTime = Date.now();
      const confirmResult = await confirm({
        title: 'Delete Document',
        message: `Are you sure you want to delete "${document.filename}"? This action cannot be undone.`,
        onConfirm: async () => {
          console.log('✅ DocumentCard: User confirmed deletion, starting delete operation', {
            documentId: document.id,
            timestamp: new Date().toISOString()
          });
          
          try {
            const deleteStartTime = Date.now();
            console.log('🗑️ DocumentCard: Calling deleteDocument with ID:', {
              id: document.id,
              timestamp: new Date().toISOString()
            });
            
            const result = await deleteDocument(document.id);
            const deleteEndTime = Date.now();
            
            console.log('✅ DocumentCard: deleteDocument completed', {
              result,
              duration: deleteEndTime - deleteStartTime,
              documentId: document.id,
              filename: document.filename,
              timestamp: new Date().toISOString()
            });
            
            // Return true to indicate successful deletion
            return true;
          } catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'Failed to delete document';
            console.error('❌ DocumentCard: Failed to delete document:', {
              id: document.id,
              filename: document.filename,
              error: error instanceof Error ? error.message : error,
              stack: error instanceof Error ? error.stack : undefined,
              timestamp: new Date().toISOString()
            });
            
            setDeleteError(errorMessage);
            console.error('Failed to delete document:', error);
            
            // Return false to indicate failed deletion
            return false;
            // Don't re-throw the error to allow the dialog to close properly
            // The error state is already set and will be displayed to the user
          }
        },
        confirmText: 'Delete',
        cancelText: 'Cancel',
        variant: 'danger',
      });
      
      const confirmEndTime = Date.now();
      const totalDuration = confirmEndTime - startTime;
      
      console.log('✅ DocumentCard: Confirmation dialog completed', {
        confirmResult,
        confirmDuration: confirmEndTime - confirmStartTime,
        totalDuration,
        documentId: document.id,
        timestamp: new Date().toISOString()
      });
      
      // Check if the user confirmed and the deletion was successful
      if (confirmResult) {
        console.log('✅ DocumentCard: User confirmed and deletion was successful', {
          documentId: document.id,
          filename: document.filename,
          totalDuration,
          timestamp: new Date().toISOString()
        });
        // Optional: You could add success notification here
      } else {
        console.log('🔍 DocumentCard: User cancelled or deletion failed', {
          documentId: document.id,
          filename: document.filename,
          totalDuration,
          timestamp: new Date().toISOString()
        });
        // Optional: You could handle the cancellation/failure case here
      }
    } catch (error) {
      const totalDuration = Date.now() - startTime;
      console.error('❌ DocumentCard: Error during confirmation dialog:', {
        error: error instanceof Error ? error.message : error,
        stack: error instanceof Error ? error.stack : undefined,
        documentId: document.id,
        filename: document.filename,
        totalDuration,
        timestamp: new Date().toISOString()
      });
      
      setDeleteError(error instanceof Error ? error.message : 'Failed to show confirmation dialog');
    }
  };

  const handleTestModal = () => {
    console.log('🔍 DocumentCard: Opening test modal for debugging');
    openTestModal();
  };

  const getStatusIcon = () => {
    switch (document.status) {
      case 'processing':
        return (
          <svg className="w-4 h-4 text-blue-500 animate-spin" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
          </svg>
        );
      case 'failed':
        return (
          <svg className="w-4 h-4 text-red-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
        );
      default:
        return null; // No icon for completed/pending documents
    }
  };

  const getStatusText = () => {
    switch (document.status) {
      case 'completed':
        return 'Ready';
      case 'processing':
        return 'Processing...';
      case 'failed':
        return 'Failed';
      default:
        return 'Pending';
    }
  };

  const getStatusColor = () => {
    switch (document.status) {
      case 'completed':
        return 'text-green-600 dark:text-green-400';
      case 'processing':
        return 'text-blue-600 dark:text-blue-400';
      case 'failed':
        return 'text-red-600 dark:text-red-400';
      default:
        return 'text-gray-600 dark:text-gray-400';
    }
  };

  return (
    <>
      <Card
        className={clsx(
          'transition-all duration-200 hover:shadow-md',
          !document.enabled && 'opacity-60',
          className
        )}
      >
        <div className="p-3 sm:p-4">
          <div className="flex items-start justify-between">
            {/* Document Info */}
            <div className="flex-1 min-w-0 pr-2 sm:pr-3">
              <div className="flex items-center gap-2 mb-2">
                <h3 className="font-medium text-sm sm:text-base text-gray-900 dark:text-white break-words">
                  {document.filename}
                </h3>
                {getStatusIcon()}
              </div>
              
              <div className="flex items-center gap-2 sm:gap-4 text-xs sm:text-sm text-gray-500 dark:text-gray-400">
                <span>{formatFileSize(document.fileSize)}</span>
                {document.pageCount && (
                  <span>{document.pageCount} pages</span>
                )}
              </div>
              
              <div className="flex items-center gap-2 mt-1 text-xs sm:text-sm text-gray-500 dark:text-gray-400">
                <span className={getStatusColor()}>
                  {getStatusText()}
                </span>
              </div>
              
              {document.ingestError && (
                <div className="mt-2 p-2 bg-red-50 dark:bg-red-900 border border-red-200 dark:border-red-800 rounded text-xs text-red-600 dark:text-red-400">
                  {document.ingestError}
                </div>
              )}
              
              {deleteError && (
                <div className="mt-2 p-2 bg-red-50 dark:bg-red-900 border border-red-200 dark:border-red-800 rounded text-xs text-red-600 dark:text-red-400">
                  Error: {deleteError}
                </div>
              )}
            </div>

            {/* Controls */}
            <div className="flex items-center gap-1 sm:gap-2 flex-shrink-0">
              {/* Enable/Disable Switch */}
              <Switch
                checked={document.enabled}
                onCheckedChange={handleToggle}
                size="sm"
              />
              
              {/* Delete Button */}
              <Button
                variant="ghost"
                size="sm"
                onClick={handleDelete}
                className="p-1 text-red-600 hover:text-red-700 hover:bg-red-50 dark:hover:bg-red-900"
              >
                <svg
                  className="w-3 h-3 sm:w-4 sm:h-4"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
                  />
                </svg>
              </Button>
            </div>
          </div>
        </div>
      </Card>

      {(() => {
        console.log('🔍 DocumentCard: About to render ConfirmDialog', {
          hasConfirmDialog: !!ConfirmDialog,
          dialogType: typeof ConfirmDialog
        });
        return <ConfirmDialog />;
      })()}
      
      {/* Test Modal for debugging */}
      {(() => {
        console.log('🔍 DocumentCard: About to render TestModal', {
          hasTestModal: !!TestModal,
          isTestModalOpen
        });
        return <TestModal />;
      })()}
    </>
  );
};

// Compact version for sidebar
export const DocumentCardCompact: React.FC<{
  document: Document;
  onToggle?: (document: Document) => void;
  className?: string;
}> = ({ document, onToggle, className }) => {
  const { toggleDocumentEnabled } = useDocumentStore();

  const handleToggle = async (enabled: boolean) => {
    try {
      await toggleDocumentEnabled(document.id);
      if (onToggle) {
        onToggle({ ...document, enabled });
      }
    } catch (error) {
      console.error('Failed to toggle document:', error);
    }
  };

  const getStatusColor = () => {
    switch (document.status) {
      case 'completed':
        return 'text-green-500';
      case 'processing':
        return 'text-blue-500';
      case 'failed':
        return 'text-red-500';
      default:
        return 'text-gray-500';
    }
  };

  return (
    <div
      className={clsx(
        'p-2 rounded-lg border border-gray-200 dark:border-gray-700',
        'hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors duration-200',
        !document.enabled && 'opacity-60',
        className
      )}
    >
      <div className="flex items-center justify-between">
        <div className="flex-1 min-w-0 pr-2">
          <div className="flex items-center gap-2">
            <div className={clsx('w-2 h-2 rounded-full', getStatusColor())} />
            <h4 className="font-medium text-xs sm:text-sm text-gray-900 dark:text-white break-words">
              {document.filename}
            </h4>
          </div>
          <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
            {formatFileSize(document.fileSize)}
          </p>
        </div>
        
        <Switch
          checked={document.enabled}
          onCheckedChange={handleToggle}
          size="sm"
        />
      </div>
    </div>
  );
};