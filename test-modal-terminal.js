#!/usr/bin/env node

/**
 * Terminal-based Modal Testing Script
 * 
 * This script automates the debugging process for modal rendering issues.
 * It analyzes the Modal component implementation, checks for common issues,
 * and provides a comprehensive report of findings.
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// ANSI color codes for better output
const colors = {
  reset: '\x1b[0m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  white: '\x1b[37m'
};

// Helper function to print colored output
function print(color, text) {
  console.log(`${colors[color]}${text}${colors.reset}`);
}

// Helper function to print section headers
function printHeader(title) {
  print('cyan', '\n' + '='.repeat(60));
  print('cyan', `  ${title}`);
  print('cyan', '='.repeat(60));
}

// Helper function to print success/error/warning messages
function printSuccess(message) {
  print('green', `✅ ${message}`);
}

function printError(message) {
  print('red', `❌ ${message}`);
}

function printWarning(message) {
  print('yellow', `⚠️  ${message}`);
}

function printInfo(message) {
  print('blue', `ℹ️  ${message}`);
}

// Check if development server is running
function checkDevServer() {
  printHeader('Checking Development Server');
  
  try {
    const response = execSync('curl -s -o /dev/null -w "%{http_code}" http://localhost:3000', { timeout: 5000 });
    const statusCode = response.toString().trim();
    if (statusCode === '200' || statusCode === '307' || statusCode === '302') {
      printSuccess('Development server is running and accessible');
      return true;
    } else {
      printWarning(`Development server responded with code: ${statusCode}`);
      return false;
    }
  } catch (error) {
    printError('Development server is not running or not accessible');
    printInfo('Starting development server...');
    try {
      execSync('npm run dev', { stdio: 'inherit', detached: true });
      printSuccess('Development server started');
      return true;
    } catch (startError) {
      printError('Failed to start development server');
      return false;
    }
  }
}

// Analyze Modal component implementation
function analyzeModalComponent() {
  printHeader('Analyzing Modal Component Implementation');
  
  const modalPath = path.join(__dirname, 'src/components/ui/Modal.tsx');
  
  if (!fs.existsSync(modalPath)) {
    printError('Modal.tsx file not found');
    return false;
  }
  
  const modalContent = fs.readFileSync(modalPath, 'utf8');
  const issues = [];
  const suggestions = [];
  
  // Check for React imports
  if (!modalContent.includes('import React')) {
    issues.push('Missing React import');
  } else {
    printSuccess('React import found');
  }
  
  // Check for ReactDOM import
  if (!modalContent.includes('import ReactDOM')) {
    issues.push('Missing ReactDOM import for portal rendering');
  } else {
    printSuccess('ReactDOM import found for portal rendering');
  }
  
  // Check for portal usage
  if (!modalContent.includes('createPortal')) {
    issues.push('Modal does not use ReactDOM.createPortal');
  } else {
    printSuccess('Modal uses ReactDOM.createPortal');
  }
  
  // Check for proper z-index
  if (!modalContent.includes('z-50') && !modalContent.includes('z-index:')) {
    issues.push('Modal may not have proper z-index');
    suggestions.push('Consider adding z-50 or higher z-index');
  } else {
    printSuccess('Modal has z-index styling');
  }
  
  // Check for fixed positioning
  if (!modalContent.includes('position: fixed') && !modalContent.includes('fixed inset-0')) {
    issues.push('Modal may not use fixed positioning');
  } else {
    printSuccess('Modal uses fixed positioning');
  }
  
  // Check for backdrop implementation
  if (!modalContent.includes('bg-opacity-50') && !modalContent.includes('backgroundColor')) {
    issues.push('Modal may not have a backdrop');
  } else {
    printSuccess('Modal has backdrop implementation');
  }
  
  // Check for escape key handling
  if (!modalContent.includes('keydown') || !modalContent.includes('Escape')) {
    issues.push('Modal may not handle escape key');
    suggestions.push('Add escape key handler for better UX');
  } else {
    printSuccess('Modal handles escape key');
  }
  
  // Check for body scroll lock
  if (!modalContent.includes('overflow') || (!modalContent.includes('overflow: hidden') && !modalContent.includes('overflow-hidden') && !modalContent.includes('overflow = \'hidden\'') && !modalContent.includes('body.style.overflow'))) {
    issues.push('Modal may not lock body scroll');
    suggestions.push('Add body scroll lock when modal is open');
  } else {
    printSuccess('Modal locks body scroll');
  }
  
  // Check for proper cleanup
  if (!modalContent.includes('useEffect') || !modalContent.includes('return () =>')) {
    issues.push('Modal may not properly clean up side effects');
  } else {
    printSuccess('Modal has cleanup logic');
  }
  
  // Report issues and suggestions
  if (issues.length > 0) {
    printError(`Found ${issues.length} issues:`);
    issues.forEach(issue => printError(`  - ${issue}`));
  }
  
  if (suggestions.length > 0) {
    printWarning(`Suggestions:`);
    suggestions.forEach(suggestion => printWarning(`  - ${suggestion}`));
  }
  
  return issues.length === 0;
}

// Analyze CSS conflicts
function analyzeCSSConflicts() {
  printHeader('Analyzing CSS Conflicts');
  
  const cssFiles = [
    'src/styles/globals.css',
    'src/styles/mobile-touch.css',
    'tailwind.config.js'
  ];
  
  const issues = [];
  
  cssFiles.forEach(file => {
    const filePath = path.join(__dirname, file);
    if (fs.existsSync(filePath)) {
      const content = fs.readFileSync(filePath, 'utf8');
      
      // Check for z-index conflicts
      if (content.includes('z-index') && content.includes('9999')) {
        printWarning(`High z-index values found in ${file}`);
      }
      
      // Check for overflow hidden on body
      if (file.includes('globals.css') && !content.includes('body')) {
        issues.push(`No body styles found in ${file}`);
      }
      
      // Check for position fixed conflicts
      if (content.includes('position: fixed') && !content.includes('z-index')) {
        issues.push(`Fixed positioning without z-index in ${file}`);
      }
    } else {
      printWarning(`File not found: ${file}`);
    }
  });
  
  if (issues.length === 0) {
    printSuccess('No major CSS conflicts detected');
  } else {
    issues.forEach(issue => printError(issue));
  }
  
  return issues.length === 0;
}

// Check React Portal implementation
function checkPortalImplementation() {
  printHeader('Checking React Portal Implementation');
  
  const modalPath = path.join(__dirname, 'src/components/ui/Modal.tsx');
  const modalContent = fs.readFileSync(modalPath, 'utf8');
  
  const portalChecks = {
    hasPortalImport: modalContent.includes('import ReactDOM'),
    hasCreatePortal: modalContent.includes('createPortal'),
    hasPortalContainer: modalContent.includes('createElement'),
    hasPortalCleanup: modalContent.includes('removeChild'),
    hasPortalToBody: modalContent.includes('document.body')
  };
  
  Object.entries(portalChecks).forEach(([check, passed]) => {
    if (passed) {
      printSuccess(`${check.replace(/([A-Z])/g, ' $1').trim()}`);
    } else {
      printError(`${check.replace(/([A-Z])/g, ' $1').trim()} missing`);
    }
  });
  
  // Check TestModal implementation
  const testModalPath = path.join(__dirname, 'src/components/ui/TestModal.tsx');
  if (fs.existsSync(testModalPath)) {
    printSuccess('TestModal component exists');
    const testModalContent = fs.readFileSync(testModalPath, 'utf8');
    
    if (testModalContent.includes('createPortal')) {
      printSuccess('TestModal uses createPortal');
    } else {
      printError('TestModal does not use createPortal');
    }
  } else {
    printWarning('TestModal component not found');
  }
  
  return Object.values(portalChecks).every(Boolean);
}

// Generate comprehensive report
function generateReport(results) {
  printHeader('Modal Debugging Report');
  
  const report = {
    timestamp: new Date().toISOString(),
    summary: {
      totalChecks: Object.keys(results).length,
      passed: Object.values(results).filter(Boolean).length,
      failed: Object.values(results).filter(v => !v).length
    },
    details: results
  };
  
  printInfo('Summary:');
  printInfo(`  Total Checks: ${report.summary.totalChecks}`);
  printSuccess(`  Passed: ${report.summary.passed}`);
  printError(`  Failed: ${report.summary.failed}`);
  
  // Save report to file
  const reportPath = path.join(__dirname, 'modal-debug-report.json');
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  printInfo(`\nDetailed report saved to: ${reportPath}`);
  
  // Recommendations
  printHeader('Recommendations');
  
  if (!results.devServer) {
    printWarning('1. Ensure development server is running before testing modals');
  }
  
  if (!results.modalComponent) {
    printWarning('2. Fix Modal component implementation issues');
  }
  
  if (!results.cssConflicts) {
    printWarning('3. Resolve CSS conflicts that might affect modal rendering');
  }
  
  if (!results.portalImplementation) {
    printWarning('4. Fix React Portal implementation');
  }
  
  printSuccess('5. Test the modal manually in browser after fixing issues');
  printInfo('   - Open http://localhost:3000');
  printInfo('   - Try to open a modal');
  printInfo('   - Check browser console for debug messages');
  
  return report;
}

// Main execution function
function main() {
  print('magenta', '\n🔍 Modal Debugging Terminal Script');
  print('magenta', '=====================================\n');
  
  const results = {};
  
  // Run all checks
  results.devServer = checkDevServer();
  results.modalComponent = analyzeModalComponent();
  results.cssConflicts = analyzeCSSConflicts();
  results.portalImplementation = checkPortalImplementation();
  
  // Generate report
  const report = generateReport(results);
  
  // Exit with appropriate code
  const exitCode = Object.values(results).every(Boolean) ? 0 : 1;
  
  if (exitCode === 0) {
    printSuccess('\n🎉 All checks passed! Modal implementation looks good.');
  } else {
    printError('\n💥 Some checks failed. Please review the issues above.');
  }
  
  process.exit(exitCode);
}

// Run the script
if (require.main === module) {
  main();
}

module.exports = {
  checkDevServer,
  analyzeModalComponent,
  analyzeCSSConflicts,
  checkPortalImplementation,
  generateReport
};