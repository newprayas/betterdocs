import React, { useEffect, useState } from 'react';

// Helpful tips that rotate each time the progress bar appears
const HELPFUL_TIPS = [
  '⚡ Switch on only the most relevant 3-4 books for your specific question for Faster response!',
  '⚡ Meddy is much faster on computers, laptops and tablets!',
  '⚡ Meddy can quickly find answers from multiple books, thousands of pages!',
  '⚡ You can add many books, but only switch on 3-4 most relevant books for faster response!',
  '⚡ Request any book, newer edition, or national and international guidelines you want, we will add them ❤️',
  '⚡ Switch off unrelated books in documents tab - you can always activate them later!',
  '⚡ Meddy gives citations and references, that is awesome!',
  '⚡ Ask follow up questions: What is sepsis? [Meddy answers] You can simply follow up with : What are its causes?',
  '⚡ Share the app with friends! Meddy helps all doctors, medical and post grad students ❤️',
];

// Module-level counter to track which tip to show next (persists across renders)
let tipCounter = 0;

interface ResponseProgressBarProps {
  progress: number; // Progress percentage (0-100)
  currentStep: string; // Name of the current step
  className?: string;
}

export const ResponseProgressBar: React.FC<ResponseProgressBarProps> = ({
  progress,
  currentStep,
  className
}) => {
  // Get the current tip index on mount (cycles through 0-5)
  const [currentTip, setCurrentTip] = useState('');

  useEffect(() => {
    // Set the tip for this instance
    setCurrentTip(HELPFUL_TIPS[tipCounter]);
    // Increment for the next time the component mounts
    tipCounter = (tipCounter + 1) % HELPFUL_TIPS.length;
  }, []);

  // Ensure progress is within bounds
  const clampedProgress = Math.min(100, Math.max(0, progress));

  return (
    <div className={`max-w-[70%] sm:max-w-[280px] lg:max-w-[320px] xl:max-w-[360px] mx-auto ${className}`}>
      {/* "Reading the sources" text */}
      <div className="text-sm text-gray-600 dark:text-gray-400 font-medium mb-3 text-center">
        Reading the sources
      </div>

      {/* Progress bar container */}
      <div className="w-full bg-gray-200 dark:bg-gray-700 rounded-full h-2.5 mb-3">
        {/* Progress bar fill */}
        <div
          className="bg-blue-500 h-2.5 rounded-full transition-all duration-300 ease-out"
          style={{ width: `${clampedProgress}%` }}
        ></div>
      </div>

      {/* Current step name and percentage */}
      <div className="flex justify-between items-center text-xs text-gray-500 dark:text-gray-400 mb-3">
        <span className="truncate mr-2">{currentStep}</span>
        <span className="font-medium">{clampedProgress}%</span>
      </div>

      {/* Helpful tip - wraps to multiple lines */}
      {currentTip && (
        <div className="text-xs text-amber-600 dark:text-amber-400 text-center font-medium leading-relaxed">
          {currentTip}
        </div>
      )}
    </div>
  );
};

// Predefined progress steps for easy reference
export const PROGRESS_STEPS = {
  QUERY_REWRITING: { name: 'Query Rewriting', percentage: 25 },
  EMBEDDING_GENERATION: { name: 'Embedding Generation', percentage: 50 },
  VECTOR_SEARCH: { name: 'Vector Search', percentage: 75 },
  RESPONSE_GENERATION: { name: 'Response Generation', percentage: 90 },
  RESPONSE_FORMATTING: { name: 'Response Formatting', percentage: 100 }
} as const;

// Helper function to get step info
export const getProgressStep = (step: keyof typeof PROGRESS_STEPS) => {
  return PROGRESS_STEPS[step];
};