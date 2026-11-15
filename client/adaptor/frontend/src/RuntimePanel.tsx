import { useEffect, useState } from 'react';
import { api, type Agent, type ExecutionEvent, type InboxItem, type MainSession } from './api';
import './runtime.css';
import { RuntimeConfigDialog } from './RuntimeConfigDialog';

const sessionLabels: Record<string, string> = {
  unconfigured: '待配置', starting: '启动中', idle: '空闲', busy: '执行中', compacting: '压缩上下文',
  stopping: '停止中', stopped: '未启动', disabled: '已停用', error: '运行异常',
};
const phases: Record<string, string> = {
  agent_start: '开始执行', agent_settled: '本轮执行已停止', compaction_start: '开始压缩上下文', compaction_end: '上下文压缩结束',
  auto_retry_start: '正在重试模型请求', auto_retry_end: '模型请求重试结束', start: '开始', update: '进行中', end: '结束',
};

function grouped(events: ExecutionEvent[]) {
  const result: ExecutionEvent[] = [];
  for (const event of events) {
    const last = result.at(-1);
    if (last?.type === 'text' && event.type === 'text') last.text = (last.text ?? '') + (event.text ?? '');
    else result.push({ ...event });
  }
  return result;
}

export function RuntimePanel({ agent, messages }: { agent: Agent; messages: InboxItem[] }) {
  const [view, setView] = useState<MainSession>();
  const [events, setEvents] = useState<ExecutionEvent[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [recovery, setRecovery] = useState<{ item: InboxItem; action: 'retry' | 'accepted' } | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    let cursor = 0; let epoch = '';
    setView(undefined); setEvents([]); setError(''); setTruncated(false); setEditing(false);
    const poll = async () => {
      try {
        const state = await api<MainSession>(`/agents/${agent.agent_id}/main-session`, { signal: controller.signal });
        if (controller.signal.aborted) return;
        setView(state);
        if (state.session) {
          const data = await api<{ epoch: string; events: ExecutionEvent[]; truncated: boolean }>(
            `/sessions/${state.session.session_id}/events?after=${cursor}&epoch=${epoch}`, { signal: controller.signal });
          if (controller.signal.aborted) return;
          const reset = epoch !== data.epoch;
          epoch = data.epoch;
          cursor = data.events.at(-1)?.id ?? (reset ? 0 : cursor);
          setEvents(current => [...(reset ? [] : current), ...data.events].slice(-300));
          if (reset) setTruncated(data.truncated); else if (data.truncated) setTruncated(true);
        }
      } catch { if (!controller.signal.aborted) setError('会话状态读取失败，请检查本机服务。'); }
      finally { if (!controller.signal.aborted) timer = setTimeout(poll, 2000); }
    };
    void poll();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [agent.agent_id]);

  async function abort() {
    if (!view?.session) return;
    setBusy(true); setError('');
    try { setView(await api<MainSession>(`/sessions/${view.session.session_id}/abort`, { method: 'POST', body: '{}' })); }
    catch (error) { setError(error instanceof Error ? error.message : '中止失败'); }
    finally { setBusy(false); }
  }
  async function recover() {
    if (!view?.session || !recovery) return;
    const { item, action } = recovery;
    setBusy(true); setError('');
    try {
      await api(`/sessions/${view.session.session_id}/inputs/${item.id}/resolve`, { method: 'POST', body: JSON.stringify({ action, confirmed: true }) });
      setView(await api<MainSession>(`/agents/${agent.agent_id}/main-session`));
      setRecovery(null);
    } catch (error) { setError(error instanceof Error ? error.message : '恢复处理失败'); }
    finally { setBusy(false); }
  }

  const issues = messages.filter(item => ['rejected', 'needs_recovery'].includes(item.state));
  const needsConfig = (view?.status ?? agent.session_status) === 'unconfigured';
  return <section className="runtime-panel" aria-label="Pi 主会话">
    <div className="runtime-heading"><div><h2>Pi 主会话 <span className={`badge ${view?.status === 'error' ? 'conflict' : ''}`}>{sessionLabels[view?.status ?? agent.session_status] ?? '读取中'}</span></h2>
      <p>{view?.model ? `${view.model.provider} / ${view.model.id}` : '模型与认证仅使用此 Agent 的 pi-config'} · 队列 {view?.pending ?? 0}</p></div>
      <div className="actions"><button disabled={busy || (!!view?.session && agent.enabled && !needsConfig)} onClick={() => { setError(''); setEditing(true); }}>运行配置</button>
        <button disabled={busy || !['idle', 'busy', 'compacting'].includes(view?.status ?? '')} onClick={abort}>中止当前执行</button></div></div>
    {view?.session && <div className="session-reference"><span>主会话 {view.session.session_id}</span><code>{view.session.cwd}</code>
      <code>{view.session.native_ref?.session_file ?? '首次输入持久化后生成会话文件'}</code></div>}
    {needsConfig && <p className="runtime-hint">配置完成前消息保留在收件箱，暂不执行。打开运行配置填写模型、接口和 API Key，然后保存检查。</p>}
    {agent.enabled && view?.session && !needsConfig && <p className="runtime-hint">修改运行配置前请先停用 Agent；重新启用会恢复当前会话。</p>}
    {(error || view?.last_error) && <div role="alert" className="notice">{error || view?.last_error}</div>}
    {view?.blocked && <div className="notice">输入派发已暂停。请先停用 Agent，核对会话历史后处理拒绝或待恢复记录，再重新启用。</div>}
    {issues.length > 0 && <div className="recovery-list">{issues.map(item => <div key={item.id} className="recovery-item"><p>输入 #{item.id} · {item.message.content.slice(0, 100)}</p><small>{item.last_error}</small>
      <div className="actions"><button disabled={busy || agent.enabled || view?.status === 'stopping'} onClick={() => { setError(''); setRecovery({ item, action: 'retry' }); }}>确认重试</button>
        <button disabled={busy || agent.enabled || view?.status === 'stopping'} onClick={() => { setError(''); setRecovery({ item, action: 'accepted' }); }}>核对后标记已接收</button></div></div>)}</div>}
    <details className="execution" open><summary>执行过程 <span>最近 300 条事件，后端重启后清空</span></summary>
      {truncated && <p className="runtime-hint">部分较早事件已超出缓存范围。</p>}
      <div className="execution-events" aria-live="polite">{events.length === 0 ? <p className="runtime-hint">等待执行事件。收到输入的回执不代表任务完成。</p> : grouped(events).map(event =>
        <div key={event.id} className={`execution-event ${event.type}`}>
          {event.type === 'text' ? <pre>{event.text}</pre> : <><small>{new Date(event.at).toLocaleTimeString('zh-CN')}</small> {event.type === 'tool' ? `${event.tool} · ${phases[event.phase ?? ''] ?? event.phase}` :
            event.type === 'queue' ? `待消费输入：${event.pending}` : phases[event.phase ?? ''] ?? ''}{event.text && <span> {event.text}</span>}</>}
        </div>)}</div></details>
    {recovery && <div className="overlay"><section role="dialog" aria-modal="true" aria-labelledby="recovery-title" className="dialog runtime-dialog">
      <h2 id="recovery-title">核对输入 #{recovery.item.id}</h2>
      <p>{recovery.action === 'retry' ? '请先核对 Pi 历史和工具执行结果。重新投递可能重复执行已发生的操作。' : '请确认已核对原输入及 Pi 历史。标记已接收将允许继续派发，不代表任务完成。'}</p>
      <div className="message-content">{recovery.item.message.content}</div>
      {error && <div role="alert" className="form-error">{error}</div>}
      <div className="dialog-actions"><button disabled={busy} onClick={() => setRecovery(null)}>取消</button>
        <button className="primary" disabled={busy || agent.enabled} onClick={recover}>{busy ? '处理中…' : recovery.action === 'retry' ? '已核对，重新投递' : '已核对，标记已接收'}</button></div>
    </section></div>}
    {editing && <RuntimeConfigDialog key={agent.agent_id} agentId={agent.agent_id} onClose={() => setEditing(false)}
      onSaved={state => { setView(state); setEditing(false); }} />}
  </section>;
}
