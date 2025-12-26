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
    <Card className={clsx('border-2 border-dashed border-gray-200 dark:border-slate-700 bg-gray-50/50 dark:bg-slate-900/50', className)}>
      <div className="p-6 sm:p-8 text-center text-gray-500 dark:text-gray-400">
        <div className="mx-auto w-12 h-12 mb-3 opacity-50">
          <svg fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
          </svg>
        </div>
        <h3 className="text-sm font-medium text-gray-900 dark:text-white mb-1">
          Local Uploads Disabled
        </h3>
        <p className="text-xs max-w-[200px] mx-auto opacity-75">
          During the Public Beta, only the curated Medical Library is available to ensure quality and zero cost.
        </p>
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
      <Button
        variant="outline"
        size="sm"
        disabled={true}
        title="Local uploads are disabled in the Beta"
        className="flex-1 sm:flex-none opacity-50 cursor-not-allowed"
      >
        <svg className="w-4 h-4 mr-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
        </svg>
        Add Document
      </Button>
    </div>
  );
};