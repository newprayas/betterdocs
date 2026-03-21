"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";

export const dynamic = "force-dynamic";
import { useParams, useRouter } from "next/navigation";
import {
  useSessionStore,
  useChatStore,
  useDocumentStore,
} from "../../../store";
import { TabBar, ChatTabs } from "../../../components/layout";
import { ChatList, MessageInput, PhrasePills } from "../../../components/chat";
import {
  DocumentList,
  JsonUpload,
  DocumentLibrary,
} from "../../../components/document";
import { Button, DropdownMenu, DropdownMenuItem, Switch } from "../../../components/ui";
import { Loading } from "../../../components/ui";
import { EmptyState } from "../../../components/common";
import { Header } from "../../../components/layout";
import { useRouteErrorHandler } from "../../../components/common/RouteErrorBoundary";
import { getLibraryBookNameById } from "../../../services/libraryService";
import { askDrugModeService, drugModeService } from "../../../services/drug";
import type { Document, SessionChatMode } from "../../../types";

const getDocumentDisplayName = (document: Document): string => {
  if (document.originalPath?.startsWith("library:")) {
    const libraryBookId = document.originalPath.slice("library:".length);
    const libraryBookName = getLibraryBookNameById(libraryBookId);
    if (libraryBookName) return libraryBookName;
  }

  return document.title || document.filename;
};

const isTextEntryElement = (target: EventTarget | null): boolean => {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tagName = target.tagName.toLowerCase();
  return tagName === "input" || tagName === "textarea";
};

