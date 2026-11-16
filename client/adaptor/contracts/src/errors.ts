export class ConfigurationError extends Error {}

export class InputError extends Error {
  kind: 'retryable' | 'rejected' | 'unknown';
  constructor(kind: InputError['kind'], message: string) { super(message); this.kind = kind; }
}

// Transport diagnostics can contain a subprocess's entire stderr. Never expose it through HTTP.
export function errorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).split('. Stderr:')[0].slice(0, 1500);
}
