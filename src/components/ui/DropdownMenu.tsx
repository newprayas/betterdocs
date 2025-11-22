import React, { useState, useRef, useEffect } from 'react';
import { Button } from './Button';

interface DropdownMenuProps {
  trigger: React.ReactNode;
  children: React.ReactNode;
  align?: 'left' | 'right';
  closeOnSelect?: boolean;
}

export const DropdownMenu: React.FC<DropdownMenuProps> = ({
  trigger,
  children,
  align = 'right',
  closeOnSelect = false,
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const alignClasses = {
    left: 'left-0',
    right: 'right-0',
  };

  return (
    <div className="relative inline-block text-left" ref={dropdownRef} data-dropdown>
      <div onClick={() => setIsOpen(!isOpen)}>
        {trigger}
      </div>
      
      {isOpen && (
        <div className={`
          absolute z-50 mt-2 w-48 rounded-md shadow-lg bg-white dark:bg-gray-800 ring-1 ring-black ring-opacity-5
          ${alignClasses[align]}
        `}>
          <div className="py-1">
            {children}
          </div>
        </div>
      )}
    </div>
  );
};

interface DropdownMenuItemProps {
  onClick: () => void;
  children: React.ReactNode;
  variant?: 'default' | 'danger';
  disabled?: boolean;
  closeOnClick?: boolean;
}

export const DropdownMenuItem: React.FC<DropdownMenuItemProps> = ({
  onClick,
  children,
  variant = 'default',
  disabled = false,
  closeOnClick = true,
}) => {
  const variantClasses = {
    default: 'text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700',
    danger: 'text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20',
  };

  const disabledClasses = disabled ? 'opacity-50 cursor-not-allowed' : '';

  // Get the parent DropdownMenu component to control its state
  const getDropdownMenu = () => {
    let element = document.activeElement as HTMLElement;
    while (element && element.parentElement) {
      if (element.parentElement.hasAttribute('data-dropdown')) {
        return element.parentElement;
      }
      element = element.parentElement;
    }
    return null;
  };

  const handleClick = () => {
    if (!disabled) {
      onClick();
      // Close the dropdown if closeOnClick is true
      if (closeOnClick) {
        const dropdown = getDropdownMenu();
        if (dropdown) {
          const clickEvent = new MouseEvent('mousedown', {
            bubbles: true,
            cancelable: true,
            view: window,
          });
          document.dispatchEvent(clickEvent);
        }
      }
    }
  };

  return (
    <button
      onClick={handleClick}
      disabled={disabled}
      className={`
        w-full text-left px-4 py-2 text-sm transition-colors duration-200
        ${variantClasses[variant]}
        ${disabledClasses}
      `}
    >
      {children}
    </button>
  );
};