export default function SessionPage() {
  const params = useParams();
  const router = useRouter();
  const { handleRouteError, safeNavigate } = useRouteErrorHandler();
  const sessionId = params.id as string;

  // Validate session ID format
  useEffect(() => {
    if (!sessionId) {
      handleRouteError(new Error("Session ID is missing"), "Session page load");
      safeNavigate("/", "Invalid session ID");
      return;
    }

    // Basic validation for session ID format (UUID or similar)
    const validIdPattern = /^[a-zA-Z0-9\-_]{10,}$/;
    if (!validIdPattern.test(sessionId)) {
      console.error("🔍 [SESSION_PAGE] Invalid session ID format:", sessionId);
      handleRouteError(
        new Error(`Invalid session ID format: ${sessionId}`),
        "Session ID validation",
      );
      safeNavigate("/", "Invalid session ID format");
      return;
    }

    // console.log('🔍 [SESSION_PAGE] Loading session with valid ID:', sessionId);
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
    isReadingSources,
    loadMessages,
    sessionModeBySession,
    drugSuggestionsBySession,
    setSessionModeForSession,
  } = useChatStore();

  const {
    documents,
    loadedSessionId,
    isLoadingDocuments,
    loadDocuments,
    toggleDocumentEnabled,
  } = useDocumentStore();

  const sessionDocuments = useMemo(
    () => documents.filter((document) => document.sessionId === sessionId),
    [documents, sessionId],
  );
  const hasDocumentDataForSession =
    loadedSessionId === sessionId && !isLoadingDocuments;
  const documentsLoading = isLoadingDocuments || loadedSessionId !== sessionId;
  const hasDocuments =
    (currentSession?.documentCount || 0) > 0 || sessionDocuments.length > 0;

  const [activeTab, setActiveTab] = useState("chat");
  const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false);
  const [isLibraryOpen, setIsLibraryOpen] = useState(false);
  const [isSourcesPanelOpen, setIsSourcesPanelOpen] = useState(false);
  const [messageInput, setMessageInput] = useState("");
  const [isInitialLoad, setIsInitialLoad] = useState(true);
  const [isPreparingDrugDataset, setIsPreparingDrugDataset] = useState(false);
  const [togglingDocumentIds, setTogglingDocumentIds] = useState<Set<string>>(
    new Set(),
  );
  const messageInputRef = useRef<HTMLTextAreaElement>(null);
  const rawSessionMode = sessionModeBySession[sessionId] || "chat";
  const sessionMode: SessionChatMode =
    rawSessionMode === "ask-drug" ? "drug" : rawSessionMode;
  const isDrugModeEnabled = sessionMode === "drug";
  const isDatasetModeEnabled = sessionMode !== "chat";
  const drugSuggestionPhrases = drugSuggestionsBySession[sessionId] || [];
  const shouldShowPhrasePills =
    !isDatasetModeEnabled || drugSuggestionPhrases.length > 0;
  const visiblePhrasePhrases = isDatasetModeEnabled
    ? drugSuggestionPhrases
    : undefined;
  const modeLabel =
    sessionMode === "drug" ? "Drugs" : "Chat Mode";
  const readyTitle =
    sessionMode === "drug" ? "Drugs mode is ready" : "Start a conversation";
  const readyDescription =
    sessionMode === "drug"
      ? "Ask about doses, brands, indications, side-effects, cautions, pregnancy, renal dose, and more."
      : "Ask a question about your documents to get started";
  const messagePlaceholder =
    isPreparingDrugDataset
      ? "Preparing drug dataset..."
      : isDrugModeEnabled
        ? "Ask about drugs, doses, brands, indications, side effects..."
        : documentsLoading
            ? "Loading books..."
            : !hasDocuments
              ? "Please add a book FIRST to chat"
              : "Ask a question about your documents...";

  const sortedDocuments = useMemo(
    () =>
      [...sessionDocuments].sort((a, b) =>
        getDocumentDisplayName(a)
          .toLowerCase()
          .localeCompare(getDocumentDisplayName(b).toLowerCase()),
      ),
    [sessionDocuments],
  );
  const activeDocuments = useMemo(
    () => sortedDocuments.filter((document) => document.enabled),
    [sortedDocuments],
  );
  const inactiveDocuments = useMemo(
    () => sortedDocuments.filter((document) => !document.enabled),
    [sortedDocuments],
  );
  const activeDocumentCount = activeDocuments.length;
  const clearActiveElementFocus = () => {
    if (typeof document === "undefined") return;
    const blurActive = () => {
      const activeEl = document.activeElement as HTMLElement | null;
      activeEl?.blur();
    };
    blurActive();
    requestAnimationFrame(blurActive);
    setTimeout(blurActive, 0);
  };

  const handleLibraryOpen = () => {
    setActiveTab("documents");
    setIsLibraryOpen(true);

    if (typeof window !== "undefined") {
      const currentState = window.history.state ?? {};
      if (!currentState.__libraryOverlay) {
        window.history.pushState(
          { ...currentState, __libraryOverlay: true },
          "",
          window.location.href,
        );
      }
    }
  };

  const handleLibraryClose = () => {
    clearActiveElementFocus();

    if (
      typeof window !== "undefined" &&
      window.history.state?.__libraryOverlay
    ) {
      window.history.back();
      return;
    }

    setIsLibraryOpen(false);
    setActiveTab("documents");
  };

  const handleSourcesPanelOpen = () => {
    setIsSourcesPanelOpen(true);

    if (typeof window !== "undefined") {
      const currentState = window.history.state ?? {};
      if (!currentState.__sourcesPanel) {
        window.history.pushState(
          { ...currentState, __sourcesPanel: true },
          "",
          window.location.href,
        );
      }
    }
  };

  const handleSourcesPanelClose = () => {
    clearActiveElementFocus();

    if (typeof window !== "undefined" && window.history.state?.__sourcesPanel) {
      window.history.back();
      return;
    }

    setIsSourcesPanelOpen(false);
  };

  const handleToggleSource = async (documentId: string) => {
    if (togglingDocumentIds.has(documentId)) return;

    setTogglingDocumentIds((current) => new Set(current).add(documentId));
    try {
      await toggleDocumentEnabled(documentId);
    } catch (error) {
      console.error("Failed to toggle source from chat panel:", error);
    } finally {
      setTogglingDocumentIds((current) => {
        const next = new Set(current);
        next.delete(documentId);
        return next;
      });
    }
  };

  // Load session data on mount (client-side only)
  useEffect(() => {
    let isMounted = true;

    const loadSessionData = () => {
      if (typeof window !== "undefined" && sessionId) {
        setIsInitialLoad(true);

        // Set the current session ID immediately (this will now be optimistic if cached)
        // We don't await this because we want to render immediately with the cached data
        // The store handles the DB fetch in the background
        setCurrentSessionId(sessionId).catch((error) => {
          console.error("Failed to set current session:", error);
        });

        // Load messages in background - don't await for UI render
        loadMessages(sessionId).catch((error) => {
          console.error("Failed to load messages:", error);
        });

        // IMPORTANT: Load documents on mount to ensure hasDocuments check works correctly
        // This fixes the race condition where Chat tab shows "Add books" even when books exist
        loadDocuments(sessionId).catch((error) => {
          console.error("Failed to load documents:", error);
        });

        if (isMounted) {
          setIsInitialLoad(false);

          try {
            const clickDataStr = sessionStorage.getItem("session_click_time");
            if (clickDataStr) {
              const clickData = JSON.parse(clickDataStr);
              if (clickData.sessionId === sessionId) {
                const duration = performance.now() - clickData.timestamp;
                console.log(
                  `⏱️ [Performance] Session ${sessionId} opened in ${duration.toFixed(2)}ms`,
                );
                sessionStorage.removeItem("session_click_time");
              }
            }
          } catch (e) {
            // Ignore performance logging errors
          }
        }
      }
    };

    loadSessionData();

    // Cleanup function to prevent state updates on unmounted component
    return () => {
      isMounted = false;
    };
  }, [sessionId, setCurrentSessionId, loadMessages, loadDocuments]);

  // Refresh documents when switching to Documents tab (in case new docs were added)
  useEffect(() => {
    if (activeTab === "documents" && sessionId) {
      loadDocuments(sessionId);
      // Ensure the page starts from top when switching tabs
      window.scrollTo({ top: 0, behavior: "instant" });
    }
  }, [activeTab, sessionId, loadDocuments]);

  // NEW: Track last active session for PWA resume (Removed as per user request)
  // We no longer track this as we always want to land on home page

  // Redirect if session not found (client-side only)
  useEffect(() => {
    if (
      typeof window !== "undefined" &&
      !sessionLoading &&
      !currentSession &&
      !isInitialLoad
    ) {
      // Only redirect if we're done loading and still have no session
      // router.push('/');
      // Commented out to prevent accidental redirects during loading
    }
  }, [currentSession, sessionLoading, router, isInitialLoad]);

  // When library is open, browser/device back should close it first.
  useEffect(() => {
    const handlePopState = () => {
      if (isLibraryOpen) {
        setIsLibraryOpen(false);
        setActiveTab("documents");
        clearActiveElementFocus();
        return;
      }

      if (isSourcesPanelOpen) {
        setIsSourcesPanelOpen(false);
        clearActiveElementFocus();
      }
    };

    window.addEventListener("popstate", handlePopState);
    return () => {
      window.removeEventListener("popstate", handlePopState);
    };
  }, [isLibraryOpen, isSourcesPanelOpen]);

  useEffect(() => {
    if (activeTab !== "chat" && isSourcesPanelOpen) {
      setIsSourcesPanelOpen(false);
    }
  }, [activeTab, isSourcesPanelOpen]);

  useEffect(() => {
    if (!isSourcesPanelOpen) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        handleSourcesPanelClose();
        return;
      }

      if (event.key === "Backspace" && !isTextEntryElement(event.target)) {
        event.preventDefault();
        handleSourcesPanelClose();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [isSourcesPanelOpen]);

  const handleSendMessage = async (content: string) => {
    if (!sessionId) return;

    try {
      await sendMessage(sessionId, content);
      setMessageInput(""); // Clear the input after sending
    } catch (error) {
      console.error("Failed to send message:", error);
    }
  };

  const handleSessionModeChange = async (mode: SessionChatMode) => {
    console.log("[SESSION MODE]", "Mode changed from session page", {
      sessionId,
      mode,
    });

    setSessionModeForSession(sessionId, mode);

    if (mode === "chat") return;

    setIsPreparingDrugDataset(true);
    try {
      await Promise.all([drugModeService.warmup(), askDrugModeService.warmup()]);
      console.log("[SESSION MODE]", "Dataset warmup completed", {
        sessionId,
        mode,
      });
    } catch (error) {
      console.error("[SESSION MODE ERROR]", "Dataset warmup failed", error);
    } finally {
      setIsPreparingDrugDataset(false);
    }
  };

  const handlePhraseSelect = (phrase: string) => {
    if (isDatasetModeEnabled && drugSuggestionPhrases.includes(phrase)) {
      setMessageInput(`${phrase} `);

      requestAnimationFrame(() => {
        if (messageInputRef.current) {
          messageInputRef.current.focus();
          const length = messageInputRef.current.value.length;
          messageInputRef.current.setSelectionRange(length, length);
        }
      });
      return;
    }

    // Append the selected phrase to the current message input with an extra space
    const newMessage = messageInput
      ? `${messageInput} ${phrase} `
      : `${phrase} `;
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
      router.push("/");
    } catch (error) {
      console.error("Failed to delete session:", error);
    }
  };

  const handleClearHistory = async () => {
    if (!sessionId) return;

    try {
      await clearHistory(sessionId);
    } catch (error) {
      console.error("Failed to clear history:", error);
    }
  };

  const handleScrollToLatestQuestion = () => {
    const debugPrefix = "[AnswerScroll]";
    console.groupCollapsed(`${debugPrefix} Button tapped`);

    const chatRegion = document.querySelector(
      '[data-chat-scroll-container="true"]',
    ) as HTMLElement | null;
    if (!chatRegion) {
      console.warn(`${debugPrefix} chatRegion not found`);
      console.groupEnd();
      return;
    }

    const messageElements = Array.from(
      chatRegion.querySelectorAll("[data-chat-message-id]"),
    ) as HTMLElement[];
    console.log(`${debugPrefix} chatRegion metrics`, {
      scrollTop: chatRegion.scrollTop,
      scrollHeight: chatRegion.scrollHeight,
      clientHeight: chatRegion.clientHeight,
      messageElementCount: messageElements.length,
      storeMessagesCount: messages.length,
    });

    const latestUserMessageId = [...messages]
      .reverse()
      .find((message) => String(message.role).toLowerCase() === "user")?.id;
    console.log(
      `${debugPrefix} latest user id from store`,
      latestUserMessageId,
    );

    const latestUserMessageElement = latestUserMessageId
      ? messageElements.find(
          (element) =>
            element.getAttribute("data-chat-message-id") ===
            latestUserMessageId,
        ) || null
      : null;

    const latestUserMessageByRole =
      [...messageElements]
        .reverse()
        .find(
          (element) =>
            element.getAttribute("data-chat-message-role") === "user",
        ) || null;

    const latestMessageElement =
      messageElements.length > 0
        ? messageElements[messageElements.length - 1]
        : null;

    const targetElement =
      latestUserMessageElement ||
      latestUserMessageByRole ||
      latestMessageElement;
    if (!targetElement) {
      console.warn(`${debugPrefix} no target element found`);
      console.groupEnd();
      return;
    }
    console.log(`${debugPrefix} selected target`, {
      targetId: targetElement.getAttribute("data-chat-message-id"),
      targetRole: targetElement.getAttribute("data-chat-message-role"),
      hasStoreMatchedElement: Boolean(latestUserMessageElement),
      hasRoleMatchedElement: Boolean(latestUserMessageByRole),
    });

    const findScrollableParent = (element: HTMLElement): HTMLElement | null => {
      let parent = element.parentElement;

      while (parent) {
        const style = window.getComputedStyle(parent);
        const isScrollable = /(auto|scroll)/.test(style.overflowY);
        const canScroll = parent.scrollHeight > parent.clientHeight;

        if (isScrollable && canScroll) return parent;
        parent = parent.parentElement;
      }

      return null;
    };

    const scrollParent = findScrollableParent(targetElement);

    if (!scrollParent) {
      const targetTopOnPage =
        targetElement.getBoundingClientRect().top + window.scrollY;
      const stickyHeaderOffset = 140;
      const nextWindowScrollTop = Math.max(
        0,
        targetTopOnPage - stickyHeaderOffset,
      );

      console.warn(
        `${debugPrefix} scrollParent not found, using window scroll fallback`,
        {
          targetTopOnPage,
          stickyHeaderOffset,
          currentWindowScrollY: window.scrollY,
          nextWindowScrollTop,
        },
      );

      window.scrollTo({
        top: nextWindowScrollTop,
        behavior: "smooth",
      });

      window.setTimeout(() => {
        console.log(`${debugPrefix} after window scroll`, {
          finalWindowScrollY: window.scrollY,
        });
        console.groupEnd();
      }, 250);
      return;
    }

    const containerRect = scrollParent.getBoundingClientRect();
    const targetRect = targetElement.getBoundingClientRect();
    const currentScrollTop = scrollParent.scrollTop;
    const targetTopInContainer =
      targetRect.top - containerRect.top + currentScrollTop;
    const queryTopPadding = 96;
    const maxScrollTop = scrollParent.scrollHeight - scrollParent.clientHeight;
    const nextScrollTop = Math.min(
      Math.max(0, targetTopInContainer - queryTopPadding),
      maxScrollTop,
    );
    console.log(`${debugPrefix} computed scroll`, {
      currentScrollTop,
      targetTopInContainer,
      queryTopPadding,
      maxScrollTop,
      nextScrollTop,
      delta: nextScrollTop - currentScrollTop,
      scrollParentTag: scrollParent.tagName,
      scrollParentClass: scrollParent.className,
      scrollParentOverflowY: window.getComputedStyle(scrollParent).overflowY,
    });

    scrollParent.scrollTo({
      top: nextScrollTop,
      behavior: "smooth",
    });

    window.setTimeout(() => {
      console.log(`${debugPrefix} after scroll`, {
        finalScrollTop: scrollParent.scrollTop,
      });
      console.groupEnd();
    }, 250);
  };

  const handleDrugModeToggle = async () => {
    await handleSessionModeChange(sessionMode === "drug" ? "chat" : "drug");
  };

  if (isInitialLoad && !currentSession) {
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
              <Button onClick={() => router.push("/")}>Go Back Home</Button>
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
      <div className="sticky top-14 sm:top-16 z-30 bg-white dark:bg-gray-900 border-b border-gray-200 dark:border-gray-800 py-3">
        <div className="container mx-auto px-4 sm:px-6 max-w-4xl flex justify-center">
          <TabBar
            tabs={ChatTabs.ChatDocuments}
            activeTab={activeTab}
            onTabChange={setActiveTab}
            variant="pills"
            className="w-full sm:w-auto min-w-[300px]"
            actions={
              <div className="flex items-center gap-3">
                <DropdownMenu
                  trigger={
                    <Button
                      variant="ghost"
                      size="sm"
                      className="p-2 rounded-full hover:bg-gray-100 dark:hover:bg-gray-800"
                    >
                      <svg
                        className="h-5 w-5 text-gray-500 dark:text-gray-400"
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
                  <DropdownMenuItem
                    onClick={handleClearHistory}
                    disabled={messages.length === 0}
                  >
                    Clear History
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onClick={() => setIsDeleteDialogOpen(true)}
                    variant="danger"
                  >
                    Delete Session
                  </DropdownMenuItem>
                </DropdownMenu>
              </div>
            }
          />
        </div>
      </div>

      {/* Tab Content with Swipe Support */}
      <div className="flex-1 container mx-auto px-4 pt-4 pb-0 overflow-hidden flex flex-col">
        {activeTab === "chat" && (
          <div className="flex-1 flex flex-col min-h-0">
            {messagesLoading && !isInitialLoad ? (
              <div className="flex-1 flex items-center justify-center">
                <Loading size="lg" text="Loading history..." />
              </div>
            ) : messages.length === 0 ? (
              // This wrapper controls the layout to ensure input stays at bottom
              <div className="flex flex-col flex-1 min-h-0">
                {/* This wrapper grows to fill all available space */}
                <div className="flex-1 flex items-center justify-center">
                  {documentsLoading ? (
                    <EmptyState
                      title="Loading books..."
                      description="Please wait while sources are being prepared."
                      icon={<div className="text-4xl mb-2">📚</div>}
                    />
                  ) : !isDatasetModeEnabled && !hasDocuments ? (
                    <EmptyState
                      title="No books added, Add books to chat 🥳"
                      description=""
                      icon={<div className="text-4xl mb-2">📚</div>}
                      action={
                        <Button
                          onClick={() => setActiveTab("documents")}
                          variant="primary"
                          size="lg"
                        >
                          ADD BOOKS
                        </Button>
                      }
                    />
                  ) : isPreparingDrugDataset ? (
                    <EmptyState
                      title="Preparing drug dataset..."
                      description={`Please wait while ${modeLabel} loads the drug catalog.`}
                      icon={<div className="text-4xl mb-2">💊</div>}
                    />
                  ) : isDatasetModeEnabled ? (
                    <EmptyState
                      title={readyTitle}
                      description={readyDescription}
                      icon={<div className="text-4xl mb-2">💊</div>}
                    />
                  ) : (
                    <EmptyState
                      title={readyTitle}
                      description={readyDescription}
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
                  )}
                </div>

                {/* Phrase Pills */}
                <div className="relative flex-shrink-0 mt-4 max-w-4xl mx-auto w-full">
                  {!isReadingSources && (
                    <div className="absolute bottom-full right-2 mb-2 z-20 flex items-center gap-2">
                      <div className="inline-flex items-center gap-2 rounded-full border border-gray-300 bg-white px-3 py-2 text-xs font-medium text-gray-700 shadow-sm dark:border-gray-700 dark:bg-gray-900 dark:text-gray-200 sm:text-sm">
                        <span>{isPreparingDrugDataset ? "Preparing..." : "Drugs"}</span>
                        <Switch
                          checked={isDrugModeEnabled}
                          onCheckedChange={() => {
                            void handleDrugModeToggle();
                          }}
                          disabled={isPreparingDrugDataset}
                          size="sm"
                          aria-label="Toggle drugs mode"
                        />
                      </div>
                      {!isDatasetModeEnabled && (
                        <button
                          type="button"
                          onClick={handleSourcesPanelOpen}
                          onMouseUp={(event) => {
                            event.currentTarget.blur();
                          }}
                          onTouchEnd={(event) => {
                            event.currentTarget.blur();
                          }}
                          className="
                            sources-scroll-button
                            inline-flex items-center justify-center
                            px-3 py-2 sm:px-4 sm:py-2
                            text-xs sm:text-sm font-medium rounded-full
                            bg-blue-600 text-white shadow-sm
                            hover:bg-blue-700 active:bg-blue-700
                            transition-none
                            focus:outline-none focus:ring-0 focus:ring-offset-0
                          "
                          style={{ WebkitTapHighlightColor: "transparent" }}
                          aria-label="Manage active sources"
                          title="Sources"
                        >
                          Sources {documentsLoading ? "..." : activeDocumentCount}
                        </button>
                      )}
                    </div>
                  )}
                  {shouldShowPhrasePills && (
                    <PhrasePills
                      phrases={visiblePhrasePhrases}
                      onPhraseSelect={handlePhraseSelect}
                      className="bg-gray-100 dark:bg-gray-800 rounded-lg"
                      ariaLabel={
                        isDatasetModeEnabled
                          ? "Drug suggestion chips"
                          : "Quick phrase suggestions"
                      }
                    />
                  )}
                </div>

                <div className="flex-shrink-0 mt-4 max-w-4xl mx-auto w-full">
                  <MessageInput
                    sessionId={sessionId}
                    disabled={
                      isStreaming ||
                      isPreparingDrugDataset ||
                      (!isDatasetModeEnabled &&
                        (!hasDocuments || !hasDocumentDataForSession))
                    }
                    placeholder={messagePlaceholder}
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

                {/* Phrase Pills */}
                <div className="relative flex-shrink-0 mt-4 max-w-4xl mx-auto w-full">
                  {!isReadingSources && (
                    <div className="absolute bottom-full right-2 mb-2 z-20 flex items-center gap-2">
                      <div className="inline-flex items-center gap-2 rounded-full border border-gray-300 bg-white px-3 py-2 text-xs font-medium text-gray-700 shadow-sm dark:border-gray-700 dark:bg-gray-900 dark:text-gray-200 sm:text-sm">
                        <span>{isPreparingDrugDataset ? "Preparing..." : "Drugs"}</span>
                        <Switch
                          checked={isDrugModeEnabled}
                          onCheckedChange={() => {
                            void handleDrugModeToggle();
                          }}
                          disabled={isPreparingDrugDataset}
                          size="sm"
                          aria-label="Toggle drugs mode"
                        />
                      </div>
                      {!isDatasetModeEnabled && (
                        <button
                          type="button"
                          onClick={handleSourcesPanelOpen}
                          onMouseUp={(event) => {
                            event.currentTarget.blur();
                          }}
                          onTouchEnd={(event) => {
                            event.currentTarget.blur();
                          }}
                          className="
                            sources-scroll-button
                            inline-flex items-center justify-center
                            px-3 py-2 sm:px-4 sm:py-2
                            text-xs sm:text-sm font-medium rounded-full
                            bg-blue-600 text-white shadow-sm
                            hover:bg-blue-700 active:bg-blue-700
                            transition-none
                            focus:outline-none focus:ring-0 focus:ring-offset-0
                          "
                          style={{ WebkitTapHighlightColor: "transparent" }}
                          aria-label="Manage active sources"
                          title="Sources"
                        >
                          Sources {documentsLoading ? "..." : activeDocumentCount}
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={handleScrollToLatestQuestion}
                        onMouseUp={(event) => {
                          event.currentTarget.blur();
                        }}
                        onTouchEnd={(event) => {
                          event.currentTarget.blur();
                        }}
                        className="
                          answer-scroll-button
                          inline-flex items-center justify-center
                          px-3 py-2 sm:px-4 sm:py-2
                          text-xs sm:text-sm font-medium rounded-full
                          bg-gray-600 text-white border border-white
                          hover:bg-gray-600 active:bg-gray-600
                          transition-none
                          focus:outline-none focus:ring-0 focus:ring-offset-0
                        "
                        style={{ WebkitTapHighlightColor: "transparent" }}
                        aria-label="Scroll to latest answer"
                        title="Answer"
                      >
                        <svg
                          className="w-3 h-3 mr-1.5"
                          fill="none"
                          viewBox="0 0 24 24"
                          stroke="currentColor"
                        >
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth={2}
                            d="M7 14l5-5 5 5"
                          />
                        </svg>
                        Answer
                      </button>
                    </div>
                  )}
                  {shouldShowPhrasePills && (
                    <PhrasePills
                      phrases={visiblePhrasePhrases}
                      onPhraseSelect={handlePhraseSelect}
                      className="bg-gray-100 dark:bg-gray-800 rounded-lg"
                      ariaLabel={
                        isDatasetModeEnabled
                          ? "Drug suggestion chips"
                          : "Quick phrase suggestions"
                      }
                    />
                  )}
                </div>

                <div className="flex-shrink-0 mt-4 max-w-4xl mx-auto w-full">
                  {!isDatasetModeEnabled && !documentsLoading && !hasDocuments && (
                    <div className="mb-4 flex justify-center">
                      <Button
                        onClick={() => setActiveTab("documents")}
                        variant="primary"
                        size="md"
                        className="shadow-lg"
                      >
                        📚 Add Books to Chat
                      </Button>
                    </div>
                  )}
                  <MessageInput
                    sessionId={sessionId}
                    disabled={
                      isStreaming ||
                      isPreparingDrugDataset ||
                      (!isDatasetModeEnabled &&
                        (!hasDocuments || !hasDocumentDataForSession))
                    }
                    placeholder={messagePlaceholder}
                    value={messageInput}
                    onChange={setMessageInput}
                    inputRef={messageInputRef}
                  />
                </div>
              </>
            )}
          </div>
        )}

        {activeTab === "documents" && (
          <div className="max-w-6xl mx-auto flex-1 overflow-y-auto">
            <div className="space-y-6 pb-6">
              <div className="sticky top-0 bg-gray-50 dark:bg-gray-900 py-6 z-10">
                <h2 className="text-lg font-semibold text-gray-900 dark:text-white mb-4">
                  Documents ({sessionDocuments.length})
                </h2>

                <div className="flex flex-col items-center gap-4 mb-4">
                  <Button
                    variant="primary"
                    onClick={handleLibraryOpen}
                    size="lg"
                    className="text-lg px-8 py-3 !bg-blue-600 hover:!bg-blue-700 active:!bg-blue-700 !border-transparent !ring-0 !ring-offset-0 focus:!ring-0 focus:!ring-offset-0 focus-visible:!ring-0 focus-visible:!ring-offset-0"
                  >
                    <span className="mr-2">🏥</span> Library
                  </Button>

                  {sessionDocuments.length > 0 && (
                    <Button
                      variant="ghost"
                      onClick={() => setActiveTab("chat")}
                      size="md"
                      className="text-sm px-4 py-2 bg-green-600 hover:bg-green-700 dark:bg-green-700 dark:hover:bg-green-800 text-white rounded-full shadow-sm transition-colors duration-200"
                    >
                      <svg
                        className="w-4 h-4 mr-2"
                        fill="none"
                        viewBox="0 0 24 24"
                        stroke="currentColor"
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth={2}
                          d="M10 19l-7-7m0 0l7-7m-7 7h18"
                        />
                      </svg>
                      Start chatting
                    </Button>
                  )}

                  <div className="text-center">
                    <p className="text-red-600 dark:text-yellow-500 mb-2">
                      Can't find the book in the library?
                    </p>
                    <p className="text-red-600 dark:text-yellow-500 mb-4">
                      No worries! 🥳
                    </p>
                    <Button
                      variant="secondary"
                      onClick={() =>
                        window.open("https://t.me/meddyapp", "_blank")
                      }
                      size="md"
                      className="text-sm px-4 py-2"
                    >
                      🎉 Request book 🎉
                    </Button>
                    <p className="text-red-600 dark:text-yellow-500 mt-4">
                      We will try to add the resource you want to library ❤️
                    </p>
                  </div>
                </div>
              </div>

              {sessionDocuments.length === 0 && !documentsLoading ? (
                <div className="text-center py-12">
                  <p className="text-gray-500 dark:text-gray-400 text-lg mb-2">
                    No documents yet!
                  </p>
                  <p className="text-red-600 dark:text-yellow-500 text-lg">
                    Go to the library to add books 🎉
                  </p>
                </div>
              ) : (
                <DocumentList
                  documents={sessionDocuments}
                  loading={documentsLoading}
                  variant="grid"
                />
              )}
            </div>
          </div>
        )}
      </div>

      {isSourcesPanelOpen && activeTab === "chat" && (
        <div className="fixed inset-0 z-50">
          <button
            type="button"
            aria-label="Close sources panel"
            onClick={handleSourcesPanelClose}
            className="absolute inset-0 bg-black/40"
          />

          <div className="absolute inset-x-0 bottom-0 mx-auto w-full max-w-4xl rounded-t-2xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 shadow-2xl">
            <div className="px-4 pt-3 pb-4 border-b border-gray-200 dark:border-gray-700">
              <div className="mx-auto mb-3 h-1.5 w-12 rounded-full bg-gray-300 dark:bg-gray-600" />
              <div className="flex items-center justify-between gap-3">
                <div>
                  <h3 className="text-base font-semibold text-gray-900 dark:text-white">
                    Sources {documentsLoading ? "..." : activeDocumentCount}
                  </h3>
                  <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                    Changes apply to the next reply.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={handleSourcesPanelClose}
                  className="p-2 rounded-full text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-800"
                  aria-label="Close sources panel"
                >
                  <svg
                    className="w-5 h-5"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M6 18L18 6M6 6l12 12"
                    />
                  </svg>
                </button>
              </div>
            </div>

            <div className="max-h-[60vh] overflow-y-auto px-4 py-4 space-y-4">
              {documentsLoading ? (
                <div className="rounded-lg border border-dashed border-gray-300 dark:border-gray-700 p-4 text-sm text-gray-500 dark:text-gray-400">
                  Loading books...
                </div>
              ) : sortedDocuments.length === 0 && (
                <div className="rounded-lg border border-dashed border-gray-300 dark:border-gray-700 p-4 text-sm text-gray-500 dark:text-gray-400">
                  No books added yet. Add books to enable sources.
                </div>
              )}

              {activeDocuments.length > 0 && (
                <section>
                  <h4 className="text-xs font-semibold uppercase tracking-wide text-green-700 dark:text-green-300 mb-2">
                    Active ({activeDocuments.length})
                  </h4>
                  <div className="space-y-2">
                    {activeDocuments.map((document) => (
                      <div
                        key={document.id}
                        className="flex items-center justify-between gap-3 rounded-lg border border-gray-200 dark:border-gray-700 px-3 py-2"
                      >
                        <div className="min-w-0">
                          <p className="text-sm font-medium text-gray-900 dark:text-white truncate">
                            {getDocumentDisplayName(document)}
                          </p>
                          <p className="text-xs text-gray-500 dark:text-gray-400">
                            {document.status}
                          </p>
                        </div>
                        <Switch
                          checked={document.enabled}
                          onCheckedChange={() =>
                            handleToggleSource(document.id)
                          }
                          disabled={togglingDocumentIds.has(document.id)}
                          size="sm"
                        />
                      </div>
                    ))}
                  </div>
                </section>
              )}

              {inactiveDocuments.length > 0 && (
                <section>
                  <h4 className="text-xs font-semibold uppercase tracking-wide text-gray-600 dark:text-gray-300 mb-2">
                    Inactive ({inactiveDocuments.length})
                  </h4>
                  <div className="space-y-2">
                    {inactiveDocuments.map((document) => (
                      <div
                        key={document.id}
                        className="flex items-center justify-between gap-3 rounded-lg border border-gray-200 dark:border-gray-700 px-3 py-2 opacity-80"
                      >
                        <div className="min-w-0">
                          <p className="text-sm font-medium text-gray-900 dark:text-white truncate">
                            {getDocumentDisplayName(document)}
                          </p>
                          <p className="text-xs text-gray-500 dark:text-gray-400">
                            {document.status}
                          </p>
                        </div>
                        <Switch
                          checked={document.enabled}
                          onCheckedChange={() =>
                            handleToggleSource(document.id)
                          }
                          disabled={togglingDocumentIds.has(document.id)}
                          size="sm"
                        />
                      </div>
                    ))}
                  </div>
                </section>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Delete Confirmation Dialog */}
      {isDeleteDialogOpen && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
          <div className="bg-white dark:bg-gray-800 rounded-lg p-4 sm:p-6 max-w-md w-full mx-4">
            <h3 className="text-base sm:text-lg font-semibold text-gray-900 dark:text-white mb-3 sm:mb-4">
              Delete Session
            </h3>

            <p className="text-sm sm:text-base text-gray-600 dark:text-gray-300 mb-4 sm:mb-6">
              Are you sure you want to delete "{currentSession.name}"? This
              action cannot be undone and will remove all messages and
              documents.
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
        <DocumentLibrary sessionId={sessionId} onClose={handleLibraryClose} />
      )}
    </div>
  );
}
