export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(`/adaptor-api${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...options.headers },
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error?.message || '本机服务暂时不可用');
  return data as T;
}
