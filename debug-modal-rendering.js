// Debug script to analyze modal rendering issues
// Run this in the browser console when the app is loaded

console.log('🔍 Modal Debug Script: Starting analysis');

// 1. Check if React and ReactDOM are available
console.log('🔍 Checking React/ReactDOM availability:', {
  React: typeof window.React !== 'undefined',
  ReactDOM: typeof window.ReactDOM !== 'undefined',
  createPortal: typeof window.ReactDOM?.createPortal === 'function'
});

// 2. Check for modal portal containers
function checkModalPortals() {
  const portalContainers = document.querySelectorAll('[data-modal-portal]');
  console.log('🔍 Modal portal containers found:', {
    count: portalContainers.length,
    containers: Array.from(portalContainers).map(container => ({
      element: container,
      innerHTML: container.innerHTML.substring(0, 200) + '...',
      styles: window.getComputedStyle(container).cssText,
      visible: container.offsetParent !== null,
      children: container.children.length,
      computedDisplay: window.getComputedStyle(container).display,
      computedVisibility: window.getComputedStyle(container).visibility,
      computedOpacity: window.getComputedStyle(container).opacity,
      computedZIndex: window.getComputedStyle(container).zIndex
    }))
  });
  
  return portalContainers;
}

// 3. Check for any modal-like elements in the DOM
function checkModalElements() {
  const modalSelectors = [
    '[class*="modal"]',
    '[class*="Modal"]',
    '[class*="fixed"][class*="inset-0"]',
    '[role="dialog"]',
    '[aria-modal="true"]'
  ];
  
  const modalElements = [];
  modalSelectors.forEach(selector => {
    const elements = document.querySelectorAll(selector);
    if (elements.length > 0) {
      modalElements.push(...Array.from(elements));
    }
  });
  
  console.log('🔍 Modal-like elements found:', {
    count: modalElements.length,
    elements: modalElements.map(element => ({
      element: element,
      className: element.className,
      tagName: element.tagName,
      innerHTML: element.innerHTML.substring(0, 100) + '...',
      styles: window.getComputedStyle(element).cssText,
      visible: element.offsetParent !== null,
      computedDisplay: window.getComputedStyle(element).display,
      computedVisibility: window.getComputedStyle(element).visibility,
      computedOpacity: window.getComputedStyle(element).opacity,
      computedZIndex: window.getComputedStyle(element).zIndex,
      position: window.getComputedStyle(element).position,
      top: window.getComputedStyle(element).top,
      left: window.getComputedStyle(element).left,
      width: element.offsetWidth,
      height: element.offsetHeight
    }))
  });
  
  return modalElements;
}

// 4. Check body and document styles that might affect modal rendering
function checkDocumentStyles() {
  console.log('🔍 Document styles analysis:', {
    body: {
      overflow: window.getComputedStyle(document.body).overflow,
      position: window.getComputedStyle(document.body).position,
      transform: window.getComputedStyle(document.body).transform,
      filter: window.getComputedStyle(document.body).filter,
      pointerEvents: window.getComputedStyle(document.body).pointerEvents
    },
    html: {
      overflow: window.getComputedStyle(document.documentElement).overflow,
      position: window.getComputedStyle(document.documentElement).position
    },
    root: {
      element: document.getElementById('root'),
      styles: document.getElementById('root') ? window.getComputedStyle(document.getElementById('root')).cssText : 'not found'
    }
  });
}

// 5. Check for any CSS that might be hiding modals
function checkCSSOverrides() {
  const styleSheets = Array.from(document.styleSheets);
  const modalHidingRules = [];
  
  styleSheets.forEach((sheet, sheetIndex) => {
    try {
      const rules = Array.from(sheet.cssRules || []);
      rules.forEach((rule, ruleIndex) => {
        if (rule.cssText && (
          rule.cssText.includes('display: none') ||
          rule.cssText.includes('visibility: hidden') ||
          rule.cssText.includes('opacity: 0') ||
          rule.cssText.includes('z-index') ||
          rule.cssText.includes('modal') ||
          rule.cssText.includes('fixed') ||
          rule.cssText.includes('position')
        )) {
          modalHidingRules.push({
            sheetIndex,
            ruleIndex,
            cssText: rule.cssText,
            selectorText: rule.selectorText
          });
        }
      });
    } catch (e) {
      console.log(`Could not access stylesheet ${sheetIndex}:`, e);
    }
  });
  
  console.log('🔍 Potentially problematic CSS rules:', modalHidingRules);
  return modalHidingRules;
}

// 6. Check viewport and scroll position
function checkViewport() {
  console.log('🔍 Viewport analysis:', {
    windowWidth: window.innerWidth,
    windowHeight: window.innerHeight,
    scrollX: window.scrollX,
    scrollY: window.scrollY,
    documentHeight: document.documentElement.scrollHeight,
    documentWidth: document.documentElement.scrollWidth
  });
}

// 7. Test creating a modal directly
function testDirectModal() {
  console.log('🔍 Testing direct modal creation');
  
  const testModal = document.createElement('div');
  testModal.style.cssText = `
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    background-color: rgba(255, 0, 0, 0.5);
    z-index: 999999;
    display: flex;
    align-items: center;
    justify-content: center;
    color: white;
    font-size: 24px;
    font-weight: bold;
  `;
  testModal.textContent = 'TEST MODAL - If you see this, modals can render!';
  testModal.id = 'debug-test-modal';
  
  document.body.appendChild(testModal);
  
  setTimeout(() => {
    const element = document.getElementById('debug-test-modal');
    console.log('🔍 Direct modal test result:', {
      created: !!element,
      visible: element ? element.offsetParent !== null : false,
      styles: element ? window.getComputedStyle(element).cssText : 'not found',
      rect: element ? element.getBoundingClientRect() : 'not found'
    });
    
    if (element) {
      element.remove();
    }
  }, 2000);
}

// Run all checks
function runFullAnalysis() {
  console.log('🔍 ===== STARTING FULL MODAL ANALYSIS =====');
  
  checkModalPortals();
  checkModalElements();
  checkDocumentStyles();
  checkCSSOverrides();
  checkViewport();
  testDirectModal();
  
  console.log('🔍 ===== FULL MODAL ANALYSIS COMPLETE =====');
  
  // Return a summary object
  return {
    portals: checkModalPortals().length,
    modalElements: checkModalElements().length,
    timestamp: new Date().toISOString()
  };
}

// Auto-run analysis
window.debugModalAnalysis = runFullAnalysis;

// Also run it immediately
runFullAnalysis();

console.log('🔍 Modal Debug Script: Analysis complete. Run window.debugModalAnalysis() to re-run.');