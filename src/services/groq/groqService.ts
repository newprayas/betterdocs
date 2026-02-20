const CEREBRAS_BASE_URL = 'https://api.cerebras.ai/v1';
const DEFAULT_MODEL = 'gpt-oss-120b';

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

  constructor() {
    this.envApiKeys = this.loadEnvApiKeys();
    console.log('[CEREBRAS SERVICE]', `Loaded ${this.envApiKeys.length} env API key(s)`);
  }

  private loadEnvApiKeys(): string[] {
    const keys: string[] = [];
    for (let i = 1; i <= 6; i++) {
      const key =
        process.env[`NEXT_PUBLIC_CEREBRAS_API_${i}` as keyof NodeJS.ProcessEnv] ||
        process.env[`CEREBRAS_API_${i}` as keyof NodeJS.ProcessEnv] ||
        process.env[`Cerebras_API_${i}` as keyof NodeJS.ProcessEnv] ||
        '';
      const trimmed = String(key).trim();
      if (trimmed) {
        keys.push(trimmed);
      }
    }
    return keys;
  }

  private getAllAvailableKeys(): string[] {
    const keys = [...this.envApiKeys];
    if (this.apiKey.trim()) {
      keys.push(this.apiKey.trim());
    }
    // Deduplicate while preserving order
    return keys.filter((k, idx) => keys.indexOf(k) === idx);
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

  async validateApiKey(apiKey: string): Promise<boolean> {
    try {
      const response = await fetch(`${CEREBRAS_BASE_URL}/chat/completions`, {
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
      });

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
      const response = await fetch(`${CEREBRAS_BASE_URL}/chat/completions`, {
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
      });

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

  async generateStreamingResponse(
    prompt: string,
    systemPrompt?: string,
    model?: string,
    options?: {
      temperature?: number;
      maxTokens?: number;
      onChunk?: (chunk: string) => void;
    }
  ): Promise<void> {
    if (!this.isInitialized()) {
      throw new Error('Cerebras service not initialized');
    }

    const modelToUse = this.getModel(model);
    console.log('[CEREBRAS SERVICE]', 'Generating streaming response with model:', modelToUse);

    const response = await fetch(`${CEREBRAS_BASE_URL}/chat/completions`, {
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
    });

    if (!response.ok) {
      const errMessage = await this.parseErrorBody(response);
      console.error('[CEREBRAS SERVICE STREAM ERROR]', errMessage);

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

    while (true) {
      const { done, value } = await reader.read();
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
  }
}

export const groqService = new GroqService();
