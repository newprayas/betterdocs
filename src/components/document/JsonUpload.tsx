import React, { useState, useRef, useCallback } from 'react';
import { Button } from '../ui/Button';
import { Card } from '../ui/Card';
import { documentProcessor } from '../../services/rag';
import { useDocumentStore } from '../../store';
import type { PreprocessedPackage } from '../../types/preprocessed';
import clsx from 'clsx';

interface JsonUploadProps {
  sessionId: string;
  onUploadStart?: () => void;
  onUploadComplete?: (result: { documentCount: number; chunkCount: number }) => void;
  onUploadError?: (error: Error) => void;
  className?: string;
}

export const JsonUpload: React.FC<JsonUploadProps> = ({
  sessionId,
  onUploadStart,
  onUploadComplete,
  onUploadError,
  className,
}) => {
  const [isDragging, setIsDragging] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const validateJsonStructure = (data: any): data is PreprocessedPackage => {
    try {
      // Check required fields
      if (!data.format_version || !data.export_metadata || !data.document_metadata || !data.chunks) {
        return false;
      }

      // Check chunks structure
      if (!Array.isArray(data.chunks)) {
        return false;
      }

      // Validate each chunk
      for (const chunk of data.chunks) {
        if (!chunk.id || !chunk.text || !Array.isArray(chunk.embedding)) {
          return false;
        }
      }

      return true;
    } catch (error) {
      return false;
    }
  };

  const handleFile = useCallback(async (file: File) => {
    console.log('🚀 JSON Upload: Starting file upload process');
    console.log('📁 File details:', {
      name: file.name,
      size: file.size,
      type: file.type,
      lastModified: new Date(file.lastModified)
    });

    if (!file.name.endsWith('.json')) {
      const errorMsg = 'Please upload a JSON file with preprocessed document data';
      console.error('❌ JSON Upload: Invalid file type - not a JSON file');
      alert(errorMsg);
      return;
    }

    setIsUploading(true);
    setUploadProgress(0);
    
    try {
      console.log('✅ JSON Upload: File validation passed, starting upload');
      onUploadStart?.();

      // Read and parse JSON file
      console.log('📖 JSON Upload: Reading file content...');
      setUploadProgress(20);
      const fileContent = await file.text();
      console.log('📊 JSON Upload: File content length:', fileContent.length, 'characters');
      
      console.log('🔄 JSON Upload: Parsing JSON...');
      let jsonData: PreprocessedPackage;
      try {
        jsonData = JSON.parse(fileContent);
        console.log('✅ JSON Upload: JSON parsed successfully');
        console.log('📋 JSON Upload: Structure check:', {
          hasFormatVersion: !!jsonData.format_version,
          hasExportMetadata: !!jsonData.export_metadata,
          hasDocumentMetadata: !!jsonData.document_metadata,
          hasChunks: !!jsonData.chunks,
          chunksCount: jsonData.chunks?.length || 0
        });
      } catch (parseError) {
        console.error('❌ JSON Upload: JSON parse failed:', parseError);
        throw new Error(`Invalid JSON format: ${parseError instanceof Error ? parseError.message : 'Unknown parse error'}`);
      }

      // Validate structure
      console.log('🔍 JSON Upload: Validating JSON structure...');
      setUploadProgress(40);
      if (!validateJsonStructure(jsonData)) {
        console.error('❌ JSON Upload: Structure validation failed');
        console.log('🔍 JSON Upload: Actual structure received:', jsonData);
        throw new Error('Invalid JSON structure. Please ensure the file follows the preprocessed document format with format_version, export_metadata, document_metadata, and chunks array.');
      }
      console.log('✅ JSON Upload: Structure validation passed');

      // Process the package
      console.log('⚙️ JSON Upload: Starting document processing...');
      setUploadProgress(60);
      
      // Get userId from documentStore
      const { userId } = useDocumentStore.getState();
      if (!userId) {
        throw new Error('User ID not found. Please log in again.');
      }
      console.log('🔍 JSON Upload: Retrieved userId from documentStore:', userId);
      
      await documentProcessor.processPreprocessedPackage(
        sessionId,
        jsonData,
        userId,
        (progress) => {
          const percentage = (progress.processedChunks / progress.totalChunks) * 40;
          setUploadProgress(60 + percentage);
          console.log(`📈 JSON Upload: Processing progress: ${progress.processedChunks}/${progress.totalChunks} chunks (${Math.round(60 + percentage)}%)`);
        }
      );

      console.log('✅ JSON Upload: Document processing completed');
      setUploadProgress(100);
      
      // Refresh the document store to show the newly processed document
      console.log('🔄 JSON Upload: Refreshing document store...');
      console.log('🔍 RACE CONDITION DEBUG: About to call loadDocuments');
      
      const { loadDocuments } = useDocumentStore.getState();
      console.log('🔍 RACE CONDITION DEBUG: loadDocuments function obtained');
      
      // Add a small delay to ensure all database operations have committed
      await new Promise(resolve => setTimeout(resolve, 100));
      console.log('🔍 RACE CONDITION DEBUG: Delay completed, calling loadDocuments');
      
      await loadDocuments(sessionId);
      console.log('🔍 RACE CONDITION DEBUG: loadDocuments completed');
      
      // Check what documents are now in the store
      const currentDocuments = useDocumentStore.getState().documents;
      console.log('🔍 RACE CONDITION DEBUG: Documents in store after refresh:', {
        count: currentDocuments.length,
        documents: currentDocuments.map(doc => ({
          id: doc.id,
          filename: doc.filename,
          status: doc.status,
          enabled: doc.enabled
        }))
      });
      
      console.log('✅ JSON Upload: Document store refreshed');
      
      onUploadComplete?.({
        documentCount: 1,
        chunkCount: jsonData.chunks.length,
      });
      console.log('🎉 JSON Upload: Upload process completed successfully');
    } catch (error) {
      console.error('💥 JSON Upload: Upload failed with error:', error);
      console.error('💥 JSON Upload: Error details:', {
        name: error instanceof Error ? error.name : 'Unknown',
        message: error instanceof Error ? error.message : 'Unknown error',
        stack: error instanceof Error ? error.stack : 'No stack trace'
      });
      onUploadError?.(error as Error);
    } finally {
      console.log('🏁 JSON Upload: Cleaning up upload state');
      setIsUploading(false);
      setUploadProgress(0);
    }
  }, [sessionId, onUploadStart, onUploadComplete, onUploadError]);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    
    const files = Array.from(e.dataTransfer.files);
    if (files.length > 0) {
      handleFile(files[0]);
    }
  }, [handleFile]);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
  }, []);

  const handleFileSelect = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      handleFile(e.target.files[0]);
    }
  }, [handleFile]);

  const openFileDialog = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  return (
    <Card className={clsx('border-2 border-dashed', className)}>
      <div
        className={clsx(
          'p-8 text-center transition-colors duration-200',
          isDragging ? 'bg-blue-50 dark:bg-blue-900/20 border-blue-400' : 'border-gray-300 dark:border-gray-600'
        )}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        <input
          ref={fileInputRef}
          type="file"
          accept=".json"
          onChange={handleFileSelect}
          className="hidden"
          disabled={isUploading}
        />

        {!isUploading ? (
          <>
            <div className="mx-auto w-12 h-12 text-gray-400 mb-4">
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
            
            <h3 className="text-lg font-medium text-gray-900 dark:text-white mb-2">
              Upload Preprocessed Document
            </h3>
            
            <p className="text-gray-600 dark:text-gray-300 mb-4">
              Drag and drop a JSON file here, or click to select a file
            </p>
            
            <div className="text-sm text-gray-500 dark:text-gray-400 mb-4">
              <p>Format: Preprocessed JSON document</p>
              <p>The app no longer processes PDFs directly</p>
            </div>
            
            <Button onClick={openFileDialog} disabled={isUploading}>
              Select JSON File
            </Button>
          </>
        ) : (
          <div className="space-y-4">
            <div className="mx-auto w-12 h-12 text-blue-500 animate-spin">
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
            
            <h3 className="text-lg font-medium text-gray-900 dark:text-white">
              Processing Document...
            </h3>
            
            <div className="w-full bg-gray-200 dark:bg-gray-700 rounded-full h-2">
              <div
                className="bg-blue-500 h-2 rounded-full transition-all duration-300"
                style={{ width: `${uploadProgress}%` }}
              />
            </div>
            
            <p className="text-sm text-gray-600 dark:text-gray-300">
              {Math.round(uploadProgress)}% complete
            </p>
          </div>
        )}
      </div>
    </Card>
  );
};

