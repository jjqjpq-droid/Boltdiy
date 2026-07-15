import { useStore } from '@nanostores/react';
import { ClientOnly } from 'remix-utils/client-only';
import { chatStore } from '~/lib/stores/chat';
import { classNames } from '~/utils/classNames';
import { HeaderActionButtons } from './HeaderActionButtons.client';
import { ChatDescription } from '~/lib/persistence/ChatDescription.client';

export function Header() {
  const chat = useStore(chatStore);

  return (
    <header
      className={classNames('flex items-center px-4 border-b h-[var(--header-height)]', {
        'border-transparent': !chat.started,
        'border-bolt-elements-borderColor': chat.started,
      })}
    >
      <div className="flex items-center gap-2 z-logo text-bolt-elements-textPrimary cursor-pointer">
        <div className="i-ph:sidebar-simple-duotone text-xl" />
        <a href="/" className="text-2xl font-semibold text-accent flex items-center">
          <img src="/ng-logo-light.png" alt="NG AI logo" className="h-8 w-auto inline-block dark:hidden" />
          <img src="/ng-logo-dark.png" alt="NG AI logo" className="h-8 w-auto inline-block hidden dark:block" />
        </a>
      </div>
      <a
        href="https://t.me/NGYT777GGG"
        target="_blank"
        rel="noopener noreferrer"
        className="ml-3 flex items-center gap-1.5 rounded-md bg-[#229ED9] px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-[#1b8ec2]"
      >
        <div className="i-ph:telegram-logo-fill text-base" />
        Join Telegram
      </a>
      {chat.started && ( // Display ChatDescription and HeaderActionButtons only when the chat has started.
        <>
          <span className="flex-1 px-4 truncate text-center text-bolt-elements-textPrimary">
            <ClientOnly>{() => <ChatDescription />}</ClientOnly>
          </span>
          <ClientOnly>
            {() => (
              <div className="">
                <HeaderActionButtons chatStarted={chat.started} />
              </div>
            )}
          </ClientOnly>
        </>
      )}
    </header>
  );
}
