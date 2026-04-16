const DEFAULT_MODEL = 'groq/compound';
const REQUEST_TIMEOUT_MS = 30000;
const STREAM_CONNECT_TIMEOUT_MS = 30000;
const STREAM_CHUNK_TIMEOUT_MS = 45000;
const GROQ_PROXY_URL = '/api/groq';

type ChatMessage = {
  role: 'system' | 'user' | 'assistant';
  content: string;
};

type GroqChatResponse = {
  choices?: Array<{
    message?: {
      content?: string;
    };
    delta?: {
      content?: string;
    };
  }>;
  error?: {
    message?: string;
    type?: string;
    code?: string;
  };
};

type GroqProxyRequest = {
  prompt: string;
  systemPrompt?: string;
  model?: string;
  temperature?: number;
  maxTokens?: number;
  stream?: boolean;
};

export class GroqService {
  initialize(apiKey: string) {
    // Kept for backward compatibility. The app now proxies Groq through the server
    // so secrets never reach the browser bundle.
    if (apiKey) {
      console.warn('[GROQ SERVICE] initialize() is deprecated; Groq keys are now loaded server-side.');
    }
  }

  isInitialized(): boolean {
    return true;
  }

  private getModel(model?: string): string {
    return (model && model.trim()) || DEFAULT_MODEL;
  }

  private isRateLimitStatus(status: number): boolean {
    return status === 429;
  }

  private isRetriableStatus(status: number): boolean {
    return status === 429 || (status >= 500 && status < 600);
  }

  private isExactTpmPayloadTooLargeError(message: string): boolean {
    const normalizedMessage = message.toLowerCase();
    return (
      (normalizedMessage.includes('payload too large') ||
        normalizedMessage.includes('request too large for model')) &&
      normalizedMessage.includes('tokens per minute (tpm)') &&
      normalizedMessage.includes('please reduce your message size and try again')
    );
  }

  private extractWaitTime(message: string): number {
    const match = message.match(/try again in ([\d.]+)s/i);
    if (match) {
      return Math.ceil(parseFloat(match[1]));
    }
    return 10;
  }

  private buildHeaders(): HeadersInit {
    return {
      'Content-Type': 'application/json',
    };
  }

  private async parseErrorBody(response: Response): Promise<string> {
    try {
      const text = await response.text();
      if (!text) {
        return `${response.status} ${response.statusText}`;
      }

      try {
        const json = JSON.parse(text);
        const apiMsg = json?.error?.message || json?.message;
        if (typeof apiMsg === 'string' && apiMsg.trim()) {
          return apiMsg;
        }
      } catch {
        // non-json body
      }

      return `${response.status} ${response.statusText}: ${text.slice(0, 300)}`;
    } catch {
      return `${response.status} ${response.statusText}`;
    }
  }

  private buildMessages(prompt: string, systemPrompt?: string): ChatMessage[] {
    const messages: ChatMessage[] = [];
    if (systemPrompt) {
      messages.push({ role: 'system', content: systemPrompt });
    }
    messages.push({ role: 'user', content: prompt });
    return messages;
  }

