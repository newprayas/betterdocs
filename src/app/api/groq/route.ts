import { NextRequest, NextResponse } from 'next/server';

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
    process.env.NEXT_PUBLIC_GROQ_API_1,
    process.env.NEXT_PUBLIC_GROQ_API_2,
    process.env.NEXT_PUBLIC_GROQ_API_3,
    process.env.NEXT_PUBLIC_GROQ_API_4,
    process.env.NEXT_PUBLIC_GROQ_API_5,
    process.env.NEXT_PUBLIC_GROQ_API_6,
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
    const body = (await req.json()) as ProxyRequest;
    const prompt = String(body.prompt || '').trim();
    const stream = Boolean(body.stream);
    const model = (body.model && body.model.trim()) || DEFAULT_MODEL;

    if (!prompt) {
      return NextResponse.json({ error: 'Prompt is required' }, { status: 400 });
    }

    const groqKeys = loadGroqApiKeys();
    if (groqKeys.length === 0) {
      return NextResponse.json(
        { error: 'Missing Groq API key. Set GROQ_API_1 through GROQ_API_6 in server environment variables.' },
        { status: 500 }
      );
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
          { status: 502 }
        );
      }

      const headers = new Headers();
      const contentType = groqResponse.headers.get('content-type') || 'text/event-stream; charset=utf-8';
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

    try {
      return NextResponse.json(JSON.parse(responseText), { status: groqResponse.status });
    } catch {
      return new NextResponse(responseText, {
        status: groqResponse.status,
        headers: {
          'content-type': groqResponse.headers.get('content-type') || 'text/plain; charset=utf-8',
        },
      });
    }
  } catch (error) {
    console.error('[API PROXY] Fatal Groq proxy error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to proxy Groq request' },
      { status: 500 }
    );
  }
}
