export function Notice({ text, onRetry, compact = false }: { text: string; onRetry?: () => void; compact?: boolean }) {
  return <div role="alert" className={`notice ${compact ? 'notice--compact' : ''}`}><span>{text}</span>{onRetry && <button type="button" onClick={onRetry}>重试</button>}</div>;
}
