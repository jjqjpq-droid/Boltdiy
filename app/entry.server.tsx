import type { AppLoadContext } from '@remix-run/cloudflare';
import { RemixServer } from '@remix-run/react';
import { isbot } from 'isbot';
import { renderToReadableStream } from 'react-dom/server';
import { renderHeadToString } from 'remix-island';
import { Head } from './root';
import { themeStore } from '~/lib/stores/theme';

export default async function handleRequest(
  request: Request,
  responseStatusCode: number,
  responseHeaders: Headers,
  remixContext: any,
  _loadContext: AppLoadContext,
) {
  const readable = await renderToReadableStream(<RemixServer context={remixContext} url={request.url} />, {
    signal: request.signal,
    onError(error: unknown) {
      // Ignore abort errors – these happen when the client disconnects early
      if (error instanceof Error && error.name === 'AbortError') {
        return;
      }
      console.error(error);
      responseStatusCode = 500;
    },
  });

  const body = new ReadableStream({
    start(controller) {
      const head = renderHeadToString({ request, remixContext, Head });

      // Helper: enqueue safely – the controller may already be closed if the
      // client disconnected while we were building the response.
      function safeEnqueue(chunk: Uint8Array) {
        try {
          controller.enqueue(chunk);
        } catch {
          // Ignore – controller already closed/errored
        }
      }

      function safeClose() {
        try {
          controller.close();
        } catch {
          // Ignore – already closed
        }
      }

      function safeError(err: unknown) {
        try {
          controller.error(err);
        } catch {
          // Ignore – already errored/closed
        }
      }

      const enc = new TextEncoder();
      safeEnqueue(
        new Uint8Array(
          enc.encode(
            `<!DOCTYPE html><html lang="en" data-theme="${themeStore.value}"><head>${head}</head><body><div id="root" class="w-full h-full">`,
          ),
        ),
      );

      const reader = readable.getReader();

      function read() {
        reader
          .read()
          .then(({ done, value }) => {
            if (done) {
              safeEnqueue(new Uint8Array(enc.encode('</div></body></html>')));
              safeClose();
              return;
            }
            safeEnqueue(value);
            read();
          })
          .catch((error) => {
            // AbortError is normal when the client disconnects early
            if (!(error instanceof Error && error.name === 'AbortError')) {
              safeError(error);
            }
            readable.cancel().catch(() => {});
          });
      }

      read();
    },

    cancel() {
      readable.cancel().catch(() => {});
    },
  });

  if (isbot(request.headers.get('user-agent') || '')) {
    await readable.allReady;
  }

  responseHeaders.set('Content-Type', 'text/html');

  // COEP require-corp blocks cross-origin sub-resources in preview iframes;
  // only enable these headers in production where SharedArrayBuffer is needed.
  if (process.env.NODE_ENV === 'production') {
    responseHeaders.set('Cross-Origin-Embedder-Policy', 'require-corp');
    responseHeaders.set('Cross-Origin-Opener-Policy', 'same-origin');
  }

  return new Response(body, {
    headers: responseHeaders,
    status: responseStatusCode,
  });
}
