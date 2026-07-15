/**
 * Qwen3-Coder Free Provider — wraps the public Qwen3-Coder WebDev Gradio Space
 * on Hugging Face. No API key is required, so it can be used freely.
 *
 * Based on the user's Python client (qwen.py):
 *   1. POST {URL}/gradio_api/queue/join
 *        body: { data: [msg, "", history], fn_index: 19, session_hash }
 *   2. GET  {URL}/gradio_api/queue/data?session_hash=...   (SSE)
 *        → `process_generating` events whose output.data[0] is a list of
 *          ["append", <path>, <token>] items we relay as text deltas.
 */

import { BaseProvider } from '~/lib/modules/llm/base-provider';
import type { ModelInfo } from '~/lib/modules/llm/types';
import type { IProviderSetting } from '~/types/model';
import type { LanguageModelV1, LanguageModelV1CallOptions, LanguageModelV1StreamPart } from 'ai';
import { toOpenAIMessages, collectText } from './free-utils';

const QWEN_SPACE = 'https://qwen-qwen3-coder-webdev.hf.space';
const FN_INDEX = 19;

function randomSessionHash(): string {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let hash = '';

  for (let i = 0; i < 12; i++) {
    hash += chars[Math.floor(Math.random() * chars.length)];
  }

  return hash;
}

class QwenFreeModel implements LanguageModelV1 {
  readonly specificationVersion = 'v1' as const;
  readonly provider = 'QwenFree';
  readonly modelId: string;
  readonly defaultObjectGenerationMode = undefined;
  readonly supportsImageUrls = false;

  constructor(modelId: string) {
    this.modelId = modelId;
  }

  async doStream(options: LanguageModelV1CallOptions): Promise<{
    stream: ReadableStream<LanguageModelV1StreamPart>;
    rawCall: { rawPrompt: unknown; rawSettings: Record<string, unknown> };
  }> {
    const messages = toOpenAIMessages(options.prompt);

    // Combine all system instructions — bolt.diy relies on them for output format.
    const systemText = messages
      .filter((m) => m.role === 'system')
      .map((m) => m.content)
      .join('\n\n');

    // Prior conversation (everything except system + the final user turn).
    const nonSystem = messages.filter((m) => m.role !== 'system');
    const lastUser = [...nonSystem].reverse().find((m) => m.role === 'user');
    const history = nonSystem
      .filter((m) => m !== lastUser)
      .map((m) => ({ role: m.role, content: m.content }));

    // Prepend the system prompt to the current query so the Space model sees it.
    const query = `${systemText ? `${systemText}\n\n` : ''}${lastUser?.content ?? ''}`;

    const sessionHash = randomSessionHash();

    // Step 1 — join the queue.
    const joinRes = await fetch(`${QWEN_SPACE}/gradio_api/queue/join`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: QWEN_SPACE,
        Referer: `${QWEN_SPACE}/`,
      },
      body: JSON.stringify({
        data: [query, '', history],
        fn_index: FN_INDEX,
        session_hash: sessionHash,
      }),
    });

    if (!joinRes.ok) {
      const detail = await joinRes.text().catch(() => '');
      throw new Error(
        `Qwen Free: queue join failed (${joinRes.status} ${joinRes.statusText})${detail ? ` — ${detail.slice(0, 200)}` : ''}`,
      );
    }

    // Step 2 — read the queue data SSE stream.
    const dataRes = await fetch(`${QWEN_SPACE}/gradio_api/queue/data?session_hash=${sessionHash}`, {
      method: 'GET',
      headers: {
        accept: 'text/event-stream',
        Referer: `${QWEN_SPACE}/`,
      },
    });

    if (!dataRes.ok || !dataRes.body) {
      const detail = await dataRes.text().catch(() => '');
      throw new Error(
        `Qwen Free: queue data failed (${dataRes.status} ${dataRes.statusText})${detail ? ` — ${detail.slice(0, 200)}` : ''}`,
      );
    }

    const body = dataRes.body;

    const stream = new ReadableStream<LanguageModelV1StreamPart>({
      async start(controller) {
        const reader = body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let done = false;

        const handleLine = (line: string) => {
          const trimmed = line.trim();

          if (!trimmed.startsWith('data:')) {
            return;
          }

          const raw = trimmed.slice(5).trim();

          if (!raw) {
            return;
          }

          let json: any;

          try {
            json = JSON.parse(raw);
          } catch {
            return;
          }

          const msg = json?.msg;

          if (msg === 'process_generating') {
            const chunks = json?.output?.data;

            if (Array.isArray(chunks) && Array.isArray(chunks[0])) {
              for (const item of chunks[0]) {
                if (Array.isArray(item) && item[0] === 'append' && typeof item[2] === 'string') {
                  controller.enqueue({ type: 'text-delta', textDelta: item[2] });
                }
              }
            }
          } else if (msg === 'process_completed' || msg === 'close_stream') {
            done = true;
          }
        };

        try {
          while (!done) {
            const { done: readerDone, value } = await reader.read();

            if (readerDone) {
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

    return {
      stream,
      rawCall: { rawPrompt: options.prompt, rawSettings: {} },
    };
  }

  async doGenerate(options: LanguageModelV1CallOptions): Promise<{
    text?: string;
    finishReason: 'stop';
    usage: { promptTokens: number; completionTokens: number };
    rawCall: { rawPrompt: unknown; rawSettings: Record<string, unknown> };
  }> {
    const { stream } = await this.doStream(options);
    const text = await collectText(stream);

    return {
      text,
      finishReason: 'stop',
      usage: { promptTokens: 0, completionTokens: 0 },
      rawCall: { rawPrompt: options.prompt, rawSettings: {} },
    };
  }
}

export default class QwenFreeProvider extends BaseProvider {
  name = 'QwenFree';

  getApiKeyLink = 'https://huggingface.co/spaces/Qwen/Qwen3-Coder-WebDev';
  labelForGetApiKey = 'No API key needed';

  config = {
    apiTokenKey: '', // no key required
  };

  staticModels: ModelInfo[] = [
    {
      name: 'qwen3-coder-webdev',
      label: 'Qwen3-Coder WebDev (Free · Unlimited)',
      provider: 'QwenFree',
      maxTokenAllowed: 8000,
      maxCompletionTokens: 8000,
    },
  ];

  getModelInstance(options: {
    model: string;
    serverEnv?: Env;
    apiKeys?: Record<string, string>;
    providerSettings?: Record<string, IProviderSetting>;
  }): LanguageModelV1 {
    return new QwenFreeModel(options.model);
  }
}
