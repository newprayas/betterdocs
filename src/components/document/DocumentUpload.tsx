import React, { useState, useRef, useCallback } from 'react';
import { useDocumentStore } from '../../store';
import { Button } from '../ui/Button';
import { Card } from '../ui/Card';
import { isSupportedDocumentType, isFileSizeValid, formatFileSize } from '../../utils';
import clsx from 'clsx';

interface DocumentUploadProps {
  sessionId: string;
  onUploadStart?: (files: File[]) => void;
  onUploadComplete?: (documents: any[]) => void;
  onUploadError?: (error: Error) => void;
  className?: string;
  maxFiles?: number;
  maxSizeMB?: number;
  trigger?: React.ReactNode;
}

export const DocumentUpload: React.FC<DocumentUploadProps> = ({
  sessionId,
  onUploadStart,
  onUploadComplete,
  onUploadError,
  className,
  maxFiles = 10,
  maxSizeMB = 50,
  trigger,
}) => {
  const [isDragging, setIsDragging] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<Record<string, number>>({});
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { uploadDocuments } = useDocumentStore();

  const handleFiles = useCallback(async (files: FileList) => {
    if (files.length === 0) return;

    // Validate files
    const validFiles = Array.from(files).filter(file => {
      if (!isSupportedDocumentType(file.name)) {
        alert(`File "${file.name}" is not a supported document type. Supported types: PDF, TXT, DOC, DOCX, RTF`);
        return false;
      }

      if (!isFileSizeValid(file.size, maxSizeMB)) {
        alert(`File "${file.name}" exceeds the maximum size limit of ${maxSizeMB}MB`);
        return false;
      }

      return true;
    });

    if (validFiles.length === 0) return;

    if (validFiles.length > maxFiles) {
      alert(`You can only upload ${maxFiles} files at a time`);
      return;
    }

    setIsUploading(true);
    setUploadProgress({});
    
    try {
      onUploadStart?.(validFiles);

      const uploadPromises = validFiles.map(async (file) => {
        try {
          // Initialize progress
          setUploadProgress(prev => ({ ...prev, [file.name]: 0 }));

          // Upload document
          // Progress tracking will be handled by the store
          await uploadDocuments(sessionId, [file]);

          // Complete progress
          setUploadProgress(prev => ({ ...prev, [file.name]: 100 }));
        } catch (error) {
          console.error(`Failed to upload ${file.name}:`, error);
          throw error;
        }
      });

      await Promise.allSettled(uploadPromises);
      
      // Reload documents to get updated list
      onUploadComplete?.([]);
    } catch (error) {
      console.error('Upload failed:', error);
      onUploadError?.(error as Error);
    } finally {
      setIsUploading(false);
      setUploadProgress({});
    }
  }, [sessionId, maxFiles, maxSizeMB, uploadDocuments, onUploadStart, onUploadComplete, onUploadError]);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    handleFiles(e.dataTransfer.files);
  }, [handleFiles]);

  const handleFileSelect = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) {
      handleFiles(e.target.files);
    }
  }, [handleFiles]);

  const openFileDialog = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const overallProgress = Object.values(uploadProgress).length > 0
    ? Object.values(uploadProgress).reduce((sum, progress) => sum + progress, 0) / Object.values(uploadProgress).length
    : 0;

  return (
    <Card className={clsx('border-2 border-dashed', className)}>
      <div
        className={clsx(
          'p-4 sm:p-6 lg:p-8 text-center transition-colors duration-200 touch-manipulation',
          isDragging ? 'bg-blue-50 dark:bg-blue-900/20 border-blue-400' : 'border-gray-300 dark:border-gray-600'
        )}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept=".pdf,.txt,.doc,.docx,.rtf"
          onChange={handleFileSelect}
          className="hidden"
          disabled={isUploading}
        />

        {!isUploading ? (
          <>
            <div className="mx-auto w-10 h-10 sm:w-12 sm:h-12 text-gray-400 mb-3 sm:mb-4">
              <svg
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12"
                />
              </svg>
            </div>
            
            <h3 className="text-base sm:text-lg font-medium text-gray-900 dark:text-white mb-2">
              Upload Documents
            </h3>
            
            <p className="text-sm sm:text-base text-gray-600 dark:text-gray-300 mb-3 sm:mb-4">
              Drag and drop files here, or click to select files
            </p>
            
            <div className="text-xs sm:text-sm text-gray-500 dark:text-gray-400 mb-3 sm:mb-4">
              <p>Supported formats: PDF, TXT, DOC, DOCX, RTF</p>
              <p>Maximum file size: {maxSizeMB}MB</p>
              <p>Maximum files: {maxFiles}</p>
            </div>
            
            {trigger || (
              <Button onClick={openFileDialog} disabled={isUploading} className="w-full sm:w-auto">
                Select Files
              </Button>
            )}
          </>
        ) : (
          <div className="space-y-3 sm:space-y-4">
            <div className="mx-auto w-10 h-10 sm:w-12 sm:h-12 text-blue-500 animate-spin">
              <svg
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
                />
              </svg>
            </div>
            
            <h3 className="text-base sm:text-lg font-medium text-gray-900 dark:text-white">
              Uploading Documents...
            </h3>
            
            {/* Overall Progress */}
            <div className="w-full bg-gray-200 dark:bg-gray-700 rounded-full h-2">
              <div
                className="bg-blue-500 h-2 rounded-full transition-all duration-300"
                style={{ width: `${overallProgress}%` }}
              />
            </div>
            
            <p className="text-xs sm:text-sm text-gray-600 dark:text-gray-300">
              {Math.round(overallProgress)}% complete
            </p>
            
            {/* Individual File Progress */}
            {Object.entries(uploadProgress).map(([filename, progress]) => (
              <div key={filename} className="text-left space-y-1">
                <div className="flex justify-between text-xs sm:text-sm">
                  <span className="text-gray-600 dark:text-gray-300 truncate">
                    {filename}
                  </span>
                  <span className="text-gray-500 dark:text-gray-400">
                    {Math.round(progress)}%
                  </span>
                </div>
                <div className="w-full bg-gray-200 dark:bg-gray-700 rounded-full h-1">
                  <div
                    className="bg-blue-500 h-1 rounded-full transition-all duration-300"
                    style={{ width: `${progress}%` }}
                  />
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </Card>
  );
};

// Compact version for inline use
export const DocumentUploadCompact: React.FC<{
  sessionId: string;
  onUploadComplete?: (documents: any[]) => void;
  className?: string;
}> = ({ sessionId, onUploadComplete, className }) => {
  const [isUploading, setIsUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { uploadDocuments } = useDocumentStore();

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!e.target.files || e.target.files.length === 0) return;

    setIsUploading(true);
    
    try {
      const file = e.target.files[0];
      await uploadDocuments(sessionId, [file]);
      onUploadComplete?.([]);
    } catch (error) {
      console.error('Upload failed:', error);
    } finally {
      setIsUploading(false);
    }
  };

  return (
    <div className={clsx('flex items-center gap-2', className)}>
      <input
        ref={fileInputRef}
        type="file"
        accept=".pdf,.txt,.doc,.docx,.rtf"
        onChange={handleFileSelect}
        className="hidden"
        disabled={isUploading}
      />
      
      <Button
        variant="outline"
        size="sm"
        onClick={() => fileInputRef.current?.click()}
        disabled={isUploading}
        loading={isUploading}
        className="flex-1 sm:flex-none"
      >
        {isUploading ? 'Uploading...' : 'Add Document'}
      </Button>
    </div>
  );
};