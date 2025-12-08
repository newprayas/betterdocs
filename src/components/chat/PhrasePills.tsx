import React, { useRef, useEffect, useState } from 'react';
import clsx from 'clsx';

// Default phrases for the pills
const DEFAULT_PHRASES = [
  "Give details about",
  "Definition",
  "Types / Classification",
  "Causes",
  "Risk factors",
  "Pathogenesis",
  "Clinical Features",
  "Investigations",
  "Treatment",
  "Difference between"
];

// TypeScript interfaces
export interface PhrasePillProps {
  phrase: string;
  isSelected?: boolean;
  onClick: () => void;
  onKeyDown?: (event: React.KeyboardEvent) => void;
  className?: string;
}

export interface PhrasePillsProps {
  phrases?: string[];
  onPhraseSelect: (phrase: string) => void;
  selectedPhrase?: string;
  className?: string;
  ariaLabel?: string;
}

// Individual Pill Component
const PhrasePill: React.FC<PhrasePillProps> = ({
  phrase,
  isSelected = false,
  onClick,
  onKeyDown,
  className,
}) => {
  const handleKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      onClick();
    }
    onKeyDown?.(event);
  };

  return (
    <button
      type="button"
      role="button"
      tabIndex={0}
      onClick={onClick}
      onMouseDown={(e) => e.preventDefault()}
      onKeyDown={handleKeyDown}
      aria-pressed={isSelected}
      aria-label={`Select phrase: ${phrase}`}
      className={clsx(
        // Base styles
        'inline-flex items-center justify-center px-3 py-2 sm:px-4 sm:py-2',
        'text-xs sm:text-sm font-medium rounded-full',
        'transition-all duration-200 ease-in-out',
        'touch-manipulation',
        'min-h-[32px] sm:min-h-[36px]',

        // Grey background with white border and text
        'bg-gray-600 text-white border border-white',

        // Hover and active states
        'hover:bg-gray-500 hover:scale-105 active:scale-95',

        // Focus styles for accessibility
        'focus:outline-none focus:ring-2 focus:ring-white focus:ring-offset-2 focus:ring-offset-gray-600',

        // Selected state
        isSelected && 'bg-blue-500 border-blue-300 hover:bg-blue-600',

        // Mobile touch feedback
        '-webkit-tap-highlight-color: rgba(255, 255, 255, 0.2)',

        className
      )}
    >
      <span className="truncate max-w-[120px] sm:max-w-[150px]">{phrase}</span>
    </button>
  );
};

