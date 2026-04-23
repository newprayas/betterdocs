import { createHash } from 'crypto';
import { kv } from '@vercel/kv';
import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/utils/supabase/server';

export const dynamic = 'force-dynamic';

const GROQ_BASE_URL = 'https://api.groq.com/openai/v1';
const DEFAULT_MODEL = 'groq/compound';

type ChatMessage = {
  role: 'system' | 'user' | 'assistant';
  content: string;
};

type ProxyRequest = {
  prompt?: string;
  systemPrompt?: string;
  model?: string;
  temperature?: number;
  maxTokens?: number;
  stream?: boolean;
  cacheKeyPrefix?: string;
};

type CachedGroqResponse = {
  status: number;
  contentType: string;
  body: string;
  cachedAt: string;
};

const isKvConfigured = (): boolean =>
  Boolean(
    (process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN) ||
      (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN),
  );

const buildCacheKey = (prefix: string, body: ProxyRequest): string => {
  const hash = createHash('sha256');
  hash.update(prefix);
  hash.update('\n');
  hash.update(String(body.prompt || ''));
  hash.update('\n');
  hash.update(String(body.systemPrompt || ''));
  hash.update('\n');
  hash.update(String(body.model || ''));
  hash.update('\n');
  hash.update(String(body.temperature ?? ''));
  hash.update('\n');
  hash.update(String(body.maxTokens ?? ''));
  return `groq:${prefix}:${hash.digest('hex')}`;
};

const tryParseJson = (text: string): unknown | null => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

let groqRotationIndex = 0;

function loadGroqApiKeys(): string[] {
  const explicitKeys = [
    process.env.GROQ_API_1,
    process.env.GROQ_API_2,
    process.env.GROQ_API_3,
    process.env.GROQ_API_4,
    process.env.GROQ_API_5,
    process.env.GROQ_API_6,
    process.env.GROQ_API_7,
  ];

  return explicitKeys
    .map((key) => String(key || '').trim())
    .filter((key) => key.length > 0)
    .filter((key, index, array) => array.indexOf(key) === index);
}

function getNextKey(keys: string[]): string {
  if (keys.length === 0) {
    throw new Error('No Groq API keys are configured on the server');
  }

  const key = keys[groqRotationIndex % keys.length];
  groqRotationIndex = (groqRotationIndex + 1) % keys.length;
  return key;
}

function buildMessages(prompt: string, systemPrompt?: string): ChatMessage[] {
  const messages: ChatMessage[] = [];
  if (systemPrompt) {
    messages.push({ role: 'system', content: systemPrompt });
  }
  messages.push({ role: 'user', content: prompt });
  return messages;
}

async function parseGroqError(response: Response): Promise<string> {
  const text = await response.text();
  if (!text) {
    return `${response.status} ${response.statusText}`;
  }

  try {
    const json = JSON.parse(text);
    const msg = json?.error?.message || json?.message;
    if (typeof msg === 'string' && msg.trim()) {
      return msg;
    }
  } catch {
    // non-json response
  }

  return `${response.status} ${response.statusText}: ${text.slice(0, 300)}`;
}

export async function POST(req: NextRequest) {
  try {
    const supabase = createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = (await req.json()) as ProxyRequest;
    const prompt = String(body.prompt || '').trim();
    const stream = Boolean(body.stream);
    const model = (body.model && body.model.trim()) || DEFAULT_MODEL;
    const cacheKeyPrefix = String(body.cacheKeyPrefix || '').trim();
    const cacheKey = !stream && cacheKeyPrefix ? buildCacheKey(cacheKeyPrefix, { ...body, prompt, model }) : null;

    if (!prompt) {
      return NextResponse.json({ error: 'Prompt is required' }, { status: 400 });
    }

    const groqKeys = loadGroqApiKeys();
    if (groqKeys.length === 0) {
      return NextResponse.json(
        { error: 'Missing Groq API key. Set GROQ_API_1 through GROQ_API_7 in server environment variables.' },
        { status: 500 },
      );
    }

    if (cacheKey && isKvConfigured()) {
      const cached = await kv.get<CachedGroqResponse>(cacheKey);
      if (cached) {
        const parsed = tryParseJson(cached.body);
        console.log('[API PROXY] Groq cache hit', {
          cacheKey,
          status: cached.status,
        });
        if (parsed !== null) {
          return NextResponse.json(parsed, {
            status: cached.status,
            headers: {
              'content-type': cached.contentType || 'application/json; charset=utf-8',
            },
          });
        }
        return new NextResponse(cached.body, {
          status: cached.status,
          headers: {
            'content-type': cached.contentType || 'text/plain; charset=utf-8',
          },
        });
      }
    }

    const groqApiKey = getNextKey(groqKeys);

    const groqResponse = await fetch(`${GROQ_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${groqApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        stream,
        messages: buildMessages(prompt, body.systemPrompt),
        temperature: body.temperature ?? 0.7,
        max_tokens: body.maxTokens ?? 4096,
        top_p: 1,
      }),
    });

    if (!groqResponse.ok) {
      const errorText = await parseGroqError(groqResponse);
      console.error('[API PROXY] Groq request failed:', errorText);
      return NextResponse.json({ error: errorText }, { status: groqResponse.status });
    }

    if (stream) {
      if (!groqResponse.body) {
        return NextResponse.json(
          { error: 'Streaming response body is not available' },
          { status: 502 },
        );
      }

      const headers = new Headers();
      const contentType =
        groqResponse.headers.get('content-type') || 'text/event-stream; charset=utf-8';
      headers.set('content-type', contentType);
      headers.set('cache-control', 'no-cache, no-transform');
      headers.set('x-accel-buffering', 'no');

      return new Response(groqResponse.body, {
        status: groqResponse.status,
        headers,
      });
    }

    const responseText = await groqResponse.text();
    if (!responseText) {
      return NextResponse.json({}, { status: 200 });
    }

    if (cacheKey && groqResponse.ok && isKvConfigured()) {
      const cachedResponse: CachedGroqResponse = {
        status: groqResponse.status,
        contentType: groqResponse.headers.get('content-type') || 'application/json; charset=utf-8',
        body: responseText,
        cachedAt: new Date().toISOString(),
      };
      await kv.set(cacheKey, cachedResponse);
      console.log('[API PROXY] Groq cache stored', {
        cacheKey,
        status: cachedResponse.status,
      });
    }

    try {
      return NextResponse.json(JSON.parse(responseText), { status: groqResponse.status });
    } catch {
      return new NextResponse(responseText, {
        status: groqResponse.status,
        headers: {
          'content-type':
            groqResponse.headers.get('content-type') || 'text/plain; charset=utf-8',
        },
      });
    }
  } catch (error) {
    console.error('[API PROXY] Fatal Groq proxy error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to proxy Groq request' },
      { status: 500 },
    );
  }
}
