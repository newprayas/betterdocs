import Groq from 'groq-sdk';

export class GroqService {
    private groq: Groq | null = null;
    private apiKey: string = '';

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
        model: string = 'llama-3.3-70b-versatile',
        options?: { temperature?: number; maxTokens?: number }
    ): Promise<string> {
        if (!this.groq) throw new Error('Groq not initialized');

        console.log('[GROQ SERVICE]', 'Generating response with model:', model);

        const messages: any[] = [];
        if (systemPrompt) {
            messages.push({ role: 'system', content: systemPrompt });
        }
        messages.push({ role: 'user', content: prompt });

        try {
            const completion = await this.groq.chat.completions.create({
                messages,
                model,
                temperature: options?.temperature ?? 0.7,
                max_completion_tokens: options?.maxTokens ?? 4096,
            });

            return completion.choices[0]?.message?.content || '';
        } catch (error) {
            console.error('[GROQ SERVICE ERROR]', error);
            throw error;
        }
    }

    async generateStreamingResponse(
        prompt: string,
        systemPrompt?: string,
        model: string = 'llama-3.3-70b-versatile',
        options?: {
            temperature?: number;
            maxTokens?: number;
            onChunk?: (chunk: string) => void;
        }
    ): Promise<void> {
        if (!this.groq) throw new Error('Groq not initialized');

        console.log('[GROQ SERVICE]', 'Generating streaming response with model:', model);

        const messages: any[] = [];
        if (systemPrompt) {
            messages.push({ role: 'system', content: systemPrompt });
        }
        messages.push({ role: 'user', content: prompt });

        try {
            const stream = await this.groq.chat.completions.create({
                messages,
                model,
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
            throw error;
        }
    }
}

export const groqService = new GroqService();
