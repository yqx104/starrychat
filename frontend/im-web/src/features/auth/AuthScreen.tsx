import { useRef, useState, type FormEvent } from 'react';
import { ApiError, errorMessage } from '../../api/client';
import { Notice } from '../../components/Notice';
import { validateCredentials } from './validation';

export function AuthScreen({ reauth, login, register }: { reauth: boolean; login: (username: string, password: string) => Promise<void>; register: (username: string, password: string, name: string) => Promise<void> }) {
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [error, setError] = useState('');
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busyRef.current || !username.trim() || !password || (mode === 'register' && !name.trim())) return;
    const validationError = validateCredentials(username, password, mode === 'register' ? name : undefined);
    if (validationError) { setError(validationError); return; }
    busyRef.current = true; setBusy(true); setError('');
    let registered = false;
    try {
      if (mode === 'register') { await register(username, password, name); registered = true; }
      await login(username, password);
    } catch (reason) {
      if (registered) { setMode('login'); setError(`账号已创建，但登录失败：${errorMessage(reason)}`); }
      else if (mode === 'login' && reason instanceof ApiError && reason.status === 401) setError('账号或密码不正确，请重试。');
      else if (mode === 'register' && reason instanceof ApiError && reason.status === 409) setError('注册失败：用户名已被使用，请登录或更换用户名。');
      else setError(errorMessage(reason));
    } finally { busyRef.current = false; setBusy(false); }
  };
  const switchMode = () => { setMode(mode === 'login' ? 'register' : 'login'); setError(''); setPassword(''); };
  return <main className="auth-screen">
    <section className="auth-card" aria-label={mode === 'login' ? '登录' : '注册账号'}>
      <div className="brand-mark">Y<span>·</span></div>
      <div className="auth-eyebrow">YQX / WORKSPACE</div>
      <h1>{mode === 'login' ? '欢迎回来' : '创建你的账号'}</h1>
      <p className="auth-intro">{reauth ? '登录已过期，请重新登录以继续。当前草稿会保留在本页。' : mode === 'login' ? '登录后，继续你的对话。' : '注册真人账号，开启你的对话空间。'}</p>
      <form onSubmit={submit}>
        <label className="field-label" htmlFor="auth-username">账号</label>
        <input id="auth-username" className="text-input" autoComplete="username" value={username} onChange={(event) => setUsername(event.target.value)} disabled={busy} />
        {mode === 'register' && <><label className="field-label auth-field" htmlFor="auth-name">显示名称</label><input id="auth-name" className="text-input" autoComplete="name" value={name} onChange={(event) => setName(event.target.value)} disabled={busy} /></>}
        <label className="field-label auth-field" htmlFor="auth-password">密码</label>
        <input id="auth-password" className="text-input" type="password" autoComplete={mode === 'login' ? 'current-password' : 'new-password'} value={password} onChange={(event) => setPassword(event.target.value)} disabled={busy} />
        {error && <Notice text={error} compact />}
        <button className="button button--primary auth-submit" disabled={busy || !username.trim() || !password || (mode === 'register' && !name.trim())}>{busy ? (mode === 'login' ? '登录中…' : '创建中…') : (mode === 'login' ? '登录' : '创建并登录')}</button>
      </form>
      {!reauth && <div className="auth-switch">{mode === 'login' ? '还没有账号？' : '已有账号？'} <button type="button" onClick={switchMode} disabled={busy}>{mode === 'login' ? '注册账号' : '返回登录'}</button></div>}
    </section>
  </main>;
}
