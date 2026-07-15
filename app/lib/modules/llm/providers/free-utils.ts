/**
 * Shared helpers for the "free / unlimited" providers (GLM-4.5, Dolphin,
 * Qwen3-Coder). These providers wrap public, no-API-key chat endpoints and
 * expose them to bolt.diy as standard `LanguageModelV1` instances.
 */

import type { LanguageModelV1CallOptions, LanguageModelV1StreamPart } from 'ai';

export interface OpenAIStyleMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/** Extract plain text from a bolt.diy content part array (or string). */
function partsToText(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }

  if (Array.isArray(content)) {
    return content
      .filter((p) => p && (p as { type?: string }).type === 'text')
      .map((p) => (p as { type: 'text'; text: string }).text)
      .join('');
  }

  return '';
}

/**
 * Convert bolt.diy's AI-SDK prompt (system + multi-role turns) into a flat
 * OpenAI-style messages array. The system prompt carries bolt.diy's file /
 * artifact formatting instructions, so it must be preserved.
 */
export function toOpenAIMessages(prompt: LanguageModelV1CallOptions['prompt']): OpenAIStyleMessage[] {
  const messages: OpenAIStyleMessage[] = [];

  for (const msg of prompt) {
    if (msg.role === 'system') {
      messages.push({ role: 'system', content: String(msg.content) });
      continue;
    }

    if (msg.role === 'user') {
      messages.push({ role: 'user', content: partsToText(msg.content) });
      continue;
    }

    if (msg.role === 'assistant') {
      messages.push({ role: 'assistant', content: partsToText(msg.content) });
      continue;
    }

    // Tool messages are not supported by these simple chat endpoints — skip.
  }

  return messages;
}

/**
 * Read an OpenAI-compatible `text/event-stream` (`data: {choices:[{delta:{content}}]}`)
 * and emit AI-SDK stream parts. Used by GLM-4.5 (DeepInfra) and Dolphin.
 */
export function readOpenAISSE(body: ReadableStream<Uint8Array>): ReadableStream<LanguageModelV1StreamPart> {
  return new ReadableStream<LanguageModelV1StreamPart>({
    async start(controller) {
      const reader = body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      const handleLine = (line: string) => {
        const trimmed = line.trim();

        if (!trimmed.startsWith('data:')) {
          return;
        }

        const raw = trimmed.slice(5).trim();

        if (!raw || raw === '[DONE]') {
          return;
        }

        try {
          const json = JSON.parse(raw);
          const delta = json?.choices?.[0]?.delta;
          const content = delta?.content;

          if (typeof content === 'string' && content.length > 0) {
            controller.enqueue({ type: 'text-delta', textDelta: content });
          }
        } catch {
          // Ignore keep-alive / non-JSON control lines.
        }
      };

      try {
        while (true) {
          const { done, value } = await reader.read();

          if (done) {
            break;
          }

          buffer += decoder.decode(value, { stream: true });

          const lines = buffer.split('\n');
          buffer = lines.pop() ?? '';

          for (const line of lines) {
            handleLine(line);
          }
        }

        if (buffer.trim()) {
          handleLine(buffer);
        }
      } catch (err) {
        controller.error(err);
        return;
      }

      controller.enqueue({
        type: 'finish',
        finishReason: 'stop',
        usage: { promptTokens: 0, completionTokens: 0 },
      });
      controller.close();
    },
  });
}

/**
 * Collapse a stream of AI-SDK parts into the final generated text. Shared by
 * every free provider's `doGenerate`.
 */
export async function collectText(stream: ReadableStream<LanguageModelV1StreamPart>): Promise<string> {
  const reader = stream.getReader();
  let text = '';

  while (true) {
    const { done, value } = await reader.read();

    if (done) {
      break;
    }

    if (value.type === 'text-delta') {
      text += value.textDelta;
    }
  }

  return text;
}
