const CEREBRAS_BASE_URL = 'https://api.cerebras.ai/v1';
const GROQ_BASE_URL = 'https://api.groq.com/openai/v1';
const DEFAULT_MODEL = 'gpt-oss-120b';
const REQUEST_TIMEOUT_MS = 30000;
const STREAM_CONNECT_TIMEOUT_MS = 30000;
const STREAM_CHUNK_TIMEOUT_MS = 45000;

type ChatMessage = {
  role: 'system' | 'user' | 'assistant';
  content: string;
};

type CerebrasChatResponse = {
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

export class GroqService {
  private apiKey: string = '';
  private envApiKeys: string[] = [];
  private keyRotationIndex: number = 0;
  private groqEnvApiKeys: string[] = [];
  private groqKeyRotationIndex: number = 0;

  constructor() {
    this.envApiKeys = this.loadEnvApiKeys();
    this.groqEnvApiKeys = this.loadGroqEnvApiKeys();
    console.log('[CEREBRAS SERVICE]', `Loaded ${this.envApiKeys.length} env API key(s)`);
    console.log('[GROQ SERVICE]', `Loaded ${this.groqEnvApiKeys.length} env API key(s)`);
  }

  private loadEnvApiKeys(): string[] {
    // Important: in Next.js client bundles, dynamic process.env[key] access can fail in production.
    // Use explicit env references so values are statically inlined at build time.
    const explicitKeys = [
      process.env.NEXT_PUBLIC_CEREBRAS_API_1,
      process.env.NEXT_PUBLIC_CEREBRAS_API_2,
      process.env.NEXT_PUBLIC_CEREBRAS_API_3,
      process.env.NEXT_PUBLIC_CEREBRAS_API_4,
      process.env.NEXT_PUBLIC_CEREBRAS_API_5,
      process.env.NEXT_PUBLIC_CEREBRAS_API_6,
    ];

    return explicitKeys
      .map((k) => String(k || '').trim())
      .filter((k) => k.length > 0);
  }

  private loadGroqEnvApiKeys(): string[] {
    // Important: in Next.js client bundles, dynamic process.env[key] access can fail in production.
    // Use explicit env references so values are statically inlined at build time.
    const explicitKeys = [
      process.env.NEXT_PUBLIC_GROQ_API_1,
      process.env.NEXT_PUBLIC_GROQ_API_2,
      process.env.NEXT_PUBLIC_GROQ_API_3,
      process.env.NEXT_PUBLIC_GROQ_API_4,
      process.env.NEXT_PUBLIC_GROQ_API_5,
      process.env.NEXT_PUBLIC_GROQ_API_6,
    ];

    return explicitKeys
      .map((k) => String(k || '').trim())
      .filter((k) => k.length > 0);
  }

  private getAllAvailableKeys(): string[] {
    // If env keys exist, always use them only. This avoids old saved/manual keys
    // causing random 401s during rotation.
    if (this.envApiKeys.length > 0) {
      return this.envApiKeys.filter((k, idx, arr) => arr.indexOf(k) === idx);
    }

    const manual = this.apiKey.trim();
    return manual ? [manual] : [];
  }

  private getNextApiKey(): string {
    const keys = this.getAllAvailableKeys();
    if (keys.length === 0) {
      throw new Error('Cerebras service not initialized and no env keys configured');
    }
    const key = keys[this.keyRotationIndex % keys.length];
    this.keyRotationIndex = (this.keyRotationIndex + 1) % Math.max(keys.length, 1);
    return key;
  }

  private getAllAvailableGroqKeys(): string[] {
    if (this.groqEnvApiKeys.length > 0) {
      return this.groqEnvApiKeys.filter((k, idx, arr) => arr.indexOf(k) === idx);
    }
    return [];
  }

  private getNextGroqApiKey(): string {
    const keys = this.getAllAvailableGroqKeys();
    if (keys.length === 0) {
      throw new Error('Groq service has no env keys configured');
    }
    const key = keys[this.groqKeyRotationIndex % keys.length];
    this.groqKeyRotationIndex = (this.groqKeyRotationIndex + 1) % Math.max(keys.length, 1);
    return key;
  }

  initialize(apiKey: string) {
    // Optional manual key (legacy settings path). Env keys remain primary and are rotated.
    if (!apiKey || apiKey === this.apiKey) return;
    this.apiKey = apiKey;
    console.log('[CEREBRAS SERVICE]', 'Initialized with manual key:', apiKey.substring(0, 7) + '...');
  }

  isInitialized(): boolean {
    return this.getAllAvailableKeys().length > 0;
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

  private extractWaitTime(message: string): number {
    const match = message.match(/try again in ([\d.]+)s/i);
    if (match) {
      return Math.ceil(parseFloat(match[1]));
    }
    return 10;
  }

  private buildHeaders(apiKey: string): HeadersInit {
    return {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
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

  private isAbortError(error: unknown): boolean {
    return error instanceof DOMException && error.name === 'AbortError';
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
      if (this.isAbortError(error)) {
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

  async validateApiKey(apiKey: string): Promise<boolean> {
    try {
      const response = await this.fetchWithTimeout(`${CEREBRAS_BASE_URL}/chat/completions`, {
        method: 'POST',
        headers: this.buildHeaders(apiKey),
        body: JSON.stringify({
          model: DEFAULT_MODEL,
          stream: false,
          messages: [{ role: 'user', content: 'Ping' }],
          temperature: 0,
          max_tokens: 1,
          top_p: 1,
        }),
      }, REQUEST_TIMEOUT_MS);

      if (!response.ok) {
        const msg = await this.parseErrorBody(response);
        console.error('[CEREBRAS SERVICE] API validation failed:', msg);
        return false;
      }

      return true;
    } catch (error) {
      console.error('[CEREBRAS SERVICE] API validation failed:', error);
      return false;
    }
  }

  async generateResponse(
    prompt: string,
    systemPrompt?: string,
    model?: string,
    options?: { temperature?: number; maxTokens?: number }
  ): Promise<string> {
    if (!this.isInitialized()) {
      throw new Error('Cerebras service not initialized');
    }

    const modelToUse = this.getModel(model);
    console.log('[CEREBRAS SERVICE]', 'Generating response with model:', modelToUse);

    try {
      const response = await this.fetchWithTimeout(`${CEREBRAS_BASE_URL}/chat/completions`, {
        method: 'POST',
        headers: this.buildHeaders(this.getNextApiKey()),
        body: JSON.stringify({
          model: modelToUse,
          stream: false,
          messages: this.buildMessages(prompt, systemPrompt),
          temperature: options?.temperature ?? 0.7,
          max_tokens: options?.maxTokens ?? 4096,
          top_p: 1,
        }),
      }, REQUEST_TIMEOUT_MS);

      if (!response.ok) {
        const errMessage = await this.parseErrorBody(response);
        console.error('[CEREBRAS SERVICE ERROR]', errMessage);

        if (this.isRateLimitStatus(response.status)) {
          const waitTime = this.extractWaitTime(errMessage);
          return `⚠️ You are asking too many questions too fast. Please wait for ${waitTime} seconds before asking again.`;
        }
        throw new Error(errMessage);
      }

      const completion = (await response.json()) as CerebrasChatResponse;
      return completion.choices?.[0]?.message?.content || '';
    } catch (error) {
      if (error instanceof Error && /429|rate limit/i.test(error.message)) {
        const waitTime = this.extractWaitTime(error.message);
        return `⚠️ You are asking too many questions too fast. Please wait for ${waitTime} seconds before asking again.`;
      }
      throw error;
    }
  }

  async generateResponseWithGroq(
    prompt: string,
    systemPrompt?: string,
    model?: string,
    options?: { temperature?: number; maxTokens?: number }
  ): Promise<string> {
    const keys = this.getAllAvailableGroqKeys();
    if (keys.length === 0) {
      throw new Error('Groq service has no env keys configured');
    }

    const modelToUse = this.getModel(model);
    console.log('[GROQ SERVICE]', 'Generating response with model:', modelToUse);

    try {
      const response = await this.fetchWithTimeout(`${GROQ_BASE_URL}/chat/completions`, {
        method: 'POST',
        headers: this.buildHeaders(this.getNextGroqApiKey()),
        body: JSON.stringify({
          model: modelToUse,
          stream: false,
          messages: this.buildMessages(prompt, systemPrompt),
          temperature: options?.temperature ?? 0.7,
          max_tokens: options?.maxTokens ?? 4096,
          top_p: 1,
        }),
      }, REQUEST_TIMEOUT_MS);

      if (!response.ok) {
        const errMessage = await this.parseErrorBody(response);
        console.error('[GROQ SERVICE ERROR]', errMessage);

        if (this.isRateLimitStatus(response.status)) {
          const waitTime = this.extractWaitTime(errMessage);
          return `⚠️ You are asking too many questions too fast. Please wait for ${waitTime} seconds before asking again.`;
        }
        throw new Error(errMessage);
      }

      const completion = (await response.json()) as CerebrasChatResponse;
      return completion.choices?.[0]?.message?.content || '';
    } catch (error) {
      if (error instanceof Error && /429|rate limit/i.test(error.message)) {
        const waitTime = this.extractWaitTime(error.message);
        return `⚠️ You are asking too many questions too fast. Please wait for ${waitTime} seconds before asking again.`;
      }
      throw error;
    }
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
    if (!this.isInitialized()) {
      throw new Error('Cerebras service not initialized');
    }

    const modelToUse = this.getModel(model);
    console.log('[CEREBRAS SERVICE]', 'Generating streaming response with model:', modelToUse);
    const maxFailoverRetries = Math.max(0, options?.maxFailoverRetries ?? 0);
    const retryBackoffMs = Math.max(0, options?.retryBackoffMs ?? 250);

    let attempt = 0;
    while (attempt <= maxFailoverRetries) {
      const attemptNumber = attempt + 1;
      let streamStarted = false;

      try {
        const response = await this.fetchWithTimeout(`${CEREBRAS_BASE_URL}/chat/completions`, {
          method: 'POST',
          headers: this.buildHeaders(this.getNextApiKey()),
          body: JSON.stringify({
            model: modelToUse,
            stream: true,
            messages: this.buildMessages(prompt, systemPrompt),
            temperature: options?.temperature ?? 0.7,
            max_tokens: options?.maxTokens ?? 4096,
            top_p: 1,
          }),
        }, STREAM_CONNECT_TIMEOUT_MS);

        if (!response.ok) {
          const errMessage = await this.parseErrorBody(response);
          const shouldRetry = this.isRetriableStatus(response.status) && attempt < maxFailoverRetries;
          console.error('[CEREBRAS SERVICE STREAM ERROR]', `attempt=${attemptNumber} status=${response.status} message=${errMessage}`);

          if (shouldRetry) {
            const delayMs = retryBackoffMs * attemptNumber;
            console.warn('[CEREBRAS SERVICE STREAM RETRY]', `Retrying with next key in ${delayMs}ms`);
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
              const parsed = JSON.parse(data) as CerebrasChatResponse;
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
        const canRetry = !streamStarted && attempt < maxFailoverRetries;
        if (canRetry) {
          const delayMs = retryBackoffMs * attemptNumber;
          console.warn('[CEREBRAS SERVICE STREAM RETRY]', `attempt=${attemptNumber} error="${error instanceof Error ? error.message : String(error)}" next=${delayMs}ms`);
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
