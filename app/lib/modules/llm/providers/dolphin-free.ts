/**
 * Dolphin Free Provider — wraps the public chat.dphn.ai endpoint. No API key is
 * required, so Dolphin can be used freely from bolt.diy.
 *
 * Based on the user's Python client (dolphin.py):
 *   POST https://chat.dphn.ai/api/chat
 *     body: { messages, model: "dolphinserver:24B", template: "code-advanced" }
 *   → OpenAI-style SSE (`data: {choices:[{delta:{content}}]}`).
 */

import { BaseProvider } from '~/lib/modules/llm/base-provider';
import type { ModelInfo } from '~/lib/modules/llm/types';
import type { IProviderSetting } from '~/types/model';
import type { LanguageModelV1, LanguageModelV1CallOptions, LanguageModelV1StreamPart } from 'ai';
import { toOpenAIMessages, readOpenAISSE, collectText } from './free-utils';

const DOLPHIN_URL = 'https://chat.dphn.ai/api/chat';

class DolphinFreeModel implements LanguageModelV1 {
  readonly specificationVersion = 'v1' as const;
  readonly provider = 'DolphinFree';
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

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      accept: 'text/event-stream',
      Origin: 'https://chat.dphn.ai',
      Referer: 'https://chat.dphn.ai/',
      'User-Agent':
        'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36',
    };

    const payload = {
      messages,
      model: this.modelId,
      template: 'code-advanced',
    };

    const res = await fetch(DOLPHIN_URL, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    });

    if (!res.ok || !res.body) {
      const detail = await res.text().catch(() => '');
      throw new Error(
        `Dolphin Free: request failed (${res.status} ${res.statusText})${detail ? ` — ${detail.slice(0, 200)}` : ''}`,
      );
    }

    return {
      stream: readOpenAISSE(res.body),
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

export default class DolphinFreeProvider extends BaseProvider {
  name = 'DolphinFree';

  getApiKeyLink = 'https://chat.dphn.ai';
  labelForGetApiKey = 'No API key needed';

  config = {
    apiTokenKey: '', // no key required
  };

  staticModels: ModelInfo[] = [
    {
      name: 'dolphinserver:24B',
      label: 'Dolphin 24B (Free · Unlimited)',
      provider: 'DolphinFree',
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
    return new DolphinFreeModel(options.model);
  }
}
