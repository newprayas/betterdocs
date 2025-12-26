
import { GoogleGenAI } from '@google/genai';
import { NextRequest, NextResponse } from 'next/server';

// Initialize keys from server-side environment variables
const keys = [
    process.env.EMBEDDING_KEY_1 || process.env.NEXT_PUBLIC_EMBEDDING_KEY_1,
    process.env.EMBEDDING_KEY_2 || process.env.NEXT_PUBLIC_EMBEDDING_KEY_2,
    process.env.EMBEDDING_KEY_3 || process.env.NEXT_PUBLIC_EMBEDDING_KEY_3,
].filter(Boolean) as string[];

let currentKeyIndex = 0;

function getClient() {
    if (keys.length === 0) {
        throw new Error('No server-side embedding keys configured');
    }
    const key = keys[currentKeyIndex];
    return new GoogleGenAI({ apiKey: key });
}

function rotateKey() {
    if (keys.length <= 1) return;
    currentKeyIndex = (currentKeyIndex + 1) % keys.length;
    console.log(`[API PROXY] Rotated to embedding key index ${currentKeyIndex}`);
}

export async function POST(req: NextRequest) {
    try {
        const body = await req.json();
        const { text } = body;

        if (!text) {
            return NextResponse.json({ error: 'Text is required' }, { status: 400 });
        }

        // Try up to 3 times (once per key if available)
        let lastError = null;
        const maxRetries = Math.min(keys.length, 3);

        for (let attempt = 0; attempt < maxRetries; attempt++) {
            try {
                const client = getClient();
                const result = await client.models.embedContent({
                    model: 'text-embedding-004',
                    contents: text
                });

                const embedding = result.embeddings?.[0];
                const values = embedding?.values || [];

                return NextResponse.json({ embedding: values });
            } catch (error) {
                lastError = error;
                console.error(`[API PROXY] Attempt ${attempt + 1} failed:`, error);
                rotateKey();
            }
        }

        throw lastError || new Error('All keys exhausted');
    } catch (error: any) {
        console.error('[API PROXY] Fatal error:', error);
        return NextResponse.json(
            { error: 'Failed to process embedding', details: error.message },
            { status: 500 }
        );
    }
}
