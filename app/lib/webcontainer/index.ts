import { WebContainer } from '@webcontainer/api';
import { WORK_DIR_NAME } from '~/utils/constants';
import { cleanStackTrace } from '~/utils/stacktrace';

interface WebContainerContext {
  loaded: boolean;
}

export const webcontainerContext: WebContainerContext = import.meta.hot?.data.webcontainerContext ?? {
  loaded: false,
};

if (import.meta.hot) {
  import.meta.hot.data.webcontainerContext = webcontainerContext;
}

export let webcontainer: Promise<WebContainer> = new Promise(() => {
  // noop for ssr
});

// WebContainer relies on SharedArrayBuffer, which is only available when the
// document is cross-origin isolated. When bolt.diy is embedded in a nested
// iframe that does not grant cross-origin isolation (e.g. the v0 in-app
// preview), booting would throw a flood of `DataCloneError`s. Detect this up
// front and skip the boot with a single clear warning instead.
const canBootWebContainer = typeof SharedArrayBuffer !== 'undefined' && globalThis.crossOriginIsolated === true;

if (!import.meta.env.SSR) {
  if (!canBootWebContainer && !import.meta.hot?.data.webcontainer) {
    console.warn(
      '[v0] WebContainer disabled: this page is not cross-origin isolated (SharedArrayBuffer unavailable). ' +
        'Open the deployed app or the preview in a new browser tab to enable the in-browser dev environment.',
    );
  }

  webcontainer =
    import.meta.hot?.data.webcontainer ??
    (!canBootWebContainer
      ? new Promise<WebContainer>(() => {
          // Not cross-origin isolated: never boot, never throw. Leaves the app
          // usable (chat, models, UI) without the WebContainer sandbox.
        })
      : Promise.resolve()
          .then(() => {
            return WebContainer.boot({
              coep: 'credentialless',
              workdirName: WORK_DIR_NAME,
              forwardPreviewErrors: true, // Enable error forwarding from iframes
            });
          })
          .then(async (webcontainer) => {
        webcontainerContext.loaded = true;

        const { workbenchStore } = await import('~/lib/stores/workbench');

        const response = await fetch('/inspector-script.js');
        const inspectorScript = await response.text();
        await webcontainer.setPreviewScript(inspectorScript);

        // Listen for preview errors
        webcontainer.on('preview-message', (message) => {
          console.log('WebContainer preview message:', message);

          // Handle both uncaught exceptions and unhandled promise rejections
          if (message.type === 'PREVIEW_UNCAUGHT_EXCEPTION' || message.type === 'PREVIEW_UNHANDLED_REJECTION') {
            const isPromise = message.type === 'PREVIEW_UNHANDLED_REJECTION';
            const title = isPromise ? 'Unhandled Promise Rejection' : 'Uncaught Exception';
            workbenchStore.actionAlert.set({
              type: 'preview',
              title,
              description: 'message' in message ? message.message : 'Unknown error',
              content: `Error occurred at ${message.pathname}${message.search}${message.hash}\nPort: ${message.port}\n\nStack trace:\n${cleanStackTrace(message.stack || '')}`,
              source: 'preview',
            });
          }
        });

        return webcontainer;
      }));

  if (import.meta.hot) {
    import.meta.hot.data.webcontainer = webcontainer;
  }
}
