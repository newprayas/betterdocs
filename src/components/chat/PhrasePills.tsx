import React, { useRef } from "react";
import clsx from "clsx";

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
  "Difference between",
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
    if (event.key === "Enter" || event.key === " ") {
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
        "inline-flex items-center justify-center px-3 py-2 sm:px-4 sm:py-2",
        "text-xs sm:text-sm font-medium rounded-full",
        "transition-all duration-200 ease-in-out",
        "touch-manipulation",
        "min-h-[32px] sm:min-h-[36px]",

        // Grey background with white border and text
        "bg-gray-600 text-white border border-white",

        // Hover and active states
        "hover:bg-gray-500 hover:scale-105 active:scale-95",

        // Focus styles for accessibility
        "focus:outline-none focus:ring-2 focus:ring-white focus:ring-offset-2 focus:ring-offset-gray-600",

        // Selected state
        isSelected && "bg-blue-500 border-blue-300 hover:bg-blue-600",

        // Mobile touch feedback
        "-webkit-tap-highlight-color: rgba(255, 255, 255, 0.2)",

        className,
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
  ariaLabel = "Quick phrase suggestions",
}) => {
  const scrollContainerRef = useRef<HTMLDivElement>(null);

  // Scroll functions for desktop navigation
  const scrollLeft = () => {
    const container = scrollContainerRef.current;
    if (container) {
      container.scrollBy({ left: -200, behavior: "smooth" });
    }
  };

  const scrollRight = () => {
    const container = scrollContainerRef.current;
    if (container) {
      container.scrollBy({ left: 200, behavior: "smooth" });
    }
  };

  // Handle keyboard navigation
  const handleKeyDown = (event: React.KeyboardEvent) => {
    const container = scrollContainerRef.current;
    if (!container) return;

    switch (event.key) {
      case "ArrowLeft":
        event.preventDefault();
        scrollLeft();
        break;
      case "ArrowRight":
        event.preventDefault();
        scrollRight();
        break;
      case "Home":
        event.preventDefault();
        container.scrollTo({ left: 0, behavior: "smooth" });
        break;
      case "End":
        event.preventDefault();
        container.scrollTo({ left: container.scrollWidth, behavior: "smooth" });
        break;
    }
  };

  return (
    <div
      className={clsx("relative w-full", className)}
      role="region"
      aria-label={ariaLabel}
    >
      {/* Scrollable container */}
      <div
        ref={scrollContainerRef}
        onKeyDown={handleKeyDown}
        tabIndex={0}
        role="list"
        aria-orientation="horizontal"
        className={clsx(
          // Base container styles
          "flex gap-2 sm:gap-3 overflow-x-auto scrollbar-thin",
          "scrollbar-thumb-gray-600 scrollbar-track-transparent",
          "px-3 sm:px-4 py-3",

          // Mobile touch optimization
          "touch-pan-x -webkit-overflow-scrolling: touch",
          "snap-x snap-mandatory",

          // Prevent text selection while scrolling
          "select-none",

          // Hide scrollbar on mobile for cleaner look
          "sm:scrollbar-thin",
          "[&::-webkit-scrollbar]:hidden [-ms-overflow-style:none] [scrollbar-width:none]",
          "sm:[&::-webkit-scrollbar]:h-2 sm:[&::-webkit-scrollbar-thumb]:rounded-full",
          "sm:[&::-webkit-scrollbar-thumb]:bg-gray-600",
          "sm:[&::-webkit-scrollbar-track]:bg-transparent",
        )}
        style={{
          // Custom scrollbar styles for mobile
          scrollbarWidth: "none",
          msOverflowStyle: "none",
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
    </div>
  );
};

export default PhrasePills;
