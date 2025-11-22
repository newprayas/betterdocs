/**
 * Ensure the input is a Date object (handles string serialization from IndexedDB)
 */
export function ensureDate(date: Date | string | undefined | null): Date {
  // Handle undefined, null, or falsy values
  if (!date) {
    console.warn('No date provided, using current date');
    return new Date();
  }
  
  if (typeof date === 'string') {
    const dateObj = new Date(date);
    // Check if the date is valid
    if (isNaN(dateObj.getTime())) {
      // If invalid, return current date as fallback
      console.warn('Invalid date string provided, using current date:', date);
      return new Date();
    }
    return dateObj;
  }
  
  // Check if the Date object is valid
  if (isNaN(date.getTime())) {
    console.warn('Invalid Date object provided, using current date:', date);
    return new Date();
  }
  
  return date;
}

/**
 * Format date to short format (MMM d, yyyy)
 */
export function formatDateShort(date: Date | string | undefined | null): string {
  const dateObj = ensureDate(date);
  return dateObj.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

/**
 * Format date to long format with time
 */
export function formatDateLong(date: Date | string | undefined | null): string {
  const dateObj = ensureDate(date);
  return dateObj.toLocaleString('en-US', {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
}

/**
 * Format time only (h:mm a)
 */
export function formatTime(date: Date | string | undefined | null): string {
  const dateObj = ensureDate(date);
  return dateObj.toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
}

/**
 * Get relative time string
 */
export function getRelativeTime(date: Date | string | undefined | null): string {
  const dateObj = ensureDate(date);
  const now = new Date();
  const diff = now.getTime() - dateObj.getTime();
  
  const minutes = Math.floor(diff / (1000 * 60));
  const hours = Math.floor(diff / (1000 * 60 * 60));
  const days = Math.floor(diff / (1000 * 60 * 60 * 24));
  
  if (minutes < 1) {
    return 'Just now';
  } else if (hours < 1) {
    return `${minutes}m ago`;
  } else if (days < 1) {
    return `${hours}h ago`;
  } else {
    return formatDateShort(dateObj);
  }
}

/**
 * Check if date is today
 */
export function isToday(date: Date | string | undefined | null): boolean {
  const dateObj = ensureDate(date);
  const today = new Date();
  return (
    dateObj.getDate() === today.getDate() &&
    dateObj.getMonth() === today.getMonth() &&
    dateObj.getFullYear() === today.getFullYear()
  );
}

/**
 * Check if date is yesterday
 */
export function isYesterday(date: Date | string | undefined | null): boolean {
  const dateObj = ensureDate(date);
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  
  return (
    dateObj.getDate() === yesterday.getDate() &&
    dateObj.getMonth() === yesterday.getMonth() &&
    dateObj.getFullYear() === yesterday.getFullYear()
  );
}