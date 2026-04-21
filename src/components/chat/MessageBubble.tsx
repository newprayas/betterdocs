import React, { useMemo, useState } from "react";
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import { Message, Citation } from "../../types";
import { MessageSender } from "../../types/message";
import { CitationPanel } from "./CitationPanel";
import { formatTime } from "../../utils/date";
import clsx from "clsx";
import { useSavedAnswersStore } from "../../store";
import {
  buildDrugAudienceFollowUpQuery,
  buildDrugIndicationFollowUpQuery,
  isDrugActionHref,
  parseDrugActionHref,
} from "../../services/drug/drugActionLinks";
import { removePlaceholderOnlySections } from "../../utils/markdownSections";

interface MessageBubbleProps {
  message: Message;
  isStreaming?: boolean;
  className?: string;
  onDrugActionClick?: (query: string) => void;
}

// 1. Wrap the component in React.memo to prevent re-renders on parent state changes (like typing)
export const MessageBubble: React.FC<MessageBubbleProps> = React.memo(
  ({ message, isStreaming = false, className, onDrugActionClick }) => {
    const isUser = message.role === "user";
    const [isCopied, setIsCopied] = useState(false);
    const citations = message.citations || [];
    const hasCitations = citations.length > 0;
    const isSaved = useSavedAnswersStore((state) => state.isSaved(message.id));
    const toggleSavedAnswerForMessage = useSavedAnswersStore(
      (state) => state.toggleSavedAnswerForMessage,
    );
    const shouldShowCopyResponse = !isUser && !isStreaming;
    const logDrugAction = (...args: unknown[]) => {
      console.log("[DRUG ACTION][MESSAGE BUBBLE]", ...args);
    };
    const transformMarkdownUrl = (url: string): string => {
      if (url.startsWith("drug-action:")) {
        logDrugAction("url transform keep", {
          messageId: message.id,
          url,
        });
        return url;
      }

      const transformed = defaultUrlTransform(url);
      if (url !== transformed) {
        logDrugAction("url transform sanitize", {
          messageId: message.id,
          url,
          transformed,
        });
      }
      return transformed;
    };

    // 2. Memoize the content processing so it only runs when content/citations change
    const processedContent = useMemo(() => {
      const content = message.content;
      const citations = message.citations;
      // Normalize model-inserted HTML line break tags so users don't see literal "<br>" text.
      const normalizedContent = content
        .replace(/<br\s*\/?>/gi, "\n")
        // Normalize non-breaking characters that can cause overflow in narrow message bubbles.
        .replace(/[\u00A0\u2007\u202F]/g, " ")
        .replace(/\u2011/g, "-");
      const filteredContent = removePlaceholderOnlySections(normalizedContent);

      if (!citations || citations.length === 0 || isUser) {
        return filteredContent;
      }

      const citationMap = new Map<number, Citation>();
      citations.forEach((citation, index) => {
        citationMap.set(index + 1, citation);
      });

      let processed = filteredContent;

      processed = processed.replace(/\[citation:(\d+)\]/g, (match, num) => {
        const citationNum = parseInt(num);
        return citationMap.has(citationNum) ? `[${citationNum}]` : match;
      });

      let citationCounter = 1;
      processed = processed.replace(/\[citation\]/g, () => {
        return `[${citationCounter++}]`;
      });

      return processed;
    }, [message.content, message.citations, isUser]);

    const handleCopyResponse = async () => {
      if (isUser || !processedContent || isStreaming) {
        return;
      }

      try {
        await navigator.clipboard.writeText(processedContent);
        setIsCopied(true);
        window.setTimeout(() => setIsCopied(false), 1800);
      } catch (error) {
        console.error("Failed to copy response:", error);
      }
    };

    const handleSaveResponse = async () => {
      if (isUser || !processedContent || isStreaming) {
        return;
      }

      try {
        await toggleSavedAnswerForMessage(message, processedContent);
      } catch (error) {
        console.error("Failed to save response:", error);
      }
    };

    const handleMessageContentClickCapture = (event: React.MouseEvent<HTMLDivElement>) => {
      const target = event.target as HTMLElement | null;
      const anchor = target?.closest('a[href]') as HTMLAnchorElement | null;
      if (!anchor) {
        return;
      }

      const href = anchor.getAttribute('href') || '';
      const hrefLooksLikeDrugAction =
        href.startsWith("drug-action:") || isDrugActionHref(href);
      const parsed = parseDrugActionHref(href);
      logDrugAction("click capture", {
        messageId: message.id,
        isUser,
        hasHandler: Boolean(onDrugActionClick),
        href,
        hrefLooksLikeDrugAction,
        parsed,
      });

      if (!parsed && !hrefLooksLikeDrugAction) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();

      if (!parsed) {
        logDrugAction("click capture blocked", {
          messageId: message.id,
          reason: "href looked like drug action but could not be parsed",
          href,
        });
        return;
      }

      if (!onDrugActionClick) {
        logDrugAction("click capture blocked", {
          messageId: message.id,
          reason: "no handler",
        });
        return;
      }

      const query =
        parsed.action === 'brands'
          ? `brands of ${parsed.drugName}`
          : buildDrugIndicationFollowUpQuery(
              parsed.drugName,
              parsed.indication || '',
              parsed.audience,
            );
      logDrugAction("click capture dispatch", {
        messageId: message.id,
        query,
      });
      onDrugActionClick(
        query,
      );
    };

    // 3. REMOVED: All IndentationAnalyzer calls and console.logs
    // These were running heavy regex on every render, causing the lag.

    return (
      <div
        className={clsx(
          "flex gap-2 sm:gap-3 mb-3 sm:mb-4",
          isUser ? "justify-end" : "justify-start",
          className,
        )}
      >
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
        <div
          className={clsx(
            "max-w-[85%] sm:max-w-xs lg:max-w-md xl:max-w-lg min-w-0",
            isUser && "max-w-[85%] sm:max-w-xs lg:max-w-md",
          )}
        >
          <div
            className={clsx(
              "rounded-lg px-3 py-2 sm:px-4 sm:py-3 min-w-0",
              isUser
                ? "bg-blue-500 text-white ml-auto"
                : "bg-gray-100 dark:bg-gray-800 text-gray-900 dark:text-gray-100 border border-gray-200 dark:border-gray-700",
            )}
          >
            {/* Message Text */}
            <div
              className={clsx(
                "chat-markdown prose prose-sm max-w-none min-w-0 break-words [overflow-wrap:anywhere] [word-break:break-word]",
                isUser
                  ? "text-white prose-p:text-white prose-strong:text-white prose-li:text-white prose-headings:text-white"
                  : "text-gray-900 prose-p:text-gray-900 prose-li:text-gray-900 prose-strong:text-black prose-headings:text-black dark:text-gray-100 dark:prose-p:text-gray-200 dark:prose-li:text-gray-200 dark:prose-strong:text-white dark:prose-headings:text-white",
              )}
              onClickCapture={handleMessageContentClickCapture}
            >
              <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                rehypePlugins={[rehypeHighlight]}
                urlTransform={transformMarkdownUrl}
                components={{
                  // Custom strong component to override any conflicting styles
                  strong: ({ node, className, children, ...props }: any) => (
                    <strong
                      className={clsx(
                        "font-bold",
                        isUser ? "!text-white" : "!text-black dark:!text-white",
                        className,
                      )}
                      {...props}
                    >
                      {children}
                    </strong>
                  ),
                  code: ({ node, className, children, ...props }: any) => {
                    const match = /language-(\w+)/.exec(className || "");
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
                  a: ({ href, children }) => {
                    const normalizedHref = href || "";
                    const isActionLink =
                      normalizedHref.startsWith("drug-action:") ||
                      isDrugActionHref(normalizedHref);
                    const actionTarget = isActionLink
                      ? parseDrugActionHref(normalizedHref)
                      : null;
                    const isAudienceToggleLink =
                      Boolean(actionTarget?.audience) && !actionTarget?.indication;

                    logDrugAction("link render", {
                      messageId: message.id,
                      href: normalizedHref,
                      isActionLink,
                      actionTarget,
                      hasHandler: Boolean(onDrugActionClick),
                    });

                    return isActionLink ? (
                      <button
                        type="button"
                        onClick={(event) => {
                          event.preventDefault();
                          event.stopPropagation();
                          const parsed = actionTarget;
                          logDrugAction("button click", {
                            messageId: message.id,
                            href: normalizedHref,
                            hasHandler: Boolean(onDrugActionClick),
                            parsed,
                          });
                          if (!parsed || !onDrugActionClick) return;
                          const query =
                            parsed.action === 'brands'
                              ? `brands of ${parsed.drugName}`
                              : parsed.audience
                                ? parsed.indication
                                  ? buildDrugIndicationFollowUpQuery(
                                      parsed.drugName,
                                      parsed.indication,
                                      parsed.audience,
                                    )
                                  : buildDrugAudienceFollowUpQuery(
                                      parsed.drugName,
                                      parsed.audience,
                                    )
                                : buildDrugIndicationFollowUpQuery(
                                    parsed.drugName,
                                    parsed.indication || '',
                                  );
                          logDrugAction("button dispatch", {
                            messageId: message.id,
                            query,
                          });
                          onDrugActionClick(query);
                        }}
                        className={clsx(
                          "text-left text-sky-400 hover:text-sky-300",
                          isAudienceToggleLink
                            ? "no-underline"
                            : "underline underline-offset-4 decoration-1 decoration-sky-300/75 hover:decoration-sky-200/90",
                        )}
                      >
                        {children}
                      </button>
                    ) : (
                      <a
                        href={href}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-sky-400 hover:text-sky-300 underline underline-offset-4 decoration-1 decoration-sky-300/75 hover:decoration-sky-200/90"
                      >
                        {children}
                      </a>
                    );
                  },
                  ul: ({ node, className, children, ...props }) => (
                    <ul
                      className={clsx(
                        "pl-6 my-2 space-y-1 list-outside",
                        className,
                      )}
                      {...props}
                    >
                      {children}
                    </ul>
                  ),
                  table: ({ node, className, children, ...props }) => (
                    <div className="my-3 w-full overflow-x-auto">
                      <table
                        className={clsx("min-w-[640px] text-sm", className)}
                        {...props}
                      >
                        {children}
                      </table>
                    </div>
                  ),
                  th: ({ node, className, children, ...props }) => (
                    <th
                      className={clsx(
                        "align-top whitespace-normal break-words",
                        className,
                      )}
                      {...props}
                    >
                      {children}
                    </th>
                  ),
                  td: ({ node, className, children, ...props }) => (
                    <td
                      className={clsx(
                        "align-top whitespace-normal break-words",
                        className,
                      )}
                      {...props}
                    >
                      {children}
                    </td>
                  ),
                  li: ({ node, className, children, ...props }) => (
                    <li
                      className={clsx(
                        "pl-1 marker:text-gray-500 dark:marker:text-gray-400",
                        className,
                      )}
                      {...props}
                    >
                      {children}
                    </li>
                  ),
                  h1: ({ node, className, children, ...props }: any) => (
                    <h1
                      className={clsx(
                        "mt-4 mb-2 text-xl font-bold",
                        isUser
                          ? "!text-white"
                          : "!text-gray-900 dark:!text-gray-100",
                        className,
                      )}
                      {...props}
                    >
                      {children}
                    </h1>
                  ),
                  h2: ({ node, className, children, ...props }: any) => (
                    <h2
                      className={clsx(
                        "mt-4 mb-2 text-lg font-semibold",
                        isUser
                          ? "!text-white"
                          : "!text-gray-900 dark:!text-gray-100",
                        className,
                      )}
                      {...props}
                    >
                      {children}
                    </h2>
                  ),
                  h3: ({ node, className, children, ...props }: any) => (
                    <h3
                      className={clsx(
                        "mt-3 mb-2 text-base font-semibold",
                        isUser
                          ? "!text-white"
                          : "!text-gray-900 dark:!text-gray-100",
                        className,
                      )}
                      {...props}
                    >
                      {children}
                    </h3>
                  ),
                  h4: ({ node, className, children, ...props }: any) => (
                    <h4
                      className={clsx(
                        "mt-3 mb-2 text-base font-semibold",
                        isUser
                          ? "!text-white"
                          : "!text-gray-900 dark:!text-gray-100",
                        className,
                      )}
                      {...props}
                    >
                      {children}
                    </h4>
                  ),
                  h5: ({ node, className, children, ...props }: any) => (
                    <h5
                      className={clsx(
                        "mt-3 mb-2 text-sm font-semibold",
                        isUser
                          ? "!text-white"
                          : "!text-gray-900 dark:!text-gray-100",
                        className,
                      )}
                      {...props}
                    >
                      {children}
                    </h5>
                  ),
                  h6: ({ node, className, children, ...props }: any) => (
                    <h6
                      className={clsx(
                        "mt-3 mb-2 text-sm font-semibold",
                        isUser
                          ? "!text-white"
                          : "!text-gray-900 dark:!text-gray-100",
                        className,
                      )}
                      {...props}
                    >
                      {children}
                    </h6>
                  ),
                  span: ({ node, className, children, ...props }: any) => {
                    const text = typeof children === "string" ? children : "";
                    const citationMatch = text.match(/^\[(\d+)\]$/);

                    if (citationMatch && !isUser) {
                      const citationNum = parseInt(citationMatch[1]);
                      return (
                        <span
                          className={`citation-ref ${className || ""}`}
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

              {isStreaming && (
                <span className="inline-block w-2 h-4 bg-gray-400 dark:bg-gray-600 animate-pulse ml-1" />
              )}
            </div>

            {shouldShowCopyResponse && (
              <div className="mt-3 pt-3 border-t border-gray-200 dark:border-gray-700">
                <div className="mb-2 flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={handleCopyResponse}
                    disabled={isStreaming}
                    className="inline-flex items-center gap-2 rounded-md border border-gray-200 dark:border-gray-700 px-2.5 py-1.5 text-xs font-medium text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700 disabled:opacity-60 disabled:cursor-not-allowed transition-colors"
                    aria-label="Copy response"
                  >
                    <svg
                      className="w-3.5 h-3.5"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                    >
                      <rect x="9" y="9" width="13" height="13" rx="2" />
                      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                    </svg>
                    <span>{isCopied ? "Copied" : "Copy response"}</span>
                  </button>
                  <button
                    type="button"
                    onClick={handleSaveResponse}
                    disabled={isStreaming}
                    className={clsx(
                      "inline-flex items-center gap-2 rounded-md border px-2.5 py-1.5 text-xs font-medium transition-colors disabled:opacity-60 disabled:cursor-not-allowed",
                      isSaved
                        ? "border-emerald-500 bg-emerald-50 text-emerald-700 hover:bg-emerald-100 dark:border-emerald-500/60 dark:bg-emerald-500/10 dark:text-emerald-300 dark:hover:bg-emerald-500/20"
                        : "border-gray-200 dark:border-gray-700 text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700",
                    )}
                    aria-label={isSaved ? "Unsave response" : "Save response"}
                    aria-pressed={isSaved}
                  >
                    <svg
                      className="w-3.5 h-3.5"
                      viewBox="0 0 24 24"
                      fill={isSaved ? "currentColor" : "none"}
                      stroke="currentColor"
                      strokeWidth="2"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        d="M5 5a2 2 0 012-2h10a2 2 0 012 2v16l-7-4-7 4V5z"
                      />
                    </svg>
                    <span>{isSaved ? "Saved" : "Save"}</span>
                  </button>
                </div>
                {hasCitations && <CitationPanel citations={citations} />}
              </div>
            )}
          </div>

          {/* Timestamp */}
          <div
            className={clsx(
              "text-xs text-gray-500 dark:text-gray-400 mt-1",
              isUser ? "text-right" : "text-left",
            )}
          >
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
  },
);

// Display name for debugging
MessageBubble.displayName = "MessageBubble";

// Streaming message bubble component
export const StreamingMessageBubble: React.FC<{
  content: string;
  citations?: any[];
  className?: string;
}> = ({ content, citations, className }) => {
  // Use useMemo to ensure the object reference remains stable unless content changes
  const streamingMessage = useMemo<Message>(
    () => ({
      id: "streaming",
      sessionId: "",
      content,
      role: MessageSender.ASSISTANT,
      timestamp: new Date(),
      citations,
    }),
    [content, citations],
  );

  return (
    <MessageBubble
      message={streamingMessage}
      isStreaming={true}
      className={className}
    />
  );
};
