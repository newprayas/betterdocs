import React, { useState, useRef, useEffect, useCallback } from 'react';
import { Button } from '../ui/Button';
import { useChat } from '../../store';

interface MessageInputProps {
  sessionId: string;
  onSendMessage?: (message: string) => void;
  disabled?: boolean;
  placeholder?: string;
  className?: string;
  value?: string;
  onChange?: (value: string) => void;
  inputRef?: React.RefObject<HTMLTextAreaElement>;
}

export const MessageInput: React.FC<MessageInputProps> = ({
  sessionId,
  onSendMessage,
  disabled = false,
  placeholder = 'Type your message...',
  className,
  value,
  onChange,
  inputRef,
}) => {
  const [internalMessage, setInternalMessage] = useState('');
  const [isComposing, setIsComposing] = useState(false);
  const [waitCountdown, setWaitCountdown] = useState(0);
  const [initialWaitTime, setInitialWaitTime] = useState(0); // Track initial wait time for progress calculation
  const [pendingMessage, setPendingMessage] = useState<string | null>(null);
  const internalTextareaRef = useRef<HTMLTextAreaElement>(null);
  const countdownIntervalRef = useRef<NodeJS.Timeout | null>(null);

  const {
    sendMessage,
    isStreaming,
    checkRateLimit,
    recordQuestion,
    isRateLimited,
    setRateLimitState
  } = useChat();

  // Use external value if provided, otherwise use internal state
  const message = value !== undefined ? value : internalMessage;
  const textareaRef = inputRef || internalTextareaRef;

  // Handle message changes
  const handleMessageChange = (newValue: string) => {
    if (onChange) {
      onChange(newValue);
    } else {
      setInternalMessage(newValue);
    }
  };

  // Auto-resize textarea
  useEffect(() => {
    const textarea = textareaRef.current;
    if (textarea) {
      textarea.style.height = 'auto';
      textarea.style.height = `${Math.min(textarea.scrollHeight, 200)}px`;
    }
  }, [message]);

  // Focus on mount
  useEffect(() => {
    if (textareaRef.current && !disabled) {
      textareaRef.current.focus();
    }
  }, [disabled]);

  // Cleanup countdown interval on unmount
  useEffect(() => {
    return () => {
      if (countdownIntervalRef.current) {
        clearInterval(countdownIntervalRef.current);
      }
    };
  }, []);

  // Handle countdown completion - send the pending message
  const sendPendingMessage = useCallback(async (messageToSend: string) => {
    console.log('[RATE LIMIT]', 'Countdown finished, sending pending message');

    // Record this question
    recordQuestion();

    // Clear rate limit state FIRST
    setRateLimitState(false, 0);
    setPendingMessage(null);
    setWaitCountdown(0);
    setInitialWaitTime(0);

    try {
      // Always use sendMessage directly from the store, not onSendMessage
      // This prevents the parent component from also calling sendMessage
      await sendMessage(sessionId, messageToSend);
    } catch (error) {
      console.error('Failed to send message:', error);
    }
  }, [sendMessage, sessionId, recordQuestion, setRateLimitState]);

  // Countdown effect - use a ref to prevent double-sending
  const messageSentRef = useRef(false);

  useEffect(() => {
    // Reset the sent flag when a new pending message is set
    if (pendingMessage) {
      messageSentRef.current = false;
    }
  }, [pendingMessage]);

  useEffect(() => {
    if (waitCountdown > 0 && pendingMessage) {
      countdownIntervalRef.current = setInterval(() => {
        setWaitCountdown(prev => {
          const newValue = prev - 1;
          if (newValue <= 0) {
            if (countdownIntervalRef.current) {
              clearInterval(countdownIntervalRef.current);
              countdownIntervalRef.current = null;
            }
            // Send the pending message only if not already sent
            if (pendingMessage && !messageSentRef.current) {
              messageSentRef.current = true; // Mark as sent to prevent duplicates
              sendPendingMessage(pendingMessage);
            }
            return 0;
          }
          return newValue;
        });
      }, 1000);

      return () => {
        if (countdownIntervalRef.current) {
          clearInterval(countdownIntervalRef.current);
          countdownIntervalRef.current = null;
        }
      };
    }
  }, [waitCountdown, pendingMessage, sendPendingMessage]);


  const handleSend = async () => {
    const trimmedMessage = message.trim();
    if (!trimmedMessage || disabled || isStreaming || isComposing || waitCountdown > 0) {
      return;
    }

    // Check rate limit
    const waitTime = checkRateLimit();

    if (waitTime > 0) {
      console.log('[RATE LIMIT]', `User must wait ${waitTime} seconds`);

      // Store the pending message and start countdown
      setPendingMessage(trimmedMessage);
      setWaitCountdown(waitTime);
      setInitialWaitTime(waitTime); // Store initial time for progress calculation
      setRateLimitState(true, waitTime);

      // Clear the input immediately
      if (onChange) {
        onChange('');
      } else {
        setInternalMessage('');
      }

      return;
    }

    // Clear the message immediately to provide instant feedback
    if (onChange) {
      onChange('');
    } else {
      setInternalMessage('');
    }

    // Record this question for rate limiting
    recordQuestion();

    try {
      if (onSendMessage) {
        onSendMessage(trimmedMessage);
      } else {
        await sendMessage(sessionId, trimmedMessage);
      }
    } catch (error) {
      console.error('Failed to send message:', error);
      // Restore the message if sending failed
      if (onChange) {
        onChange(trimmedMessage);
      } else {
        setInternalMessage(trimmedMessage);
      }
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handlePaste = (e: React.ClipboardEvent) => {
    // Handle paste events, especially for images or files in the future
    const items = e.clipboardData?.items;
    if (items) {
      for (let i = 0; i < items.length; i++) {
        if (items[i].type.indexOf('image') !== -1) {
          e.preventDefault();
          // Future: Handle image paste
          console.log('Image paste detected - feature not yet implemented');
          return;
        }
      }
    }
  };

  const isDisabled = disabled || isStreaming || !message.trim() || waitCountdown > 0;
  const isWaiting = waitCountdown > 0;

  return (
    <div className={`border-t border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 p-3 sm:p-4 ${className}`}>
      <div className="max-w-4xl mx-auto">
        {/* Rate Limit Waiting Indicator - styled like ResponseProgressBar */}
        {isWaiting && (
          <div className="mb-4 max-w-[85%] sm:max-w-xs lg:max-w-md xl:max-w-lg mx-auto">
            {/* "Please wait!" text above */}
            <div className="text-sm text-yellow-600 dark:text-yellow-400 font-medium mb-3 text-center">
              ⚡ Please wait!
            </div>

            {/* Progress bar container */}
            <div className="w-full bg-yellow-200 dark:bg-yellow-800 rounded-full h-2.5 mb-3">
              {/* Progress bar fill - drains as time passes */}
              <div
                className="bg-yellow-500 dark:bg-yellow-400 h-2.5 rounded-full transition-all duration-1000 ease-linear"
                style={{ width: `${initialWaitTime > 0 ? (waitCountdown / initialWaitTime) * 100 : 0}%` }}
              ></div>
            </div>

            {/* Error message and countdown below */}
            <div className="flex justify-between items-center text-xs text-yellow-600 dark:text-yellow-500">
              <span className="truncate mr-2">Too many questions too fast</span>
              <span className="font-mono font-medium">{waitCountdown}s</span>
            </div>
          </div>
        )}

        <div className="flex gap-2 sm:gap-3">
          {/* Textarea */}
          <div className="flex-1 relative">
            <textarea
              ref={textareaRef}
              value={message}
              onChange={(e) => handleMessageChange(e.target.value)}
              onKeyDown={handleKeyDown}
              onPaste={handlePaste}
              onCompositionStart={() => setIsComposing(true)}
              onCompositionEnd={() => setIsComposing(false)}
              placeholder={isWaiting ? 'Waiting to send your question...' : placeholder}
              disabled={disabled || isStreaming || isWaiting}
              rows={1}
              className={`
                w-full px-3 py-2 sm:px-4 sm:py-3 pr-10 sm:pr-12
                border rounded-lg
                bg-white dark:bg-gray-800
                text-gray-900 dark:text-gray-100
                placeholder-gray-500 dark:placeholder-gray-400
                resize-none overflow-hidden
                focus:outline-none focus:ring-2 focus:border-transparent
                disabled:opacity-50 disabled:cursor-not-allowed
                transition-colors duration-200
                text-base sm:text-sm
                touch-manipulation
                ${isWaiting
                  ? 'border-yellow-400 dark:border-yellow-600 focus:ring-yellow-500'
                  : 'border-gray-300 dark:border-gray-600 focus:ring-blue-500'
                }
              `}
            />

            {/* Character count for long messages */}
            {message.length > 500 && (
              <div className="absolute bottom-1 sm:bottom-2 right-1 sm:right-2 text-xs text-gray-400 dark:text-gray-500">
                {message.length}/10000
              </div>
            )}
          </div>

          {/* Send Button */}
          <Button
            onClick={handleSend}
            disabled={isDisabled}
            loading={isStreaming}
            className={`self-center px-3 sm:px-4 ${isWaiting ? 'bg-yellow-500 hover:bg-yellow-600' : ''}`}
          >
            {isWaiting ? (
              <span className="font-mono">{waitCountdown}s</span>
            ) : (
              <>
                <svg
                  className="w-4 h-4"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8"
                  />
                </svg>
                <span className="ml-1 sm:ml-2 hidden sm:inline">Send</span>
              </>
            )}
          </Button>
        </div>

        {/* Helper text */}
        <div className="mt-1 sm:mt-2 text-xs text-gray-500 dark:text-gray-400 hidden sm:block">
          Press <kbd className="px-1 py-1 bg-gray-100 dark:bg-gray-700 rounded text-xs">Enter</kbd> to send,
          <kbd className="px-1 py-1 bg-gray-100 dark:bg-gray-700 rounded ml-1 text-xs">Shift + Enter</kbd> for new line
        </div>
      </div>
    </div>
  );
};


// Voice input button component (placeholder for future implementation)
export const VoiceInputButton: React.FC<{
  onTranscript: (transcript: string) => void;
  disabled?: boolean;
  className?: string;
}> = ({ onTranscript, disabled = false, className }) => {
  const [isListening, setIsListening] = useState(false);

  const handleToggleListening = () => {
    if (isListening) {
      // Stop listening
      setIsListening(false);
      // Future: Implement speech recognition stop
    } else {
      // Start listening
      setIsListening(true);
      // Future: Implement speech recognition start
      console.log('Voice input not yet implemented');
    }
  };

  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={handleToggleListening}
      disabled={disabled}
      className={className}
    >
      <svg
        className={`
          w-5 h-5
          ${isListening ? 'text-red-500 animate-pulse' : 'text-gray-500'}
        `}
        fill="none"
        viewBox="0 0 24 24"
        stroke="currentColor"
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={2}
          d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3 3v4h6V6a3 3 0 00-3-3z"
        />
      </svg>
    </Button>
  );
};