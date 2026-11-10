import { afterEach, vi } from 'vitest';
import { cleanup } from '@testing-library/react';

Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
