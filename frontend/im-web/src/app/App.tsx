import { Icon } from '../components/Icon';
import { AuthScreen } from '../features/auth/AuthScreen';
import { useAuth } from '../features/auth/useAuth';
import { Workspace } from './Workspace';

export function App() {
  const auth = useAuth();
  const { state } = auth;
  const user = state.status === 'authenticated' || state.status === 'reauth' ? state.user : null;
  return <>
    {import.meta.env.VITE_IM_DEMO === 'true' && state.status !== 'authenticated' && <div className="demo-banner" role="status">演示预览 · 以下为示例数据，不连接真实业务</div>}
    {user && <div hidden={state.status !== 'authenticated'}><Workspace key={user.participant_id} user={user} active={state.status === 'authenticated'} onLogout={() => void auth.logout()} /></div>}
    {(state.status === 'guest' || state.status === 'reauth') && <AuthScreen reauth={state.status === 'reauth'} login={auth.login} register={auth.register} />}
    {(state.status === 'checking' || state.status === 'unavailable' || state.status === 'signingOut' || state.status === 'logoutFailed') && <div className="connection-screen"><div className="connection-card"><div className="brand-mark">Y<span>·</span></div>
      {state.status === 'checking' || state.status === 'signingOut' ? <><div className="spinner" /><h1>{state.status === 'checking' ? '正在恢复登录' : '正在退出登录'}</h1></> : <><span className="empty-orb"><Icon name="refresh" /></span><h1>{state.status === 'logoutFailed' ? '退出未完成' : '暂时无法连接'}</h1><p>{state.message}</p><button className="button button--primary" onClick={state.status === 'logoutFailed' ? () => void auth.logout() : auth.retry}>{state.status === 'logoutFailed' ? '重试退出' : '重新连接'}</button></>}
    </div></div>}
  </>;
}
