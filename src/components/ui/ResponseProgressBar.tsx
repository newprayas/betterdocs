import React from 'react';

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
  // Ensure progress is within bounds
  const clampedProgress = Math.min(100, Math.max(0, progress));
  
  return (
    <div className={`max-w-[85%] sm:max-w-xs lg:max-w-md xl:max-w-lg mx-auto ${className}`}>
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
      <div className="flex justify-between items-center text-xs text-gray-500 dark:text-gray-400">
        <span className="truncate mr-2">{currentStep}</span>
        <span className="font-medium">{clampedProgress}%</span>
      </div>
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