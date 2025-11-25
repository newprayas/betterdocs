import React from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import { Message, Citation } from '../../types';
import { CitationPanel } from './CitationPanel';
import { MessageSender } from '../../types';
import { formatTime } from '../../utils/date';
import { IndentationAnalyzer } from '../../utils/indentationAnalyzer';
import clsx from 'clsx';

interface MessageBubbleProps {
  message: Message;
  isStreaming?: boolean;
  className?: string;
}

export const MessageBubble: React.FC<MessageBubbleProps> = ({
  message,
  isStreaming = false,
  className,
}) => {
  const isUser = message.role === 'user';
  
  // Process message content to add Vancouver style citation references
  const processMessageContent = (content: string, citations?: Citation[]) => {
    const timestamp = new Date().toISOString();
    
    if (!citations || citations.length === 0 || isUser) {
      console.log(`[${timestamp}] [INDENTATION DEBUG] MESSAGEBUBBLE:`, 'Skipping content processing - no citations or user message');
      return content;
    }
    
    // Create a map of citation indices by page for reference
    const citationMap = new Map<number, Citation>();
    citations.forEach((citation, index) => {
      citationMap.set(index + 1, citation);
    });
    
    // Replace citation placeholders with Vancouver style references
    // This assumes the message content contains placeholders like [citation:X]
    let processedContent = content;
    
    // Replace [citation:X] patterns with [X] where X is the citation number
    processedContent = processedContent.replace(/\[citation:(\d+)\]/g, (match, num) => {
      const citationNum = parseInt(num);
      return citationMap.has(citationNum) ? `[${citationNum}]` : match;
    });
    
    // Also handle any remaining [citation] patterns by numbering them sequentially
    let citationCounter = 1;
    processedContent = processedContent.replace(/\[citation\]/g, () => {
      return `[${citationCounter++}]`;
    });
    
    return processedContent;
  };

  const processedContent = processMessageContent(message.content, message.citations);
  
  // Comprehensive logging of markdown content processing
  const timestamp = new Date().toISOString();
  console.log(`\n=== [${timestamp}] [INDENTATION DEBUG] MESSAGEBUBBLE START ===`);
  console.log(`[${timestamp}] [INDENTATION DEBUG] MESSAGEBUBBLE:`, {
    isUser,
    messageId: message.id,
    originalContentLength: message.content.length,
    processedContentLength: processedContent.length,
    hasCitations: message.citations && message.citations.length > 0,
    citationCount: message.citations?.length || 0
  });
  
  // Analyze original content structure
  console.log(`[${timestamp}] [INDENTATION DEBUG] MESSAGEBUBBLE: ANALYZING ORIGINAL CONTENT:`);
  IndentationAnalyzer.logMarkdownStructure(message.content);
  const originalAnalysis = IndentationAnalyzer.analyzeIndentation(message.content);
  
  // Analyze processed content structure
  console.log(`[${timestamp}] [INDENTATION DEBUG] MESSAGEBUBBLE: ANALYZING PROCESSED CONTENT:`);
  IndentationAnalyzer.logMarkdownStructure(processedContent);
  const processedAnalysis = IndentationAnalyzer.analyzeIndentation(processedContent);
  
  // Check for nested structures
  const originalHasNested = IndentationAnalyzer.detectNestedLists(message.content);
  const processedHasNested = IndentationAnalyzer.detectNestedLists(processedContent);
  
  console.log(`[${timestamp}] [INDENTATION DEBUG] MESSAGEBUBBLE: NESTED STRUCTURE ANALYSIS:`, {
    originalHasNested,
    processedHasNested,
    nestedStructuresPreserved: originalHasNested === processedHasNested,
    originalIndentedLines: originalAnalysis.indentedLines,
    processedIndentedLines: processedAnalysis.indentedLines,
    originalMaxIndent: originalAnalysis.maxIndentLevel,
    processedMaxIndent: processedAnalysis.maxIndentLevel
  });
  
  // Create visualization of content structure
  console.log(`[${timestamp}] [INDENTATION DEBUG] MESSAGEBUBBLE: ORIGINAL CONTENT VISUALIZATION:`);
  IndentationAnalyzer.visualizeIndentation(message.content);
  
  console.log(`[${timestamp}] [INDENTATION DEBUG] MESSAGEBUBBLE: PROCESSED CONTENT VISUALIZATION:`);
  IndentationAnalyzer.visualizeIndentation(processedContent);
  
  // Additional detailed analysis
  const hasNewlines = processedContent.includes('\n');
  const newlineCount = (processedContent.match(/\n/g) || []).length;
  const bulletCount = (processedContent.match(/^\* /gm) || []).length;
  const nestedBulletCount = (processedContent.match(/^[ \t]+\* /gm) || []).length;
  const firstFewLines = processedContent.split('\n').slice(0, 5);
  
  console.log(`[${timestamp}] [INDENTATION DEBUG] MESSAGEBUBBLE: DETAILED ANALYSIS:`, {
    hasNewlines,
    newlineCount,
    bulletCount,
    nestedBulletCount,
    hasNestedBullets: nestedBulletCount > 0,
    firstFewLines,
    rawCharCodes: Array.from(processedContent.substring(0, 100)).map(c => `${c}(${c.charCodeAt(0)})`).join(' '),
    containsListMarkers: processedContent.includes('* ') || processedContent.includes('- ') || processedContent.match(/^\d+\. /gm),
    startsWithBullet: processedContent.trim().startsWith('* ') || processedContent.trim().startsWith('- ') || processedContent.trim().match(/^\d+\. /)
  });

  return (
    <div className={clsx(
      'flex gap-2 sm:gap-3 mb-3 sm:mb-4',
      isUser ? 'justify-end' : 'justify-start',
      className
    )}>
      {/* Avatar */}
      {!isUser && (
        <div className="flex-shrink-0">
          <div className="w-7 h-7 sm:w-8 sm:h-8 bg-blue-500 rounded-full flex items-center justify-center">
            <svg
              className="w-4 h-4 sm:w-5 sm:h-5 text-white"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"
              />
            </svg>
          </div>
        </div>
      )}

      {/* Message Content */}
      <div className={clsx(
        'max-w-[85%] sm:max-w-xs lg:max-w-md xl:max-w-lg',
        isUser && 'max-w-[85%] sm:max-w-xs lg:max-w-md'
      )}>
        <div className={clsx(
          'rounded-lg px-3 py-2 sm:px-4 sm:py-3',
          isUser
            ? 'bg-blue-500 text-white ml-auto'
            : 'bg-gray-100 dark:bg-gray-800 text-gray-900 dark:text-gray-100 border border-gray-200 dark:border-gray-700'
        )}>
          {/* Message Text */}
          <div className="prose prose-sm max-w-none dark:prose-invert">
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              rehypePlugins={[rehypeHighlight]}
              components={{
                // Custom components for markdown rendering
                code: ({ node, className, children, ...props }: any) => {
                  const match = /language-(\w+)/.exec(className || '');
                  return !props.inline && match ? (
                    <pre className={className}>
                      <code className={className} {...props}>
                        {children}
                      </code>
                    </pre>
                  ) : (
                    <code className={className} {...props}>
                      {children}
                    </code>
                  );
                },
                a: ({ href, children }) => (
                  <a
                    href={href}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-blue-500 hover:text-blue-600 underline"
                  >
                    {children}
                  </a>
                ),
                // NEW: Custom handling for Unordered Lists to ensure indentation
                ul: ({ node, className, children, ...props }) => {
                  const timestamp = new Date().toISOString();
                  console.log(`[${timestamp}] [INDENTATION DEBUG] MESSAGEBUBBLE: RENDERING UL COMPONENT:`, {
                    hasChildren: !!children,
                    childCount: React.Children.count(children),
                    className,
                    appliedClassName: "pl-6 my-2 space-y-1 list-outside" // REMOVED "list-disc" to allow CSS to handle nested bullet styles
                  });
                  return (
                    <ul
                      className={clsx("pl-6 my-2 space-y-1 list-outside", className)} // REMOVED "list-disc" and INCREASED "pl-5" to "pl-6"
                      {...props}
                    >
                      {children}
                    </ul>
                  );
                },
                // NEW: Custom handling for List Items
                li: ({ node, className, children, ...props }) => {
                  const timestamp = new Date().toISOString();
                  const childText = React.Children.toArray(children).join('').substring(0, 50);
                  console.log(`[${timestamp}] [INDENTATION DEBUG] MESSAGEBUBBLE: RENDERING LI COMPONENT:`, {
                    childText: childText + (childText.length >= 50 ? '...' : ''),
                    hasChildren: !!children,
                    childCount: React.Children.count(children),
                    className,
                    appliedClassName: "pl-1 marker:text-gray-500 dark:marker:text-gray-400",
                    nodeProperties: node ? Object.keys(node) : 'no node'
                  });
                  return (
                    <li
                      className={clsx("pl-1 marker:text-gray-500 dark:marker:text-gray-400", className)}
                      {...props}
                    >
                      {children}
                    </li>
                  );
                },
                // Custom component to handle citation references
                span: ({ node, className, children, ...props }: any) => {
                  // Check if this is a citation reference
                  const text = typeof children === 'string' ? children : '';
                  const citationMatch = text.match(/^\[(\d+)\]$/);
                  
                  if (citationMatch && !isUser) {
                    const citationNum = parseInt(citationMatch[1]);
                    return (
                      <span
                        className={`citation-ref ${className || ''}`}
                        title={`Citation ${citationNum}`}
                        {...props}
                      >
                        {citationNum}
                      </span>
                    );
                  }
                  
                  return (
                    <span className={className} {...props}>
                      {children}
                    </span>
                  );
                },
              }}
            >
              {processedContent}
            </ReactMarkdown>
            
            {/* Log after ReactMarkdown rendering */}
            {(() => {
              const timestamp = new Date().toISOString();
              console.log(`[${timestamp}] [INDENTATION DEBUG] MESSAGEBUBBLE: REACTMARKDOWN RENDERING COMPLETE`);
              console.log(`[${timestamp}] [INDENTATION DEBUG] MESSAGEBUBBLE: CUSTOM COMPONENTS APPLIED:`, {
                ulComponentApplied: true,
                liComponentApplied: true,
                citationComponentApplied: true,
                codeComponentApplied: true,
                linkComponentApplied: true
              });
              console.log(`=== [${timestamp}] [INDENTATION DEBUG] MESSAGEBUBBLE END ===\n`);
              return null;
            })()}
            
            {isStreaming && (
              <span className="inline-block w-2 h-4 bg-gray-400 dark:bg-gray-600 animate-pulse ml-1" />
            )}
          </div>

          {/* Citations */}
          {message.citations && message.citations.length > 0 && !isUser && (
            <div className="mt-3 pt-3 border-t border-gray-200 dark:border-gray-700">
              <CitationPanel citations={message.citations} />
            </div>
          )}
        </div>

        {/* Timestamp */}
        <div className={clsx(
          'text-xs text-gray-500 dark:text-gray-400 mt-1',
          isUser ? 'text-right' : 'text-left'
        )}>
          {formatTime(message.timestamp || new Date())}
        </div>
      </div>

      {/* User Avatar */}
      {isUser && (
        <div className="flex-shrink-0">
          <div className="w-7 h-7 sm:w-8 sm:h-8 bg-gray-500 rounded-full flex items-center justify-center">
            <svg
              className="w-4 h-4 sm:w-5 sm:h-5 text-white"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z"
              />
            </svg>
          </div>
        </div>
      )}
    </div>
  );
};

// Streaming message bubble component
export const StreamingMessageBubble: React.FC<{
  content: string;
  citations?: any[];
  className?: string;
}> = ({ content, citations, className }) => {
  const streamingMessage: Message = {
    id: 'streaming',
    sessionId: '',
    content,
    role: MessageSender.ASSISTANT,
    timestamp: new Date(),
    citations,
  };

  return (
    <MessageBubble
      message={streamingMessage}
      isStreaming={true}
      className={className}
    />
  );
};