import React, { useEffect, useRef } from 'react';
import { MessageBubble } from './MessageBubble';
import { Loading } from '../ui/Loading';
import { ReadingSourcesLoader } from '../ui/ReadingSourcesLoader';
import { EmptyStates } from '../common/EmptyState';
import { useChatStore } from '../../store';
import { Message, MessageSender } from '../../types';
import { isToday, isYesterday, ensureDate } from '../../utils/date';

interface ChatListProps {
  sessionId: string;
  className?: string;
}

export const ChatList: React.FC<ChatListProps> = ({
  sessionId,
  className,
}) => {
  const { messages, loadMessages, isStreaming, streamingContent, streamingCitations, isReadingSources } = useChatStore();
  const isLoading = false; // TODO: Add loading state to chat store
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Load messages when session changes
  useEffect(() => {
    if (sessionId) {
      loadMessages(sessionId);
    }
  }, [sessionId, loadMessages]);

  // Auto-scroll to bottom when new messages arrive or streaming updates
  useEffect(() => {
    const scrollToBottom = () => {
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    };

    // Small delay to ensure content is rendered
    const timeoutId = setTimeout(scrollToBottom, 100);
    return () => clearTimeout(timeoutId);
  }, [messages, streamingContent]);

  // Handle scroll events for loading more messages (pagination)
  const handleScroll = () => {
    const container = containerRef.current;
    if (container && container.scrollTop === 0) {
      // At the top, could load more messages here
      // Future: Implement pagination for older messages
      console.log('Reached top - could load more messages');
    }
  };

  if (isLoading && messages.length === 0) {
    return (
      <div className={`flex items-center justify-center h-full ${className}`}>
        <Loading size="lg" text="Loading messages..." />
      </div>
    );
  }

  if (messages.length === 0) {
    return (
      <div className={`flex items-center justify-center h-full ${className}`}>
        <EmptyStates.NoMessages />
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      onScroll={handleScroll}
      className={`
        flex-1 overflow-y-auto px-3 sm:px-4 py-4 sm:py-6
        bg-gray-50 dark:bg-gray-900
        scrollbar-thin scrollbar-thumb-gray-300 dark:scrollbar-thumb-gray-600
        scrollbar-track-transparent
        touch-pan-y
        ${className}
      `}
    >
      <div className="max-w-4xl mx-auto space-y-1">
        {/* Group messages by date */}
        {messages.map((message, index) => {
          const prevMessage = messages[index - 1];
          const showDateDivider = shouldShowDateDivider(message, prevMessage);
          
          return (
            <React.Fragment key={message.id}>
              {showDateDivider && (
                <DateDivider date={message.timestamp || new Date()} />
              )}
              <MessageBubble message={message} />
            </React.Fragment>
          );
        })}

        {/* Reading sources loading indicator */}
        {isReadingSources && (
          <div className="flex justify-start mb-3 sm:mb-4">
            <div className="max-w-[85%] sm:max-w-xs lg:max-w-md xl:max-w-lg">
              <ReadingSourcesLoader />
            </div>
          </div>
        )}
        
        {/* Streaming message - only show if not reading sources */}
        {isStreaming && streamingContent && !isReadingSources && (
          <MessageBubble
            message={{
              id: 'streaming',
              sessionId,
              content: streamingContent,
              role: MessageSender.ASSISTANT,
              timestamp: new Date(),
              citations: streamingCitations,
            }}
            isStreaming={true}
          />
        )}
        
        {/* Invisible element for scroll targeting */}
        <div ref={messagesEndRef} />
      </div>
    </div>
  );
};

// Helper component for date dividers
interface DateDividerProps {
  date: Date | string | undefined | null;
}

const DateDivider: React.FC<DateDividerProps> = ({ date }) => {
  const dateObj = ensureDate(date);

  return (
    <div className="flex items-center justify-center my-3 sm:my-4">
      <div className="bg-gray-200 dark:bg-gray-700 text-gray-600 dark:text-gray-300 text-xs px-2 sm:px-3 py-1 rounded-full">
        {isToday(dateObj) ? 'Today' : isYesterday(dateObj) ? 'Yesterday' : dateObj.toLocaleDateString('en-US', {
          month: 'short',
          day: 'numeric',
          year: dateObj.getFullYear() !== new Date().getFullYear() ? 'numeric' : undefined,
        })}
      </div>
    </div>
  );
};

// Helper function to determine if we should show a date divider
const shouldShowDateDivider = (message: Message, prevMessage?: Message): boolean => {
  if (!prevMessage) return true;
  
  // Handle both Date and string timestamps using ensureDate
  const currentDate = ensureDate(message.timestamp);
  const prevDate = ensureDate(prevMessage.timestamp);
  
  // Show divider if messages are from different days
  return currentDate.toDateString() !== prevDate.toDateString();
};

// Streaming chat list component (for real-time updates)
export const StreamingChatList: React.FC<{
  messages: Message[];
  streamingContent?: string;
  streamingCitations?: any[];
  className?: string;
}> = ({ messages, streamingContent, streamingCitations, className }) => {
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom when new messages arrive or streaming updates
  useEffect(() => {
    const scrollToBottom = () => {
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    };

    const timeoutId = setTimeout(scrollToBottom, 100);
    return () => clearTimeout(timeoutId);
  }, [messages, streamingContent]);

  return (
    <div
      className={`
        flex-1 overflow-y-auto px-3 sm:px-4 py-4 sm:py-6
        bg-gray-50 dark:bg-gray-900
        scrollbar-thin scrollbar-thumb-gray-300 dark:scrollbar-thumb-gray-600
        scrollbar-track-transparent
        touch-pan-y
        ${className}
      `}
    >
      <div className="max-w-4xl mx-auto space-y-1">
        {/* Render existing messages */}
        {messages.map((message, index) => {
          const prevMessage = messages[index - 1];
          const showDateDivider = shouldShowDateDivider(message, prevMessage);
          
          return (
            <React.Fragment key={message.id}>
              {showDateDivider && (
                <DateDivider date={message.timestamp || new Date()} />
              )}
              <MessageBubble message={message} />
            </React.Fragment>
          );
        })}

        {/* Streaming message */}
        {streamingContent && (
          <MessageBubble
            message={{
              id: 'streaming',
              sessionId: '',
              content: streamingContent,
              role: MessageSender.ASSISTANT,
              timestamp: new Date(),
              citations: streamingCitations,
            }}
            isStreaming={true}
          />
        )}
        
        {/* Invisible element for scroll targeting */}
        <div ref={messagesEndRef} />
      </div>
    </div>
  );
};