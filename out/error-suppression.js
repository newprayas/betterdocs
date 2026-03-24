// Error suppression script for development
// This script helps suppress common console errors during development

(function() {
  // Suppress common console errors that are not critical
  const originalConsoleError = console.error;
  
  console.error = function(...args) {
    // Filter out specific error messages that are known to be non-critical
    const errorMessage = args.join(' ');
    
    // List of error patterns to suppress
    const suppressPatterns = [
      /Warning.*Extra attributes from the server/,
      /Warning.*Prop `.*` did not match/,
      /Warning.*Each child in a list should have a unique "key" prop/,
      /Warning.*React does not recognize the `.*` prop on a DOM element/,
      /Warning.*Invalid DOM property `.*`/,
      /Warning.*Received `true` for a non-boolean attribute `.*`/,
      /Warning.*The tag.*is unrecognized in this browser/,
      /Warning.*component is.*text content/,
      /Warning.*Failed to get context/,
      /Warning.*findDOMNode is deprecated/,
      /Warning.*UNSAFE_*/,
      /Warning.*componentWillReceiveProps has been renamed/,
      /Warning.*componentWillUpdate has been renamed/,
      /Warning.*componentWillMount has been renamed/,
      // CSS selector errors from browser extensions trying to use Tailwind classes
      /Failed to execute 'querySelectorAll' on 'Document':.*dark\:hover:bg-.*is not a valid selector/,
      /Failed to execute 'querySelector' on 'Document':.*dark\:hover:bg-.*is not a valid selector/,
      /Failed to execute 'querySelectorAll' on 'Element':.*dark\:hover:bg-.*is not a valid selector/,
      /Failed to execute 'querySelector' on 'Element':.*dark\:hover:bg-.*is not a valid selector/
    ];
    
    // Check if the error message matches any suppress pattern
    const shouldSuppress = suppressPatterns.some(pattern => pattern.test(errorMessage));
    
    // Log suppressed errors at debug level instead
    if (shouldSuppress) {
      console.debug('[SUPPRESSED]', ...args);
      return;
    }
    
    // Log all other errors normally
    originalConsoleError.apply(console, args);
  };
  
  // Suppress specific warnings
  const originalConsoleWarn = console.warn;
  
  console.warn = function(...args) {
    const warningMessage = args.join(' ');
    
    const suppressPatterns = [
      /Warning.*component is changing an uncontrolled input/,
      /Warning.*A component is changing an uncontrolled input to be controlled/,
      /Warning.*You provided a `value` prop to a form field without an `onChange` handler/
    ];
    
    const shouldSuppress = suppressPatterns.some(pattern => pattern.test(warningMessage));
    
    if (shouldSuppress) {
      console.debug('[SUPPRESSED WARNING]', ...args);
      return;
    }
    
    originalConsoleWarn.apply(console, args);
  };
})();