  private async fetchWithTimeout(
    url: string,
    init: RequestInit,
    timeoutMs: number
  ): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, timeoutMs);

    try {
      return await fetch(url, { ...init, signal: controller.signal });
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        throw new Error(`Request timeout after ${timeoutMs}ms`);
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  private async readStreamChunkWithTimeout<T>(
    readPromise: Promise<T>,
    timeoutMs: number
  ): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        readPromise,
        new Promise<T>((_, reject) => {
          timer = setTimeout(() => {
            reject(new Error(`Stream stalled for ${timeoutMs}ms`));
          }, timeoutMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async postToGroqProxy(
    body: GroqProxyRequest,
    timeoutMs: number
  ): Promise<Response> {
    return await this.fetchWithTimeout(
      GROQ_PROXY_URL,
      {
        method: 'POST',
        headers: this.buildHeaders(),
        body: JSON.stringify(body),
      },
      timeoutMs
    );
  }

  private async requestCompletion(
    prompt: string,
    systemPrompt?: string,
    model?: string,
    options?: { temperature?: number; maxTokens?: number; timeoutMs?: number }
  ): Promise<GroqChatResponse> {
    const response = await this.postToGroqProxy(
      {
        prompt,
        systemPrompt,
        model: this.getModel(model),
        temperature: options?.temperature ?? 0.7,
        maxTokens: options?.maxTokens ?? 4096,
        stream: false,
      },
      options?.timeoutMs ?? REQUEST_TIMEOUT_MS
    );

    if (!response.ok) {
      const errMessage = await this.parseErrorBody(response);
      console.error('[GROQ SERVICE ERROR]', errMessage);

      if (this.isRateLimitStatus(response.status)) {
        const waitTime = this.extractWaitTime(errMessage);
        throw new Error(`⚠️ You are asking too many questions too fast. Please wait for ${waitTime} seconds before asking again.`);
      }

      throw new Error(errMessage);
    }

    return (await response.json()) as GroqChatResponse;
  }

  async generateResponse(
    prompt: string,
    systemPrompt?: string,
    model?: string,
    options?: { temperature?: number; maxTokens?: number; timeoutMs?: number }
  ): Promise<string> {
    const completion = await this.requestCompletion(prompt, systemPrompt, model, options);
    return completion.choices?.[0]?.message?.content || '';
  }

  async generateResponseWithGroq(
    prompt: string,
    systemPrompt?: string,
    model?: string,
    options?: { temperature?: number; maxTokens?: number; timeoutMs?: number }
  ): Promise<string> {
    const completion = await this.requestCompletion(prompt, systemPrompt, model, options);
    return completion.choices?.[0]?.message?.content || '';
  }

  async generateStreamingResponse(
    prompt: string,
    systemPrompt?: string,
    model?: string,
    options?: {
      temperature?: number;
      maxTokens?: number;
      onChunk?: (chunk: string) => void;
      maxFailoverRetries?: number;
      retryBackoffMs?: number;
    }
  ): Promise<void> {
    const modelToUse = this.getModel(model);
    console.log('[GROQ SERVICE]', 'Generating streaming response with model:', modelToUse);
    const maxFailoverRetries = Math.max(0, options?.maxFailoverRetries ?? 0);
    const retryBackoffMs = Math.max(0, options?.retryBackoffMs ?? 250);

    let attempt = 0;
    while (attempt <= maxFailoverRetries) {
      const attemptNumber = attempt + 1;
      let streamStarted = false;

      try {
        const response = await this.fetchWithTimeout(
          GROQ_PROXY_URL,
          {
            method: 'POST',
            headers: this.buildHeaders(),
            body: JSON.stringify({
              prompt,
              systemPrompt,
              model: modelToUse,
              temperature: options?.temperature ?? 0.7,
              maxTokens: options?.maxTokens ?? 4096,
              stream: true,
            }),
          },
          STREAM_CONNECT_TIMEOUT_MS
        );

        if (!response.ok) {
          const errMessage = await this.parseErrorBody(response);
          const shouldRetry = this.isRetriableStatus(response.status) && attempt < maxFailoverRetries;
          console.error('[GROQ SERVICE STREAM ERROR]', `attempt=${attemptNumber} status=${response.status} message=${errMessage}`);

          if (shouldRetry) {
            const delayMs = retryBackoffMs * attemptNumber;
            console.warn('[GROQ SERVICE STREAM RETRY]', `Retrying with next attempt in ${delayMs}ms`);
            await new Promise((resolve) => setTimeout(resolve, delayMs));
            attempt += 1;
            continue;
          }

          if (this.isRateLimitStatus(response.status) && options?.onChunk) {
            const waitTime = this.extractWaitTime(errMessage);
            options.onChunk(`⚠️ You are asking too many questions too fast. Please wait for ${waitTime} seconds before asking again.`);
            return;
          }

          throw new Error(errMessage);
        }

        if (!response.body) {
          throw new Error('Streaming response body is not available');
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder('utf-8');
        let buffer = '';
        streamStarted = true;

        while (true) {
          const { done, value } = await this.readStreamChunkWithTimeout(
            reader.read(),
            STREAM_CHUNK_TIMEOUT_MS
          );
          if (done) {
            break;
          }

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';

          for (const rawLine of lines) {
            const line = rawLine.trim();
            if (!line || !line.startsWith('data:')) {
              continue;
            }

            const data = line.slice(5).trim();
            if (!data || data === '[DONE]') {
              continue;
            }

            try {
              const parsed = JSON.parse(data) as GroqChatResponse;
              const content = parsed.choices?.[0]?.delta?.content || parsed.choices?.[0]?.message?.content || '';
              if (content && options?.onChunk) {
                options.onChunk(content);
              }
            } catch {
              // Ignore non-JSON SSE lines.
            }
          }
        }

        return;
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        const canRetry =
          !streamStarted &&
          attempt < maxFailoverRetries &&
          !this.isExactTpmPayloadTooLargeError(errorMessage);
        if (canRetry) {
          const delayMs = retryBackoffMs * attemptNumber;
          console.warn('[GROQ SERVICE STREAM RETRY]', `attempt=${attemptNumber} error="${errorMessage}" next=${delayMs}ms`);
          await new Promise((resolve) => setTimeout(resolve, delayMs));
          attempt += 1;
          continue;
        }
        throw error;
      }
    }
  }
}

export const groqService = new GroqService();
