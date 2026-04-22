import React, { useEffect, useLayoutEffect, useRef } from 'react';
import dynamic from 'next/dynamic';
import { Loading } from '../ui/Loading';
import { ResponseProgressBar } from '../ui/ResponseProgressBar';
import { EmptyStates } from '../common/EmptyState';
import { useChatStore, useSavedAnswersStore, useSessionStore } from '../../store';
import { Message, MessageSender } from '../../types';
import { isToday, isYesterday, ensureDate } from '../../utils/date';

const MessageBubble = dynamic(
  () => import('./MessageBubble').then(mod => mod.MessageBubble),
  {
    loading: () => <div className="h-16 bg-gray-100 dark:bg-gray-800 rounded-lg animate-pulse mb-4" />,
    ssr: false
  }
);

interface ChatListProps {
  sessionId: string;
  className?: string;
  onDrugActionClick?: (query: string) => void;
  footer?: React.ReactNode;
}

const ChatListComponent: React.FC<ChatListProps> = ({
  sessionId,
  className,
  onDrugActionClick,
  footer,
}) => {
  const { messages, isStreaming, streamingContent, streamingCitations, isReadingSources, progressPercentage, currentProgressStep } = useChatStore();
  const userId = useSessionStore((state) => state.userId);
  const loadSavedAnswers = useSavedAnswersStore((state) => state.loadSavedAnswers);
  const isLoading = false; // Loading is now handled at the parent level
  const containerRef = useRef<HTMLDivElement>(null);
  const bottomAnchorRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void loadSavedAnswers(userId);
  }, [loadSavedAnswers, userId]);

  // Auto-scroll to bottom when new messages arrive or streaming updates
  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    container.scrollTo({ top: container.scrollHeight, behavior: 'auto' });
    bottomAnchorRef.current?.scrollIntoView({
      behavior: 'auto',
      block: 'end',
      inline: 'nearest',
    });
  }, [messages, sessionId, streamingContent]);

  useEffect(() => {
    if (typeof window === 'undefined') return;

    const attempts = [
      { label: 'effect:raf-1', delay: 0 },
      { label: 'effect:timeout-50', delay: 50 },
      { label: 'effect:timeout-150', delay: 150 },
      { label: 'effect:timeout-300', delay: 300 },
    ];

    const frameId = window.requestAnimationFrame(() => {
      const container = containerRef.current;
      if (!container) return;
      container.scrollTo({ top: container.scrollHeight, behavior: 'auto' });
      bottomAnchorRef.current?.scrollIntoView({
        behavior: 'auto',
        block: 'end',
        inline: 'nearest',
      });
    });

    const timeoutIds = attempts.slice(1).map(({ delay }) =>
      window.setTimeout(() => {
        const container = containerRef.current;
        if (!container) return;

        container.scrollTo({ top: container.scrollHeight, behavior: 'auto' });
        bottomAnchorRef.current?.scrollIntoView({
          behavior: 'auto',
          block: 'end',
          inline: 'nearest',
        });
      }, delay),
    );

    return () => {
      window.cancelAnimationFrame(frameId);
      timeoutIds.forEach((timeoutId) => window.clearTimeout(timeoutId));
    };
  }, [messages, sessionId, streamingContent]);

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
      data-chat-scroll-container="true"
      className={`
        h-full min-h-0 overflow-y-auto px-3 sm:px-4 py-4 sm:py-6
        scrollbar-thin scrollbar-thumb-gray-300 dark:scrollbar-thumb-gray-600
        scrollbar-track-transparent
        bg-gray-50 dark:bg-gray-900
        touch-pan-y
      `}
      style={{ scrollBehavior: 'auto' }}
    >
      <div className={`max-w-4xl mx-auto space-y-1 w-full ${className ?? ''}`}>
        {/* Group messages by date */}
        {messages.map((message, index) => {
          const prevMessage = messages[index - 1];
          const showDateDivider = shouldShowDateDivider(message, prevMessage);
          
          return (
            <React.Fragment key={message.id}>
              {showDateDivider && (
                <DateDivider date={message.timestamp || new Date()} />
              )}
              <div
                data-chat-message-id={message.id}
                data-chat-message-role={message.role}
              >
                <MessageBubble message={message} onDrugActionClick={onDrugActionClick} />
              </div>
            </React.Fragment>
          );
        })}

        {/* Reading sources loading indicator */}
        {isReadingSources && (
          <div className="flex justify-start mb-3 sm:mb-4">
            <ResponseProgressBar
              progress={progressPercentage}
              currentStep={currentProgressStep}
            />
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
            onDrugActionClick={onDrugActionClick}
          />
        )}

        {footer}

        <div ref={bottomAnchorRef} aria-hidden="true" />
      </div>
    </div>
  );
};

export const ChatList = React.memo(ChatListComponent);
ChatList.displayName = 'ChatList';

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
  onDrugActionClick?: (query: string) => void;
}> = ({ messages, streamingContent, streamingCitations, className, onDrugActionClick }) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const bottomAnchorRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom when new messages arrive or streaming updates
  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    container.scrollTo({ top: container.scrollHeight, behavior: 'auto' });
    bottomAnchorRef.current?.scrollIntoView({
      behavior: 'auto',
      block: 'end',
      inline: 'nearest',
    });
  }, [messages, streamingContent]);

  return (
    <div
      ref={containerRef}
      className={`
        h-full min-h-0 overflow-y-auto px-3 sm:px-4 py-4 sm:py-6
        scrollbar-thin scrollbar-thumb-gray-300 dark:scrollbar-thumb-gray-600
        scrollbar-track-transparent
        bg-gray-50 dark:bg-gray-900
        touch-pan-y
      `}
      style={{ scrollBehavior: 'auto' }}
    >
      <div className={`max-w-4xl mx-auto space-y-1 w-full ${className ?? ''}`}>
        {/* Render existing messages */}
        {messages.map((message, index) => {
          const prevMessage = messages[index - 1];
          const showDateDivider = shouldShowDateDivider(message, prevMessage);
          
          return (
            <React.Fragment key={message.id}>
              {showDateDivider && (
                <DateDivider date={message.timestamp || new Date()} />
              )}
              <MessageBubble message={message} onDrugActionClick={onDrugActionClick} />
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
            onDrugActionClick={onDrugActionClick}
          />
        )}

        <div ref={bottomAnchorRef} aria-hidden="true" />
      </div>
    </div>
  );
};
