/**
 * Perplexity Unlimited Provider — wraps Perplexity's mobile "perplexity_ask"
 * SSE endpoint used by the Android app. No API key is required, so it can be
 * used freely from bolt.diy just like any other provider.
 *
 * Based on the user's Python client (pepunlimitedclaudemax.py):
 *   POST https://www.perplexity.ai/rest/sse/perplexity_ask
 *     headers: Android app identity headers
 *     body:    { query_str, params: { ... } }
 *   → text/event-stream of `data: {json}` lines with the accumulating answer.
 *
 * We convert that stream into a LanguageModelV1 so it appears in the model
 * picker and works with bolt.diy's native generation workflow.
 */

import { BaseProvider } from '~/lib/modules/llm/base-provider';
import type { ModelInfo } from '~/lib/modules/llm/types';
import type { IProviderSetting } from '~/types/model';
import type { LanguageModelV1, LanguageModelV1CallOptions, LanguageModelV1StreamPart } from 'ai';

// ── Constants ────────────────────────────────────────────────────────────────

const PPLX_ASK_URL = 'https://www.perplexity.ai/rest/sse/perplexity_ask';

/** Generate a random 16-hex-char Android device id so requests aren't tied to a single device. */
function randomDeviceHex(): string {
  let hex = '';

  for (let i = 0; i < 16; i++) {
    hex += Math.floor(Math.random() * 16).toString(16);
  }

  return hex;
}

/** Minimal UUID v4 generator (crypto.randomUUID may be unavailable in some runtimes). */
function uuidv4(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }

  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;

    return v.toString(16);
  });
}

// ── Custom LanguageModelV1 implementation ────────────────────────────────────

class PerplexityUnlimitedModel implements LanguageModelV1 {
  readonly specificationVersion = 'v1' as const;
  readonly provider = 'PerplexityUnlimited';
  readonly modelId: string;
  readonly defaultObjectGenerationMode = undefined;
  readonly supportsImageUrls = false;

  constructor(modelId: string) {
    this.modelId = modelId;
  }

  /**
   * Perplexity's ask endpoint takes a single query string (no chat roles), so
   * we flatten the whole conversation — system prompt + prior turns + current
   * user message — into one prompt. bolt.diy relies on the system prompt for
   * its file/format instructions, so it must be preserved.
   */
  private buildQuery(prompt: LanguageModelV1CallOptions['prompt']): string {
    const parts: string[] = [];

    for (const msg of prompt) {
      if (msg.role === 'system') {
        parts.push(String(msg.content));
        continue;
      }

      if (msg.role === 'user') {
        const text = msg.content
          .filter((p) => p.type === 'text')
          .map((p) => (p as { type: 'text'; text: string }).text)
          .join('');

        if (text) {
          parts.push(`User: ${text}`);
        }

        continue;
      }

      if (msg.role === 'assistant') {
        const content = msg.content;
        const text =
          typeof content === 'string'
            ? content
            : content
                .filter((p) => p.type === 'text')
                .map((p) => (p as { type: 'text'; text: string }).text)
                .join('');

        if (text) {
          parts.push(`Assistant: ${text}`);
        }

        continue;
      }
    }

    return parts.join('\n\n');
  }

  /** The model id maps to Perplexity's `model_preference` field. */
  private modelPreference(): string {
    // Model ids are defined in the provider's staticModels below.
    return this.modelId || 'turbo';
  }

  // ── doStream ───────────────────────────────────────────────────────────────

  async doStream(options: LanguageModelV1CallOptions): Promise<{
    stream: ReadableStream<LanguageModelV1StreamPart>;
    rawCall: { rawPrompt: unknown; rawSettings: Record<string, unknown> };
  }> {
    const query = this.buildQuery(options.prompt);
    const deviceHex = randomDeviceHex();

    const headers: Record<string, string> = {
      host: 'www.perplexity.ai',
      accept: 'text/event-stream',
      'user-agent':
        'Ask/2.65.1/260516 (Android; Version 16; vivo V2502/PD2456KF_EX_A_16.1.14.0.W30) SDK 36',
      'x-app-version': '2.65.1',
      'x-client-version': '2.65.1',
      'x-client-name': 'Perplexity-Android',
      'x-client-env': 'prod',
      'x-app-apiclient': 'android',
      'x-app-apiversion': '2.17',
      'accept-language': 'en-US',
      'x-device-id': `android:${deviceHex}`,
      'content-type': 'application/json; charset=utf-8',
    };

    const payload = {
      query_str: query,
      params: {
        source: 'android',
        version: '2.17',
        frontend_uuid: uuidv4(),
        android_device_id: deviceHex,
        mode: 'concise',
        is_related_query: false,
        is_voice_to_voice: false,
        timezone: 'Asia/Kolkata',
        language: 'en-US',
        query_source: 'home',
        is_incognito: false,
        use_schematized_api: true,
        // Ask the API to include the answer text in the stream so we can relay it.
        send_back_text_in_streaming_api: true,
        supported_block_use_cases: [
          'answer_modes',
          'finance_widgets',
          'inline_assets',
          'inline_entity_cards',
          'inline_images',
          'knowledge_cards',
          'media_items',
          'place_widgets',
          'placeholder_cards',
          'search_result_widgets',
          'shopping_widgets',
          'sports_widgets',
          'prediction_market_widgets',
        ],
        sources: ['web'],
        model_preference: this.modelPreference(),
      },
    };

    const res = await fetch(PPLX_ASK_URL, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    });

