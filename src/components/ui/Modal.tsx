import React, { useEffect, useRef } from 'react';
import ReactDOM from 'react-dom';
import clsx from 'clsx';

interface ModalProps {
  isOpen: boolean;
  onClose: () => void;
  title?: string;
  children: React.ReactNode;
  size?: 'sm' | 'md' | 'lg' | 'xl';
  showCloseButton?: boolean;
  closeOnBackdropClick?: boolean;
}

// Synchronous function to get or create the portal container
function getOrCreatePortalContainer(): HTMLDivElement {
  // Check if container already exists to prevent duplicates
  let container = document.querySelector('[data-modal-portal="true"]') as HTMLDivElement;
  
  if (!container) {
    container = document.createElement('div');
    container.setAttribute('data-modal-portal', 'true');
    // Remove pointer-events: none to allow interaction with modal content
    container.style.cssText = 'position: fixed; top: 0; left: 0; z-index: 9999;';
    document.body.appendChild(container);
    console.log('✅ Modal: New portal container created and appended to body');
  } else {
    console.log('🔍 Modal: Using existing portal container');
  }
  
  return container;
}

export const Modal: React.FC<ModalProps> = ({
  isOpen,
  onClose,
  title,
  children,
  size = 'md',
  showCloseButton = true,
  closeOnBackdropClick = true,
}) => {
  const modalRef = useRef<HTMLDivElement>(null);
  const isRenderedRef = useRef(false);
  
  // Create a ref for the portal container that's initialized immediately
  const portalContainerRef = useRef<HTMLDivElement | null>(null);
  
  // Initialize portal container synchronously on first render
  if (!portalContainerRef.current) {
    portalContainerRef.current = getOrCreatePortalContainer();
    console.log('✅ Modal: Portal container initialized synchronously', {
      container: portalContainerRef.current,
      bodyChildren: document.body.children.length,
      containerStyles: portalContainerRef.current.style.cssText
    });
  }

  // Cleanup effect for portal container
  useEffect(() => {
    return () => {
      console.log('🔍 Modal: Cleanup effect triggered');
      // Don't remove the container on unmount as it might be used by other modals
      // Instead, just clear our reference
      portalContainerRef.current = null;
    };
  }, []);

  useEffect(() => {
    console.log('🔍 Modal: isOpen changed', { isOpen, isRendered: isRenderedRef.current });
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && isOpen) {
        onClose();
      }
    };

    if (isOpen) {
      document.addEventListener('keydown', handleEscape);
      document.body.style.overflow = 'hidden';
      isRenderedRef.current = true;
      
      // Debug: Log body styles
      console.log('🔍 Modal: Body styles after setting overflow:hidden', {
        overflow: document.body.style.overflow,
        computedOverflow: window.getComputedStyle(document.body).overflow
      });
    } else {
      isRenderedRef.current = false;
    }

    return () => {
      document.removeEventListener('keydown', handleEscape);
      document.body.style.overflow = 'unset';
    };
  }, [isOpen, onClose]);

  // Debug modal content after it's mounted
  useEffect(() => {
    if (isOpen && modalRef.current) {
      console.log('🔍 Modal: Modal content node mounted', {
        node: modalRef.current,
        className: modalRef.current.className,
        computedStyle: window.getComputedStyle(modalRef.current).cssText,
        offsetWidth: modalRef.current.offsetWidth,
        offsetHeight: modalRef.current.offsetHeight,
        offsetParent: modalRef.current.offsetParent,
        zIndex: window.getComputedStyle(modalRef.current).zIndex,
        visibility: window.getComputedStyle(modalRef.current).visibility,
        display: window.getComputedStyle(modalRef.current).display,
        opacity: window.getComputedStyle(modalRef.current).opacity,
        position: window.getComputedStyle(modalRef.current).position
      });
    }
  }, [isOpen]);

  const handleBackdropClick = (event: React.MouseEvent) => {
    if (event.target === event.currentTarget && closeOnBackdropClick) {
      onClose();
    }
  };

  if (!isOpen) {
    console.log('🔍 Modal: isOpen is false, returning null');
    return null;
  }

  console.log('🔍 Modal: About to render modal content', {
    size,
    hasTitle: !!title,
    showCloseButton,
    closeOnBackdropClick,
    timestamp: new Date().toISOString()
  });

  const sizeClasses = {
    sm: 'max-w-md',
    md: 'max-w-lg',
    lg: 'max-w-2xl',
    xl: 'max-w-4xl',
  };

  const modalContent = (
    <div
      className="fixed inset-0 z-50 overflow-y-auto"
      ref={(node) => {
        if (node) {
          console.log('🔍 Modal: Modal root node created', {
            node,
            className: node.className,
            computedStyle: window.getComputedStyle(node).cssText
          });
        }
      }}
    >
      <div className="flex min-h-full items-center justify-center p-4">
        {/* Backdrop */}
        <div
          className="fixed inset-0 bg-black bg-opacity-50 transition-opacity"
          onClick={handleBackdropClick}
          ref={(node) => {
            if (node) {
              console.log('🔍 Modal: Backdrop node created', {
                node,
                className: node.className,
                computedStyle: window.getComputedStyle(node).cssText
              });
            }
          }}
        />
        
        {/* Modal */}
        <div
          ref={modalRef}
          className={clsx(
            'relative w-full transform rounded-lg bg-white dark:bg-gray-800 text-left shadow-xl transition-all',
            sizeClasses[size]
          )}
        >
          {/* Header */}
          {(title || showCloseButton) && (
            <div className="flex items-center justify-between border-b border-gray-200 dark:border-gray-700 px-6 py-4">
              {title && (
                <h3 className="text-lg font-medium text-gray-900 dark:text-white">
                  {title}
                </h3>
              )}
              
              {showCloseButton && (
                <button
                  onClick={onClose}
                  className="rounded-md text-gray-400 hover:text-gray-600 focus:outline-none focus:ring-2 focus:ring-blue-500 dark:hover:text-gray-300"
                >
                  <svg
                    className="h-6 w-6"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M6 18L18 6M6 6l12 12"
                    />
                  </svg>
                </button>
              )}
            </div>
          )}
          
          {/* Body */}
          <div className="px-6 py-4">
            {children}
          </div>
        </div>
      </div>
    </div>
  );

  console.log('🔍 Modal: About to render via portal', {
    hasPortalContainer: !!portalContainerRef.current,
    portalContainer: portalContainerRef.current,
    portalContainerChildren: portalContainerRef.current?.childNodes.length,
    isOpen,
    isRendered: isRenderedRef.current,
    timestamp: new Date().toISOString()
  });

  // Only render if we have a valid portal container and modal is open
  if (!portalContainerRef.current || !isOpen) {
    console.log('🔍 Modal: Not rendering - missing container or not open', {
      hasContainer: !!portalContainerRef.current,
      isOpen,
      isRendered: isRenderedRef.current,
      timestamp: new Date().toISOString()
    });
    return null;
  }

  // Use portal to render at document.body level
  const renderStartTime = Date.now();
  const portalResult = ReactDOM.createPortal(modalContent, portalContainerRef.current);
  const renderEndTime = Date.now();
  
  console.log('🔍 Modal: Portal render completed', {
    portalResult: !!portalResult,
    portalContainerChildrenAfter: portalContainerRef.current?.childNodes.length,
    renderDuration: renderEndTime - renderStartTime,
    timestamp: new Date().toISOString()
  });

  // Debug: Check if modal is actually in DOM after render
  setTimeout(() => {
    if (portalContainerRef.current && isRenderedRef.current) {
      const modalElements = portalContainerRef.current.querySelectorAll('[class*="fixed"], [class*="modal"]');
      console.log('🔍 Modal: DOM check after render', {
        modalElements: modalElements.length,
        portalContainerHTML: portalContainerRef.current.innerHTML.substring(0, 200) + '...',
        portalContainerVisible: portalContainerRef.current.offsetParent !== null,
        portalContainerStyles: window.getComputedStyle(portalContainerRef.current).cssText,
        isRendered: isRenderedRef.current,
        timestamp: new Date().toISOString()
      });
    } else {
      console.log('🔍 Modal: DOM check skipped - no container or not rendered', {
        hasContainer: !!portalContainerRef.current,
        isRendered: isRenderedRef.current,
        timestamp: new Date().toISOString()
      });
    }
  }, 100);

  return portalResult;
};

interface ModalFooterProps {
  children: React.ReactNode;
  className?: string;
}

export const ModalFooter: React.FC<ModalFooterProps> = ({
  children,
  className,
}) => {
  return (
    <div className={clsx('border-t border-gray-200 dark:border-gray-700 px-6 py-4', className)}>
      <div className="flex justify-end space-x-3">
        {children}
      </div>
    </div>
  );
};