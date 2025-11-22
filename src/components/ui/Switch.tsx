import React, { forwardRef } from 'react';
import clsx from 'clsx';

export interface SwitchProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  checked?: boolean;
  onCheckedChange?: (checked: boolean) => void;
  disabled?: boolean;
  size?: 'sm' | 'md' | 'lg';
}

export const Switch = forwardRef<HTMLButtonElement, SwitchProps>(
  ({ className, checked = false, onCheckedChange, disabled = false, size = 'md', ...props }, ref) => {
    const handleClick = () => {
      if (!disabled && onCheckedChange) {
        onCheckedChange(!checked);
      }
    };

    const sizeClasses = {
      sm: 'w-8 h-4',
      md: 'w-11 h-6',
      lg: 'w-14 h-8'
    };

    const thumbSizeClasses = {
      sm: 'w-3 h-3',
      md: 'w-5 h-5',
      lg: 'w-6 h-6'
    };

    const thumbTranslateClasses = {
      sm: checked ? 'translate-x-4' : 'translate-x-0.5',
      md: checked ? 'translate-x-5' : 'translate-x-0.5',
      lg: checked ? 'translate-x-6' : 'translate-x-1'
    };

    return (
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        className={clsx(
          'relative inline-flex flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none focus:ring-2 focus:ring-offset-2',
          checked
            ? 'bg-blue-600 focus:ring-blue-500'
            : 'bg-gray-200 dark:bg-gray-700 focus:ring-gray-500',
          disabled && 'opacity-50 cursor-not-allowed',
          sizeClasses[size],
          className
        )}
        onClick={handleClick}
        ref={ref}
        {...props}
      >
        <span
          className={clsx(
            'pointer-events-none inline-block rounded-full bg-white shadow transform ring-0 transition-transform duration-200 ease-in-out',
            thumbSizeClasses[size],
            thumbTranslateClasses[size]
          )}
        />
      </button>
    );
  }
);

Switch.displayName = 'Switch';