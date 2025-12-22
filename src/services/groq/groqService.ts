import Groq from 'groq-sdk';

// Rate limit error type for detection
interface RateLimitError {
    error?: {
        message?: string;
        type?: string;
        code?: string;
    };
}

export class GroqService {
    private groq: Groq | null = null;
    private apiKey: string = '';

    // Model rotation: alternate between these two models
    private readonly MODEL_A = 'moonshotai/kimi-k2-instruct';
    private readonly MODEL_B = 'moonshotai/kimi-k2-instruct-0905';
    private lastModelUsed: 'A' | 'B' = 'B'; // Start with B so first call uses A

    initialize(apiKey: string) {
        if (!apiKey || apiKey === this.apiKey) return;

        console.log('[GROQ SERVICE]', 'Initializing with key:', apiKey.substring(0, 7) + '...');
        this.apiKey = apiKey;
        this.groq = new Groq({
            apiKey: apiKey,
            dangerouslyAllowBrowser: true // Required for client-side usage in Next.js
        });
    }

    isInitialized(): boolean {
        return this.groq !== null;
    }

    // Get the next model to use (alternating)
    private getNextModel(): string {
        if (this.lastModelUsed === 'A') {
            this.lastModelUsed = 'B';
            console.log('[GROQ SERVICE]', 'Switching to Model B:', this.MODEL_B);
            return this.MODEL_B;
        } else {
            this.lastModelUsed = 'A';
            console.log('[GROQ SERVICE]', 'Switching to Model A:', this.MODEL_A);
            return this.MODEL_A;
        }
    }

    // Check if an error is a rate limit error
    private isRateLimitError(error: unknown): boolean {
        if (error && typeof error === 'object' && 'status' in error) {
            return (error as { status: number }).status === 429;
        }
        if (error instanceof Error && error.message.includes('429')) {
            return true;
        }
        return false;
    }

    // Extract wait time from rate limit error message
    private extractWaitTime(error: unknown): number {
        if (error instanceof Error) {
            const match = error.message.match(/try again in ([\d.]+)s/i);
            if (match) {
                return Math.ceil(parseFloat(match[1]));
            }
        }
        return 10; // Default wait time
    }

    async validateApiKey(apiKey: string): Promise<boolean> {
        try {
            const tempGroq = new Groq({ apiKey, dangerouslyAllowBrowser: true });
            await tempGroq.chat.completions.create({
                messages: [{ role: 'user', content: 'Ping' }],
                model: 'llama-3.3-70b-versatile',
                max_tokens: 1
            });
            return true;
        } catch (error) {
            console.error('[GROQ SERVICE]', 'API validation failed:', error);
            return false;
        }
    }

    async generateResponse(
        prompt: string,
        systemPrompt?: string,
        model?: string, // Ignored - we use rotation
        options?: { temperature?: number; maxTokens?: number }
    ): Promise<string> {
        if (!this.groq) throw new Error('Groq not initialized');

        const modelToUse = this.getNextModel();
        console.log('[GROQ SERVICE]', 'Generating response with model:', modelToUse);

        const messages: any[] = [];
        if (systemPrompt) {
            messages.push({ role: 'system', content: systemPrompt });
        }
        messages.push({ role: 'user', content: prompt });

        try {
            const completion = await this.groq.chat.completions.create({
                messages,
                model: modelToUse,
                temperature: options?.temperature ?? 0.7,
                max_completion_tokens: options?.maxTokens ?? 4096,
            });

            return completion.choices[0]?.message?.content || '';
        } catch (error) {
            console.error('[GROQ SERVICE ERROR]', error);

            // Handle rate limit errors gracefully
            if (this.isRateLimitError(error)) {
                const waitTime = this.extractWaitTime(error);
                console.log('[GROQ SERVICE]', `Rate limited. Wait time: ${waitTime}s`);
                return `⚠️ You are asking too many questions too fast. Please wait for ${waitTime} seconds before asking again.`;
            }

            throw error;
        }
    }

    async generateStreamingResponse(
        prompt: string,
        systemPrompt?: string,
        model?: string, // Ignored - we use rotation
        options?: {
            temperature?: number;
            maxTokens?: number;
            onChunk?: (chunk: string) => void;
        }
    ): Promise<void> {
        if (!this.groq) throw new Error('Groq not initialized');

        const modelToUse = this.getNextModel();
        console.log('[GROQ SERVICE]', 'Generating streaming response with model:', modelToUse);

        const messages: any[] = [];
        if (systemPrompt) {
            messages.push({ role: 'system', content: systemPrompt });
        }
        messages.push({ role: 'user', content: prompt });

        try {
            const stream = await this.groq.chat.completions.create({
                messages,
                model: modelToUse,
                temperature: options?.temperature ?? 0.7,
                max_completion_tokens: options?.maxTokens ?? 4096,
                stream: true,
            });

            for await (const chunk of stream) {
                const content = chunk.choices[0]?.delta?.content || '';
                if (content && options?.onChunk) {
                    options.onChunk(content);
                }
            }
        } catch (error) {
            console.error('[GROQ SERVICE STREAM ERROR]', error);

            // Handle rate limit errors gracefully
            if (this.isRateLimitError(error)) {
                const waitTime = this.extractWaitTime(error);
                console.log('[GROQ SERVICE]', `Rate limited during streaming. Wait time: ${waitTime}s`);

                // Send rate limit message as a chunk
                if (options?.onChunk) {
                    options.onChunk(`⚠️ You are asking too many questions too fast. Please wait for ${waitTime} seconds before asking again.`);
                }
                return; // Don't throw, we've handled it
            }

            throw error;
        }
    }
}

export const groqService = new GroqService();

