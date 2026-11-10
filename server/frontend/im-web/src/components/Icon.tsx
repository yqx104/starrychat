import type { SVGProps } from 'react';

type Name = 'chat' | 'users' | 'plus' | 'search' | 'arrowLeft' | 'more' | 'send' | 'at' | 'close' | 'chevronDown' | 'reply' | 'check' | 'settings' | 'sparkle' | 'logout' | 'refresh' | 'group' | 'info';
const paths: Record<Name, React.ReactNode> = {
  chat: <><path d="M5 5.5h14a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H10l-5 3v-3a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2Z"/><path d="M7.5 10h9M7.5 13.5h6"/></>,
  users: <><circle cx="9" cy="8" r="3"/><path d="M3.5 19v-1a5.5 5.5 0 0 1 11 0v1M16 5.4a3 3 0 0 1 0 5.2M16.5 13a4.7 4.7 0 0 1 4 4.7V19"/></>,
  plus: <path d="M12 5v14M5 12h14"/>, search: <><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4 4"/></>,
  arrowLeft: <path d="m14.5 5-7 7 7 7M8 12h12"/>, more: <><circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/></>,
  send: <><path d="m3 4 18 8-18 8 3-8-3-8ZM6 12h15"/></>, at: <><circle cx="12" cy="12" r="3.3"/><path d="M15.3 8.7v5.1a2 2 0 0 0 4 0v-1.5a7.3 7.3 0 1 0-2.9 5.8"/></>,
  close: <path d="M6 6l12 12M18 6 6 18"/>, chevronDown: <path d="m6 9 6 6 6-6"/>, reply: <><path d="m9 7-5 5 5 5"/><path d="M4 12h8c4.5 0 7 2 8 5"/></>,
  check: <path d="m5 12 4 4L19 6"/>, settings: <><circle cx="12" cy="12" r="3"/><path d="M19 12a7 7 0 0 0-.1-1l1.5-1.2-1.5-2.6-1.8.6a7 7 0 0 0-1.7-1L15 5h-3l-.4 1.8a7 7 0 0 0-1.7 1l-1.8-.6-1.5 2.6L8.1 11a7 7 0 0 0 0 2l-1.5 1.2 1.5 2.6 1.8-.6a7 7 0 0 0 1.7 1L12 19h3l.4-1.8a7 7 0 0 0 1.7-1l1.8.6 1.5-2.6-1.5-1.2c.1-.3.1-.7.1-1Z"/></>,
  sparkle: <><path d="m12 3 1.8 5.4L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.6L12 3ZM19 16l.7 2.3L22 19l-2.3.7L19 22l-.7-2.3L16 19l2.3-.7L19 16Z"/></>,
  logout: <path d="M10 5H5v14h5M14 8l4 4-4 4M9 12h9"/>, refresh: <><path d="M20 7v5h-5M4 17v-5h5"/><path d="M5 9a7.5 7.5 0 0 1 13-2l2 5M4 12l2 5a7.5 7.5 0 0 0 13-2"/></>,
  group: <><rect x="3" y="4" width="18" height="16" rx="5"/><circle cx="9" cy="10" r="2"/><circle cx="16" cy="10" r="2"/><path d="M6.5 16c.4-1.8 1.4-2.5 2.5-2.5s2.1.7 2.5 2.5M13.5 16c.4-1.8 1.4-2.5 2.5-2.5s2.1.7 2.5 2.5"/></>,
  info: <><circle cx="12" cy="12" r="8.5"/><path d="M12 11v5M12 8h.01"/></>,
};
export function Icon({ name, ...props }: SVGProps<SVGSVGElement> & { name: Name }) {
  return <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>{paths[name]}</svg>;
}
