'use client';

import React, { useEffect, useState, useRef } from 'react';

export const dynamic = 'force-dynamic';
import { useParams, useRouter } from 'next/navigation';
import { useSessionStore, useChatStore, useDocumentStore, useSettingsStore } from '../../../store';
import { TabBar, ChatTabs } from '../../../components/layout';
import { ChatList, MessageInput, PhrasePills } from '../../../components/chat';
import { DocumentList, JsonUpload, DocumentLibrary } from '../../../components/document';
import { Button, DropdownMenu, DropdownMenuItem } from '../../../components/ui';
import { Loading } from '../../../components/ui';
import { EmptyState } from '../../../components/common';
import { Header } from '../../../components/layout';
import { documentProcessor } from '../../../services/rag';
import { useRouteErrorHandler } from '../../../components/common/RouteErrorBoundary';

export default function SessionPage() {
  const params = useParams();
  const router = useRouter();
  const { handleRouteError, safeNavigate } = useRouteErrorHandler();
  const sessionId = params.id as string;

  // Validate session ID format
  useEffect(() => {
    if (!sessionId) {
      handleRouteError(new Error('Session ID is missing'), 'Session page load');
      safeNavigate('/', 'Invalid session ID');
      return;
    }

    // Basic validation for session ID format (UUID or similar)
    const validIdPattern = /^[a-zA-Z0-9\-_]{10,}$/;
    if (!validIdPattern.test(sessionId)) {
      console.error('🔍 [SESSION_PAGE] Invalid session ID format:', sessionId);
      handleRouteError(new Error(`Invalid session ID format: ${sessionId}`), 'Session ID validation');
      safeNavigate('/', 'Invalid session ID format');
      return;
    }

    console.log('🔍 [SESSION_PAGE] Loading session with valid ID:', sessionId);
  }, [sessionId, handleRouteError, safeNavigate]);

  const {
    currentSession,
    setCurrentSessionId,
    deleteSession,
    isLoading: sessionLoading,
  } = useSessionStore();

  const {
    messages,
    isLoading: messagesLoading,
    sendMessage,
    clearHistory,
    isStreaming,
  } = useChatStore();

  const {
    documents,
    loadDocuments,
    isUploading: documentsLoading,
  } = useDocumentStore();

  const { settings } = useSettingsStore();
  const { userId } = useSessionStore();

  const [activeTab, setActiveTab] = useState('chat');
  const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false);
  const [isLibraryOpen, setIsLibraryOpen] = useState(false);
  const [messageInput, setMessageInput] = useState('');
  const messageInputRef = useRef<HTMLTextAreaElement>(null);

  // Load session data on mount (client-side only)
  useEffect(() => {
    if (typeof window !== 'undefined' && sessionId) {
      setCurrentSessionId(sessionId);
      loadDocuments(sessionId);
    }
  }, [sessionId, setCurrentSessionId, loadDocuments]);

  // Redirect if session not found (client-side only)
  useEffect(() => {
    if (typeof window !== 'undefined' && !sessionLoading && !currentSession) {
      router.push('/');
    }
  }, [currentSession, sessionLoading, router]);

  const handleSendMessage = async (content: string) => {
    if (!sessionId) return;
    
    try {
      await sendMessage(sessionId, content);
      setMessageInput(''); // Clear the input after sending
    } catch (error) {
      console.error('Failed to send message:', error);
    }
  };

  const handlePhraseSelect = (phrase: string) => {
    // Append the selected phrase to the current message input with an extra space
    const newMessage = messageInput ? `${messageInput} ${phrase} ` : `${phrase} `;
    setMessageInput(newMessage);
    
    // Focus the input field and position cursor at the end
    requestAnimationFrame(() => {
      if (messageInputRef.current) {
        messageInputRef.current.focus();
        const length = messageInputRef.current.value.length;
        messageInputRef.current.setSelectionRange(length, length);
      }
    });
  };

  const handleDeleteSession = async () => {
    if (!sessionId) return;
    
    try {
      await deleteSession(sessionId);
      router.push('/');
    } catch (error) {
      console.error('Failed to delete session:', error);
    }
  };

  const handleClearHistory = async () => {
    if (!sessionId) return;
    
    try {
      await clearHistory(sessionId);
    } catch (error) {
      console.error('Failed to clear history:', error);
    }
  };


  if (sessionLoading) {
    return (
      <div className="min-h-screen bg-gray-50 dark:bg-gray-900">
        <Header />
        <div className="flex justify-center items-center h-64">
          <Loading size="lg" text="Loading session..." />
        </div>
      </div>
    );
  }

  if (!currentSession) {
    return (
      <div className="min-h-screen bg-gray-50 dark:bg-gray-900">
        <Header />
        <div className="container mx-auto px-4 py-8">
          <EmptyState
            title="Session not found"
            description="The session you're looking for doesn't exist or has been deleted."
            action={
              <Button onClick={() => router.push('/')}>
                Go Back Home
              </Button>
            }
          />
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-900 flex flex-col">
      {/* Sticky Header */}
      <div className="sticky top-0 z-40 bg-white dark:bg-gray-900 border-b border-gray-200 dark:border-gray-700">
        <Header
          title={currentSession.name}
          actions={null} // Remove actions from header, moving to tab bar
        />
      </div>

      {/* Sticky Tab Navigation */}
      <div className="sticky top-14 sm:top-16 z-30 bg-white dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700">
        <div className="container mx-auto px-3 sm:px-4">
          <TabBar
            tabs={ChatTabs.ChatDocuments}
            activeTab={activeTab}
            onTabChange={setActiveTab}
            variant="underline"
            actions={
              <DropdownMenu
                trigger={
                  <Button variant="ghost" size="sm" className="p-2">
                    <svg
                      className="h-4 w-4 sm:h-5 sm:w-5 text-gray-700 dark:text-gray-200"
                      fill="none"
                      viewBox="0 0 24 24"
                      stroke="currentColor"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M12 5v.01M12 12v.01M12 19v.01M12 6a1 1 0 110-2 1 1 0 010 2zm0 7a1 1 0 110-2 1 1 0 010 2zm0 7a1 1 0 110-2 1 1 0 010 2z"
                      />
                    </svg>
                  </Button>
                }
              >
                <DropdownMenuItem onClick={handleClearHistory} disabled={messages.length === 0}>
                  Clear History
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={() => setIsDeleteDialogOpen(true)}
                  variant="danger"
                >
                  Delete Session
                </DropdownMenuItem>
              </DropdownMenu>
            }
          />
        </div>
      </div>

      {/* Tab Content */}
      <div className="flex-1 container mx-auto px-4 pt-6 pb-0 overflow-hidden flex flex-col">
        {activeTab === 'chat' && (
          <div className="flex-1 flex flex-col min-h-0">
            {messages.length === 0 && !messagesLoading ? (
              // This wrapper controls the layout to ensure input stays at bottom
              <div className="flex flex-col flex-1 min-h-0">
                {/* This wrapper grows to fill all available space */}
                <div className="flex-1 flex items-center justify-center">
                  <EmptyState
                    title="Start a conversation"
                    description="Ask a question about your documents to get started"
                    icon={
                      <svg
                        className="w-12 h-12 text-gray-400"
                        fill="none"
                        viewBox="0 0 24 24"
                        stroke="currentColor"
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth={2}
                          d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z"
                        />
                      </svg>
                    }
                  />
                </div>
                
                {/* API Key Configuration Button */}
                {!settings?.geminiApiKey && (
                  <div className="flex-shrink-0 mt-4 max-w-4xl mx-auto w-full">
                    <Button
                      onClick={() => router.push('/settings')}
                      variant="primary"
                      className="w-full"
                    >
                      Set API Key First
                    </Button>
                  </div>
                )}
                
                {/* Phrase Pills */}
                <div className="flex-shrink-0 mt-4 max-w-4xl mx-auto w-full">
                  <PhrasePills
                    onPhraseSelect={handlePhraseSelect}
                    className="bg-gray-100 dark:bg-gray-800 rounded-lg"
                  />
                </div>
                
                {/* Message Input is now properly positioned at the bottom */}
                <div className="flex-shrink-0 mt-4 max-w-4xl mx-auto w-full">
                  <MessageInput
                    sessionId={sessionId}
                    disabled={isStreaming || !settings?.geminiApiKey}
                    placeholder={
                      !settings?.geminiApiKey
                        ? 'Please configure your API key in settings'
                        : 'Ask a question about your documents...'
                    }
                    value={messageInput}
                    onChange={setMessageInput}
                    inputRef={messageInputRef}
                  />
                </div>
              </div>
            ) : (
              <>
                <div className="flex-1 overflow-y-auto min-h-0">
                  <ChatList
                    sessionId={sessionId}
                    className="max-w-4xl mx-auto"
                  />
                </div>
                
                {/* API Key Configuration Button */}
                {!settings?.geminiApiKey && (
                  <div className="flex-shrink-0 mt-4 max-w-4xl mx-auto w-full">
                    <Button
                      onClick={() => router.push('/settings')}
                      variant="primary"
                      className="w-full"
                    >
                      Set API Key First
                    </Button>
                  </div>
                )}
                
                {/* Phrase Pills */}
                <div className="flex-shrink-0 mt-4 max-w-4xl mx-auto w-full">
                  <PhrasePills
                    onPhraseSelect={handlePhraseSelect}
                    className="bg-gray-100 dark:bg-gray-800 rounded-lg"
                  />
                </div>
                
                {/* Message Input */}
                <div className="flex-shrink-0 mt-4 max-w-4xl mx-auto w-full">
                  <MessageInput
                    sessionId={sessionId}
                    disabled={isStreaming || !settings?.geminiApiKey}
                    placeholder={
                      !settings?.geminiApiKey
                        ? 'Please configure your API key in settings'
                        : 'Ask a question about your documents...'
                    }
                    value={messageInput}
                    onChange={setMessageInput}
                    inputRef={messageInputRef}
                  />
                </div>
              </>
            )}
          </div>
        )}

        {activeTab === 'documents' && (
          <div className="max-w-6xl mx-auto flex-1 overflow-y-auto">
            <div className="space-y-6 pb-6">
              <div className="sticky top-0 bg-gray-50 dark:bg-gray-900 py-6 z-10">
                <h2 className="text-lg font-semibold text-gray-900 dark:text-white mb-4">
                  Documents ({documents.length})
                </h2>
                
                <div className="flex flex-col items-center gap-4 mb-4">
                  <Button
                    variant="primary"
                    onClick={() => setIsLibraryOpen(true)}
                    size="lg"
                    className="text-lg px-8 py-3"
                  >
                    <span className="mr-2">🏥</span> Library
                  </Button>
                  
                  <div className="text-center">
                    <p className="text-yellow-500 mb-2">Can't find the book in the library?</p>
                    <p className="text-yellow-500 mb-4">No worries! 🥳</p>
                    <Button
                      variant="secondary"
                      onClick={() => window.open('https://t.me/prayas_ojha', '_blank')}
                      size="md"
                      className="text-sm px-4 py-2"
                    >
                      🎉 Request book 🎉
                    </Button>
                    <p className="text-yellow-500 mt-4">We will try to add the resource you want to library ❤️</p>
                  </div>
                </div>
              </div>
              
              {documents.length === 0 && !documentsLoading ? (
                <div className="text-center py-12">
                  <p className="text-gray-500 dark:text-gray-400 text-lg mb-2">
                    No documents yet!
                  </p>
                  <p className="text-yellow-500 text-lg">
                    Go to the library to add books 🎉
                  </p>
                </div>
              ) : (
                <DocumentList
                  documents={documents}
                  loading={documentsLoading}
                  variant="grid"
                />
              )}
            </div>
          </div>
        )}
      </div>

      {/* Delete Confirmation Dialog */}
      {isDeleteDialogOpen && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
          <div className="bg-white dark:bg-gray-800 rounded-lg p-4 sm:p-6 max-w-md w-full mx-4">
            <h3 className="text-base sm:text-lg font-semibold text-gray-900 dark:text-white mb-3 sm:mb-4">
              Delete Session
            </h3>
            
            <p className="text-sm sm:text-base text-gray-600 dark:text-gray-300 mb-4 sm:mb-6">
              Are you sure you want to delete "{currentSession.name}"? This action cannot be undone and will remove all messages and documents.
            </p>
            
            <div className="flex gap-2 sm:gap-3">
              <Button
                variant="outline"
                onClick={() => setIsDeleteDialogOpen(false)}
                className="flex-1"
              >
                Cancel
              </Button>
              
              <Button
                variant="danger"
                onClick={handleDeleteSession}
                className="flex-1"
              >
                Delete
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Document Library Modal */}
      {isLibraryOpen && (
        <DocumentLibrary
          sessionId={sessionId}
          onClose={() => setIsLibraryOpen(false)}
        />
      )}
    </div>
  );
}