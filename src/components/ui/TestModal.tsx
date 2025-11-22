import React, { useEffect, useRef } from 'react';
import ReactDOM from 'react-dom';

interface TestModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export const TestModal: React.FC<TestModalProps> = ({ isOpen, onClose }) => {
  const modalRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    console.log('🔍 TestModal: isOpen changed', { isOpen });
    
    if (isOpen && modalRef.current) {
      console.log('🔍 TestModal: Modal mounted, checking visibility', {
        node: modalRef.current,
        offsetWidth: modalRef.current.offsetWidth,
        offsetHeight: modalRef.current.offsetHeight,
        offsetParent: modalRef.current.offsetParent,
        visibility: window.getComputedStyle(modalRef.current).visibility,
        display: window.getComputedStyle(modalRef.current).display,
        opacity: window.getComputedStyle(modalRef.current).opacity,
        position: window.getComputedStyle(modalRef.current).position,
        zIndex: window.getComputedStyle(modalRef.current).zIndex,
        computedStyle: window.getComputedStyle(modalRef.current).cssText
      });
    }
  }, [isOpen]);

  if (!isOpen) {
    console.log('🔍 TestModal: isOpen is false, returning null');
    return null;
  }

  console.log('🔍 TestModal: About to render test modal');

  const modalContent = (
    <div 
      ref={modalRef}
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        backgroundColor: 'rgba(0, 0, 0, 0.5)',
        zIndex: 99999,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        visibility: 'visible',
        opacity: 1
      }}
      onClick={onClose}
    >
      <div 
        style={{
          backgroundColor: 'white',
          padding: '20px',
          borderRadius: '8px',
          maxWidth: '400px',
          width: '90%',
          position: 'relative',
          zIndex: 100000
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <h2 style={{ color: 'black', marginBottom: '10px' }}>Test Modal</h2>
        <p style={{ color: 'black', marginBottom: '20px' }}>This is a test modal to check if modals can render at all.</p>
        <button 
          onClick={onClose}
          style={{
            backgroundColor: '#3b82f6',
            color: 'white',
            border: 'none',
            padding: '8px 16px',
            borderRadius: '4px',
            cursor: 'pointer'
          }}
        >
          Close
        </button>
      </div>
    </div>
  );

  console.log('🔍 TestModal: About to render via createPortal');
  
  // Render directly to document.body without creating a separate container
  return ReactDOM.createPortal(modalContent, document.body);
};

// Hook for testing the modal
export const useTestModal = () => {
  const [isOpen, setIsOpen] = React.useState(false);

  const openModal = () => {
    console.log('🔍 useTestModal: Opening test modal');
    setIsOpen(true);
  };

  const closeModal = () => {
    console.log('🔍 useTestModal: Closing test modal');
    setIsOpen(false);
  };

  const TestModalComponent = () => <TestModal isOpen={isOpen} onClose={closeModal} />;

  return {
    openModal,
    closeModal,
    TestModal: TestModalComponent,
    isOpen
  };
};