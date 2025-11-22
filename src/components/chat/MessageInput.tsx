import React, { useState, useRef, useEffect } from 'react';
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
  const internalTextareaRef = useRef<HTMLTextAreaElement>(null);
  const { sendMessage, isStreaming } = useChat();
  
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

  const handleSend = async () => {
    const trimmedMessage = message.trim();
    if (!trimmedMessage || disabled || isStreaming || isComposing) {
      return;
    }

    // Clear the message immediately to provide instant feedback
    if (onChange) {
      onChange('');
    } else {
      setInternalMessage('');
    }

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

  const isDisabled = disabled || isStreaming || !message.trim();

  return (
    <div className={`border-t border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 p-3 sm:p-4 ${className}`}>
      <div className="max-w-4xl mx-auto">
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
              placeholder={placeholder}
              disabled={disabled || isStreaming}
              rows={1}
              className={`
                w-full px-3 py-2 sm:px-4 sm:py-3 pr-10 sm:pr-12
                border border-gray-300 dark:border-gray-600 rounded-lg
                bg-white dark:bg-gray-800
                text-gray-900 dark:text-gray-100
                placeholder-gray-500 dark:placeholder-gray-400
                resize-none overflow-hidden
                focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent
                disabled:opacity-50 disabled:cursor-not-allowed
                transition-colors duration-200
                text-base sm:text-sm
                touch-manipulation
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
            className="self-end px-3 sm:px-4"
          >
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