    if (!res.ok || !res.body) {
      const detail = await res.text().catch(() => '');
      throw new Error(
        `Perplexity Unlimited: request failed (${res.status} ${res.statusText})${detail ? ` — ${detail.slice(0, 200)}` : ''}`,
      );
    }

    const body = res.body;

    // Pull the accumulated answer out of whatever shape the SSE event carries.
    const extractAnswer = (json: any): string | null => {
      if (!json || typeof json !== 'object') {
        return null;
      }

      // Schematized API: blocks[].markdown_block.answer (accumulating string)
      if (Array.isArray(json.blocks)) {
        for (const block of json.blocks) {
          const md = block?.markdown_block;

          if (md && typeof md.answer === 'string') {
            return md.answer;
          }

          if (md && Array.isArray(md.chunks)) {
            return md.chunks.join('');
          }
        }
      }

      if (typeof json.answer === 'string') {
        return json.answer;
      }

      // Some responses nest a JSON string under `text`.
      if (typeof json.text === 'string') {
        try {
          const inner = JSON.parse(json.text);

          if (inner && typeof inner.answer === 'string') {
            return inner.answer;
          }
        } catch {
          // Plain text payload — return as-is.
          return json.text;
        }
      }

      return null;
    };

    const stream = new ReadableStream<LanguageModelV1StreamPart>({
      async start(controller) {
        const reader = body.getReader();
        const decoder = new TextDecoder();
        let lineBuffer = '';
        let fullAnswer = '';

        const flushLine = (line: string) => {
          if (!line.startsWith('data:')) {
            return;
          }

          const raw = line.slice(5).trim();

          if (!raw || raw === '[DONE]') {
            return;
          }

          let json: unknown;

          try {
            json = JSON.parse(raw);
          } catch {
            return; // non-JSON control line
          }

          const answer = extractAnswer(json);

          if (answer != null && answer.length > fullAnswer.length) {
            const delta = answer.slice(fullAnswer.length);
            fullAnswer = answer;
            controller.enqueue({ type: 'text-delta', textDelta: delta });
          }
        };

        try {
          while (true) {
            const { done, value } = await reader.read();

            if (done) {
              break;
            }

            lineBuffer += decoder.decode(value, { stream: true });

            const lines = lineBuffer.split('\n');
            lineBuffer = lines.pop() ?? '';

            for (const line of lines) {
              flushLine(line.trim());
            }
          }

          // Flush any trailing buffered line.
          if (lineBuffer.trim()) {
            flushLine(lineBuffer.trim());
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

  // ── doGenerate ─────────────────────────────────────────────────────────────

  async doGenerate(options: LanguageModelV1CallOptions): Promise<{
    text?: string;
    finishReason: 'stop';
    usage: { promptTokens: number; completionTokens: number };
    rawCall: { rawPrompt: unknown; rawSettings: Record<string, unknown> };
  }> {
    const { stream } = await this.doStream(options);
    const reader = stream.getReader();
    let fullText = '';

    while (true) {
      const { done, value } = await reader.read();

      if (done) {
        break;
      }

      if (value.type === 'text-delta') {
        fullText += value.textDelta;
      }
    }

    return {
      text: fullText,
      finishReason: 'stop',
      usage: { promptTokens: 0, completionTokens: 0 },
      rawCall: { rawPrompt: options.prompt, rawSettings: {} },
    };
  }
}

// ── BaseProvider subclass ────────────────────────────────────────────────────

export default class PerplexityUnlimitedProvider extends BaseProvider {
  name = 'PerplexityUnlimited';

  // No API key is required — this uses Perplexity's public mobile ask endpoint.
  getApiKeyLink = 'https://www.perplexity.ai';
  labelForGetApiKey = 'No API key needed';

  config = {
    apiTokenKey: '', // intentionally empty — no key required
  };

  staticModels: ModelInfo[] = [
    {
      name: 'turbo',
      label: 'Perplexity Unlimited (Free · No Key)',
      provider: 'PerplexityUnlimited',
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
    return new PerplexityUnlimitedModel(options.model);
  }
}