// Compact version for inline use
export const JsonUploadCompact: React.FC<{
  sessionId: string;
  onUploadComplete?: (result: { documentCount: number; chunkCount: number }) => void;
  className?: string;
}> = ({ sessionId, onUploadComplete, className }) => {
  const [isUploading, setIsUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    console.log('🚀 JsonUploadCompact: Starting file upload process');
    
    if (!e.target.files || e.target.files.length === 0) {
      console.log('⚠️ JsonUploadCompact: No files selected');
      return;
    }

    setIsUploading(true);
    
    try {
      const file = e.target.files[0];
      console.log('📁 JsonUploadCompact: File details:', {
        name: file.name,
        size: file.size,
        type: file.type
      });
      
      console.log('📖 JsonUploadCompact: Reading file content...');
      const fileContent = await file.text();
      console.log('📊 JsonUploadCompact: File content length:', fileContent.length, 'characters');
      
      console.log('🔄 JsonUploadCompact: Parsing JSON...');
      const jsonData: PreprocessedPackage = JSON.parse(fileContent);
      console.log('✅ JsonUploadCompact: JSON parsed successfully');
      
      console.log('⚙️ JsonUploadCompact: Processing document...');
      
      // Get userId from documentStore
      const { userId } = useDocumentStore.getState();
      if (!userId) {
        throw new Error('User ID not found. Please log in again.');
      }
      console.log('🔍 JsonUploadCompact: Retrieved userId from documentStore:', userId);
      
      await documentProcessor.processPreprocessedPackage(sessionId, jsonData, userId);
      console.log('✅ JsonUploadCompact: Document processing completed');
      
      // Refresh the document store to show the newly processed document
      console.log('🔄 JsonUploadCompact: Refreshing document store...');
      const { loadDocuments } = useDocumentStore.getState();
      await loadDocuments(sessionId);
      console.log('✅ JsonUploadCompact: Document store refreshed');
      
      onUploadComplete?.({
        documentCount: 1,
        chunkCount: jsonData.chunks.length,
      });
      console.log('🎉 JsonUploadCompact: Upload completed successfully');
    } catch (error) {
      console.error('💥 JsonUploadCompact: Upload failed:', error);
      console.error('💥 JsonUploadCompact: Error details:', {
        name: error instanceof Error ? error.name : 'Unknown',
        message: error instanceof Error ? error.message : 'Unknown error',
        stack: error instanceof Error ? error.stack : 'No stack trace'
      });
      alert(`Failed to process JSON file: ${error instanceof Error ? error.message : 'Unknown error'}. Please check the file format.`);
    } finally {
      console.log('🏁 JsonUploadCompact: Cleaning up upload state');
      setIsUploading(false);
    }
  };

  return (
    <div className={clsx('flex items-center gap-2', className)}>
      <input
        ref={fileInputRef}
        type="file"
        accept=".json"
        onChange={handleFileSelect}
        className="hidden"
        disabled={isUploading}
      />
      
      <Button
        variant="outline"
        size="sm"
        onClick={() => fileInputRef.current?.click()}
        disabled={isUploading}
      >
        {isUploading ? 'Processing...' : 'Add JSON Document'}
      </Button>
    </div>
  );
};