// Main PhrasePills Component
export const PhrasePills: React.FC<PhrasePillsProps> = ({
  phrases = DEFAULT_PHRASES,
  onPhraseSelect,
  selectedPhrase,
  className,
  ariaLabel = "Quick phrase suggestions"
}) => {
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const [canScrollLeft, setCanScrollLeft] = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(true);

  // Check scroll position to update scroll buttons
  const checkScrollPosition = () => {
    const container = scrollContainerRef.current;
    if (container) {
      setCanScrollLeft(container.scrollLeft > 0);
      setCanScrollRight(
        container.scrollLeft < container.scrollWidth - container.clientWidth
      );
    }
  };

  // Handle scroll events
  const handleScroll = () => {
    checkScrollPosition();
  };

  // Scroll functions for desktop navigation
  const scrollLeft = () => {
    const container = scrollContainerRef.current;
    if (container) {
      container.scrollBy({ left: -200, behavior: 'smooth' });
    }
  };

  const scrollRight = () => {
    const container = scrollContainerRef.current;
    if (container) {
      container.scrollBy({ left: 200, behavior: 'smooth' });
    }
  };

  // Handle keyboard navigation
  const handleKeyDown = (event: React.KeyboardEvent) => {
    const container = scrollContainerRef.current;
    if (!container) return;

    switch (event.key) {
      case 'ArrowLeft':
        event.preventDefault();
        scrollLeft();
        break;
      case 'ArrowRight':
        event.preventDefault();
        scrollRight();
        break;
      case 'Home':
        event.preventDefault();
        container.scrollTo({ left: 0, behavior: 'smooth' });
        break;
      case 'End':
        event.preventDefault();
        container.scrollTo({ left: container.scrollWidth, behavior: 'smooth' });
        break;
    }
  };

  // Initialize scroll position check
  useEffect(() => {
    checkScrollPosition();

    // Add resize listener
    const handleResize = () => {
      checkScrollPosition();
    };

    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, [phrases]);

  return (
    <div
      className={clsx(
        'relative w-full',
        className
      )}
      role="region"
      aria-label={ariaLabel}
    >
      {/* Desktop scroll buttons */}
      <div className="hidden sm:flex absolute left-0 top-0 bottom-0 z-10 items-center pointer-events-none">
        {canScrollLeft && (
          <button
            type="button"
            onClick={scrollLeft}
            aria-label="Scroll left"
            className="pointer-events-auto bg-gray-800/80 text-white rounded-full p-1.5 shadow-lg border border-gray-600 hover:bg-gray-700 transition-all duration-200 ml-2"
          >
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
                d="M15 19l-7-7 7-7"
              />
            </svg>
          </button>
        )}
      </div>

      <div className="hidden sm:flex absolute right-0 top-0 bottom-0 z-10 items-center pointer-events-none">
        {canScrollRight && (
          <button
            type="button"
            onClick={scrollRight}
            aria-label="Scroll right"
            className="pointer-events-auto bg-gray-800/80 text-white rounded-full p-1.5 shadow-lg border border-gray-600 hover:bg-gray-700 transition-all duration-200 mr-2"
          >
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
                d="M9 5l7 7-7 7"
              />
            </svg>
          </button>
        )}
      </div>

      {/* Scrollable container */}
      <div
        ref={scrollContainerRef}
        onScroll={handleScroll}
        onKeyDown={handleKeyDown}
        tabIndex={0}
        role="list"
        aria-orientation="horizontal"
        className={clsx(
          // Base container styles
          'flex gap-2 sm:gap-3 overflow-x-auto scrollbar-thin',
          'scrollbar-thumb-gray-600 scrollbar-track-transparent',
          'px-3 sm:px-4 py-3',

          // Mobile touch optimization
          'touch-pan-x -webkit-overflow-scrolling: touch',
          'snap-x snap-mandatory',

          // Prevent text selection while scrolling
          'select-none',

          // Hide scrollbar on mobile for cleaner look
          'sm:scrollbar-thin',
          '[&::-webkit-scrollbar]:hidden [-ms-overflow-style:none] [scrollbar-width:none]',
          'sm:[&::-webkit-scrollbar]:h-2 sm:[&::-webkit-scrollbar-thumb]:rounded-full',
          'sm:[&::-webkit-scrollbar-thumb]:bg-gray-600',
          'sm:[&::-webkit-scrollbar-track]:bg-transparent'
        )}
        style={{
          // Custom scrollbar styles for mobile
          scrollbarWidth: 'none',
          msOverflowStyle: 'none'
        }}
      >
        {phrases.map((phrase, index) => (
          <div
            key={`${phrase}-${index}`}
            className="flex-shrink-0 snap-start"
            role="listitem"
          >
            <PhrasePill
              phrase={phrase}
              isSelected={selectedPhrase === phrase}
              onClick={() => onPhraseSelect(phrase)}
            />
          </div>
        ))}

        {/* Add some spacing at the end for better scroll experience */}
        <div className="w-4 sm:w-8 flex-shrink-0" />
      </div>

      {/* Gradient fade indicators for desktop */}
      <div className="hidden sm:block absolute left-0 top-0 bottom-0 w-8 bg-gradient-to-r from-gray-900 to-transparent pointer-events-none" />
      <div className="hidden sm:block absolute right-0 top-0 bottom-0 w-8 bg-gradient-to-l from-gray-900 to-transparent pointer-events-none" />
    </div>
  );
};

export default PhrasePills;