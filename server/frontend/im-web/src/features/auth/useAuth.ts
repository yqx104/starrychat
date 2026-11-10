import { useEffect, useRef, useState } from 'react';
import { api, ApiError, errorMessage } from '../../api/client';
import type { Participant } from '../../api/types';

type AuthState =
  | { status: 'checking' }
  | { status: 'guest' }
  | { status: 'signingOut' }
  | { status: 'unavailable'; message: string }
  | { status: 'logoutFailed'; message: string }
  | { status: 'authenticated'; user: Participant }
  | { status: 'reauth'; user: Participant };

export function useAuth() {
  const [state, setState] = useState<AuthState>({ status: 'checking' });
  const [retry, setRetry] = useState(0);
  const signingOut = useRef(false);
  useEffect(() => {
    let alive = true;
    const controller = new AbortController();
    const unsubscribe = api.onUnauthorized(() => {
      setState((current) => current.status === 'authenticated' ? { status: 'reauth', user: current.user } : current);
    });
    setState({ status: 'checking' });
    void (async () => {
      await api.suspendSession();
      if (!alive) return;
      try {
        const user = await api.me(controller.signal);
        if (!alive) return;
        api.resumeSession(); setState({ status: 'authenticated', user });
      } catch (error) {
        if (!alive || (error instanceof Error && error.name === 'AbortError')) return;
        setState(error instanceof ApiError && error.status === 401 ? { status: 'guest' } : { status: 'unavailable', message: errorMessage(error) });
      }
    })();
    return () => { alive = false; controller.abort(); unsubscribe(); void api.suspendSession(); };
  }, [retry]);

  const login = async (username: string, password: string) => {
    await api.waitForDrain();
    const result = await api.login(username, password);
    api.resumeSession(); setState({ status: 'authenticated', user: result.participant });
  };
  const register = async (username: string, password: string, name: string) => {
    await api.waitForDrain();
    await api.register(username, password, name);
  };
  const logout = async () => {
    if (signingOut.current) return;
    signingOut.current = true;
    const drained = api.suspendSession();
    setState({ status: 'signingOut' });
    await drained;
    try { await api.logout(); setState({ status: 'guest' }); }
    catch (error) { setState({ status: 'logoutFailed', message: errorMessage(error) }); }
    finally { signingOut.current = false; }
  };
  return { state, login, register, logout, retry: () => setRetry((value) => value + 1) };
}
