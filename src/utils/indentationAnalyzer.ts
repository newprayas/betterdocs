/**
 * Indentation Analysis Utility
 * Helper functions to detect, analyze, and log indentation patterns in markdown text
 */

export interface IndentationAnalysis {
  totalLines: number;
  indentedLines: number;
  maxIndentLevel: number;
  indentPattern: string[];
  nestedListLevels: number[];
  hasNestedStructures: boolean;
  lineByLineAnalysis: LineAnalysis[];
}

export interface LineAnalysis {
  lineNumber: number;
  content: string;
  leadingSpaces: number;
  indentLevel: number;
  isListItem: boolean;
  isNested: boolean;
  bulletType: string | null;
}

export class IndentationAnalyzer {
  /**
   * Analyze indentation patterns in markdown text
   */
  static analyzeIndentation(text: string): IndentationAnalysis {
    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}] [INDENTATION ANALYZER] Starting analysis of ${text.length} characters`);
    
    const lines = text.split('\n');
    const lineAnalysis: LineAnalysis[] = [];
    const indentPattern: string[] = [];
    const nestedListLevels: number[] = [];
    let maxIndentLevel = 0;
    let indentedLines = 0;
    
    console.log(`[${timestamp}] [INDENTATION ANALYZER] Processing ${lines.length} lines`);
    
    lines.forEach((line, index) => {
      const analysis = this.analyzeLine(line, index + 1);
      lineAnalysis.push(analysis);
      
      if (analysis.leadingSpaces > 0) {
        indentedLines++;
        indentPattern.push(`${analysis.leadingSpaces} spaces`);
      }
      
      if (analysis.isNested) {
        nestedListLevels.push(analysis.indentLevel);
      }
      
      if (analysis.indentLevel > maxIndentLevel) {
        maxIndentLevel = analysis.indentLevel;
      }
      
      // Log detailed line analysis
      console.log(`[${timestamp}] [INDENTATION ANALYZER] Line ${index + 1}:`, {
        content: line.substring(0, 50) + (line.length > 50 ? '...' : ''),
        leadingSpaces: analysis.leadingSpaces,
        indentLevel: analysis.indentLevel,
        isListItem: analysis.isListItem,
        isNested: analysis.isNested,
        bulletType: analysis.bulletType,
        rawCharCodes: line.length > 0 ? Array.from(line.substring(0, 10)).map(c => `${c}(${c.charCodeAt(0)})`).join(' ') : 'EMPTY'
      });
    });
    
    const hasNestedStructures = nestedListLevels.length > 0 || maxIndentLevel > 0;
    
    const result: IndentationAnalysis = {
      totalLines: lines.length,
      indentedLines,
      maxIndentLevel,
      indentPattern,
      nestedListLevels,
      hasNestedStructures,
      lineByLineAnalysis: lineAnalysis
    };
    
    // Log summary analysis
    console.log(`[${timestamp}] [INDENTATION ANALYZER] Analysis complete:`, {
      totalLines: result.totalLines,
      indentedLines: result.indentedLines,
      maxIndentLevel: result.maxIndentLevel,
      hasNestedStructures: result.hasNestedStructures,
      nestedListLevelsCount: result.nestedListLevels.length,
      uniqueIndentLevels: [...new Set(result.nestedListLevels)],
      sampleNestedLines: lineAnalysis
        .filter(l => l.isNested)
        .map(l => `Line ${l.lineNumber}: "${l.content.substring(0, 30)}..."`)
        .slice(0, 5)
    });
    
    return result;
  }
  
  /**
   * Analyze a single line for indentation patterns
   */
  private static analyzeLine(line: string, lineNumber: number): LineAnalysis {
    const trimmed = line.trim();
    const leadingSpaces = line.length - line.trimStart().length;
    
    // Determine indent level (2 spaces = 1 level, but also account for 4 spaces)
    const indentLevel = Math.floor(leadingSpaces / 2);
    
    // Check if it's a list item
    const listItemPatterns = [
      /^\* /,      // * bullet
      /^- /,       // - bullet
      /^\+ /,      // + bullet
      /^\d+\. /,   // numbered list
      /^\w+\./     // lettered list
    ];
    
    const isListItem = listItemPatterns.some(pattern => pattern.test(trimmed));
    let bulletType: string | null = null;
    
    if (isListItem) {
      if (/^\* /.test(trimmed)) bulletType = 'asterisk';
      else if (/^- /.test(trimmed)) bulletType = 'dash';
      else if (/^\+ /.test(trimmed)) bulletType = 'plus';
      else if (/^\d+\. /.test(trimmed)) bulletType = 'numbered';
      else if (/^\w+\./.test(trimmed)) bulletType = 'lettered';
    }
    
    const isNested = leadingSpaces > 0 && isListItem;
    
    return {
      lineNumber,
      content: line,
      leadingSpaces,
      indentLevel,
      isListItem,
      isNested,
      bulletType
    };
  }
  
  /**
   * Detect if text contains properly nested markdown lists
   */
  static detectNestedLists(text: string): boolean {
    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}] [INDENTATION ANALYZER] Detecting nested lists`);
    
    const lines = text.split('\n');
    const listItems: { line: number; indent: number; content: string }[] = [];
    
    // Find all list items
    lines.forEach((line, index) => {
      const trimmed = line.trim();
      const leadingSpaces = line.length - line.trimStart().length;
      
      if (/^\* |^- |^\+ |^\d+\. |^\w+\./.test(trimmed)) {
        listItems.push({
          line: index + 1,
          indent: leadingSpaces,
          content: trimmed
        });
      }
    });
    
    console.log(`[${timestamp}] [INDENTATION ANALYZER] Found ${listItems.length} list items`);
    
    // Check for nested patterns
    let hasNested = false;
    for (let i = 1; i < listItems.length; i++) {
      const current = listItems[i];
      const previous = listItems[i - 1];
      
      if (current.indent > previous.indent) {
        hasNested = true;
        console.log(`[${timestamp}] [INDENTATION ANALYZER] Nested structure detected:`, {
          parentLine: previous.line,
          parentIndent: previous.indent,
          parentContent: previous.content.substring(0, 30),
          childLine: current.line,
          childIndent: current.indent,
          childContent: current.content.substring(0, 30),
          indentDifference: current.indent - previous.indent
        });
      }
    }
    
    console.log(`[${timestamp}] [INDENTATION ANALYZER] Nested list detection result: ${hasNested}`);
    return hasNested;
  }
  
  /**
   * Visualize indentation structure for debugging
   */
  static visualizeIndentation(text: string): string {
    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}] [INDENTATION ANALYZER] Creating indentation visualization`);
    
    const lines = text.split('\n');
    const visualization: string[] = [];
    
    lines.forEach((line, index) => {
      const trimmed = line.trim();
      const leadingSpaces = line.length - line.trimStart().length;
      const indentLevel = Math.floor(leadingSpaces / 2);
      
      // Create visual representation
      let visual = '';
      for (let i = 0; i < indentLevel; i++) {
        visual += '│  ';
      }
      
      if (trimmed.startsWith('* ')) {
        visual += '├── * ' + trimmed.substring(2);
      } else if (trimmed.startsWith('- ')) {
        visual += '├── - ' + trimmed.substring(2);
      } else if (trimmed.length > 0) {
        visual += '│   ' + trimmed;
      } else {
        visual += '    (empty line)';
      }
      
      visualization.push(`${(index + 1).toString().padStart(3)}: ${visual}`);
    });
    
    const result = visualization.join('\n');
    console.log(`[${timestamp}] [INDENTATION ANALYZER] Indentation visualization:\n${result}`);
    
    return result;
  }
  
  /**
   * Log markdown structure analysis
   */
  static logMarkdownStructure(text: string): void {
    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}] [INDENTATION ANALYZER] Starting markdown structure analysis`);
    
    // Basic counts
    const lineCount = text.split('\n').length;
    const bulletCount = (text.match(/^\* /gm) || []).length;
    const dashCount = (text.match(/^- /gm) || []).length;
    const numberedCount = (text.match(/^\d+\. /gm) || []).length;
    const newlineCount = (text.match(/\n/g) || []).length;
    
    // Indentation patterns
    const indentedLines = text.split('\n').filter(line => 
      line.length > line.trimStart().length
    ).length;
    
    // Nested patterns
    const nestedPatterns = text.match(/^[ \t]+\* /gm) || [];
    const nestedBulletCount = nestedPatterns.length;
    
    console.log(`[${timestamp}] [INDENTATION ANALYZER] Markdown structure analysis:`, {
      totalLines: lineCount,
      bulletCount,
      dashCount,
      numberedCount,
      newlineCount,
      indentedLines,
      nestedBulletCount,
      hasNestedLists: nestedBulletCount > 0,
      textPreview: text.substring(0, 200) + (text.length > 200 ? '...' : ''),
      containsListMarkers: text.includes('* ') || text.includes('- ') || text.match(/^\d+\. /gm),
      startsWithBullet: text.trim().startsWith('* ') || text.trim().startsWith('- ') || text.trim().match(/^\d+\. /)
    });
    
    // Analyze specific nested patterns
    if (nestedBulletCount > 0) {
      console.log(`[${timestamp}] [INDENTATION ANALYZER] Nested patterns found:`, {
        count: nestedBulletCount,
        samples: nestedPatterns.slice(0, 5).map(p => `"${p.trim()}"`),
        uniqueIndentLevels: [...new Set(nestedPatterns.map(p => p.length - p.trimStart().length))]
      });
    }
  }
}
