import type { InboxItem } from '../../api/types';

const time = (value: number) => new Date(value).toLocaleString('zh-CN', { hour12: false });
const inputStates: Record<string, string> = {
  pending: '待投递',
  sending: '等待回执',
  accepted: '已接收',
  rejected: '已拒绝',
  needs_recovery: '待恢复',
};
const receipts: Record<string, string> = {
  started: '已启动',
  queued: '已插队',
  handled: '已由扩展处理',
};

export function InboxPanel({
  messages,
  before,
  hasMore,
  onLatest,
  onOlder,
}: {
  messages: InboxItem[];
  before: number | undefined;
  hasMore: boolean;
  onLatest: () => void;
  onOlder: () => void;
}) {
  return (
    <>
      <div className="inbox-heading">
        <div>
          <h2>收件箱</h2>
          <p>消息先保存至本机，再投递到主会话；已接收不代表任务完成。</p>
        </div>
        <span className="eyebrow">{before ? '历史消息' : '最新消息'} · 每 2 秒刷新</span>
      </div>
      <div className="messages">
        {messages.length === 0 ? (
          <div className="empty-inbox">
            <h3>暂时没有收到消息</h3>
            <p>连接就绪后，Trigger 会投递发给这个 Agent 的消息。</p>
          </div>
        ) : (
          messages.map((item) => (
            <article className="message" key={item.id}>
              <div className="message-meta">
                <span>
                  {item.message.channel_type === 'im_direct' ? '单聊' : '群聊'}{' '}
                  <span className="seq">#{item.message.message_seq}</span>
                </span>
                <time>{time(item.received_at)}</time>
              </div>
              <p className="message-content">{item.message.content}</p>
              <div className="message-footer">
                <code title={item.message.conversation_id}>
                  会话 {item.message.conversation_id}
                </code>
                <span className={`pending ${item.state}`}>
                  {inputStates[item.state] ?? item.state}
                  {item.receipt_disposition ? ` · ${receipts[item.receipt_disposition]}` : ''}
                </span>
              </div>
              {item.last_error && <p className="input-error">{item.last_error}</p>}
            </article>
          ))
        )}
      </div>
      <div className="pagination">
        {before && <button onClick={onLatest}>返回最新</button>}
        {hasMore && <button onClick={onOlder}>更早的消息 →</button>}
      </div>
    </>
  );
}
