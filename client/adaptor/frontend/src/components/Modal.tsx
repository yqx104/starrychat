import type { ReactNode } from 'react';

export function Modal({
  titleId,
  title,
  className = '',
  children,
}: {
  titleId: string;
  title: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className="overlay">
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className={`dialog ${className}`}
      >
        <h2 id={titleId}>{title}</h2>
        {children}
      </section>
    </div>
  );
}
