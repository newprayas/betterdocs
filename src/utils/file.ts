/**
 * Format file size in bytes to human-readable format
 */
export const formatFileSize = (bytes: number): string => {
  if (bytes === 0) return '0 Bytes';

  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));

  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
};

/**
 * Get file extension from filename
 */
export const getFileExtension = (filename: string): string => {
  return filename.slice((filename.lastIndexOf('.') - 1 >>> 0) + 2);
};

/**
 * Check if file is a supported document type
 */
export const isSupportedDocumentType = (filename: string): boolean => {
  const supportedTypes = ['json'];
  const extension = getFileExtension(filename).toLowerCase();
  return supportedTypes.includes(extension);
};

/**
 * Get MIME type from filename
 */
export const getMimeType = (filename: string): string => {
  const extension = getFileExtension(filename).toLowerCase();
  const mimeTypes: Record<string, string> = {
    json: 'application/json',
  };

  return mimeTypes[extension] || 'application/octet-stream';
};

/**
 * Generate a safe filename for storage
 */
export const generateSafeFilename = (filename: string): string => {
  // Remove special characters and replace with underscores
  return filename.replace(/[^a-zA-Z0-9.-]/g, '_');
};

/**
 * Check if file size exceeds limit
 */
export const isFileSizeValid = (bytes: number, maxSizeInMB: number = 50): boolean => {
  const maxSizeInBytes = maxSizeInMB * 1024 * 1024;
  return bytes <= maxSizeInBytes;
};