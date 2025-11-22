// Test script to verify confirmation dialog fix
// Run this in browser console after navigating to a session with documents

console.log('🧪 Starting Confirmation Dialog Test...');

// Find all document cards
const documentCards = document.querySelectorAll('[data-testid="document-card"]');
if (documentCards.length === 0) {
  // Try alternative selectors
  const altCards = document.querySelectorAll('.card, .document-card');
  console.log(`📄 Found ${altCards.length} potential document cards using alternative selectors`);
} else {
  console.log(`📄 Found ${documentCards.length} document cards`);
}

// Find delete buttons
const deleteButtons = document.querySelectorAll('button[aria-label*="delete"], button:has(svg[d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"]');
console.log(`🗑️ Found ${deleteButtons.length} delete buttons`);

if (deleteButtons.length > 0) {
  // Click the first delete button
  const firstDeleteBtn = deleteButtons[0];
  console.log('🖱️ Clicking first delete button...');
  
  // Monitor for modal portal creation
  const observer = new MutationObserver((mutations) => {
    mutations.forEach((mutation) => {
      if (mutation.type === 'childList') {
        mutation.addedNodes.forEach((node) => {
          if (node.nodeType === Node.ELEMENT_NODE) {
            const element = node;
            if (element.hasAttribute && element.hasAttribute('data-modal-portal')) {
              console.log('✅ Modal portal detected in DOM!', element);
              
              // Check if modal is visible
              const modalContent = element.querySelector('.fixed.inset-0');
              if (modalContent) {
                const styles = window.getComputedStyle(modalContent);
                console.log('👁️ Modal visibility check:', {
                  display: styles.display,
                  visibility: styles.visibility,
                  opacity: styles.opacity,
                  zIndex: styles.zIndex,
                  position: styles.position
                });
              }
            }
          }
        });
      }
    });
  });
  
  observer.observe(document.body, {
    childList: true,
    subtree: true
  });
  
  // Click the delete button
  firstDeleteBtn.click();
  
  // Check for modal after a short delay
  setTimeout(() => {
    const modalPortal = document.querySelector('[data-modal-portal="true"]');
    if (modalPortal) {
      console.log('✅ Modal portal found after delay:', modalPortal);
      
      // Check modal content
      const modal = modalPortal.querySelector('.fixed.inset-0');
      if (modal) {
        const rect = modal.getBoundingClientRect();
        console.log('📐 Modal dimensions and position:', {
          width: rect.width,
          height: rect.height,
          top: rect.top,
          left: rect.left,
          isVisible: rect.width > 0 && rect.height > 0
        });
        
        // Check if modal is in viewport
        const isInViewport = (
          rect.top >= 0 &&
          rect.left >= 0 &&
          rect.bottom <= window.innerHeight &&
          rect.right <= window.innerWidth
        );
        console.log('🖼️ Modal in viewport:', isInViewport);
      }
    } else {
      console.log('❌ No modal portal found after delay');
      
      // Check for any modal-like elements
      const anyModal = document.querySelector('[role="dialog"], .modal, [class*="modal"]');
      console.log('🔍 Any modal-like elements found:', anyModal);
    }
  }, 1000);
  
} else {
  console.log('❌ No delete buttons found. Make sure you have documents in the session.');
}

console.log('🧪 Test complete. Check the logs above for results.');