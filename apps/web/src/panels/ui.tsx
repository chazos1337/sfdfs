import { useEffect, useState, type ReactNode } from 'react';
import { pretty, STATUS_COLOR } from '../util';

// Small shared building blocks for the pixel-game chrome.

export function H({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <h2 className={`font-pixel text-[13px] uppercase tracking-wide text-gold ${className}`}>{children}</h2>;
}

export function Label({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`font-pixel text-[10px] uppercase tracking-wider text-ink-300 ${className}`}>{children}</div>;
}

export function Badge({ children, color, title, dashed, className = '' }: { children: ReactNode; color?: string; title?: string; dashed?: boolean; className?: string }) {
  const c = color ?? '#8a9bd0';
  return (
    <span
      title={title}
      className={`inline-flex items-center gap-1 px-1.5 py-[1px] font-pixel text-[9px] uppercase leading-[14px] tracking-wider whitespace-nowrap ${className}`}
      style={{ color: c, border: `2px ${dashed ? 'dashed' : 'solid'} ${c}`, background: `${c}1a` }}
    >
      {children}
    </span>
  );
}

export function StatusBadge({ status, title }: { status: string; title?: string }) {
  return (
    <Badge color={STATUS_COLOR[status] ?? '#8a9bd0'} title={title}>
      {status.replace(/_/g, ' ')}
    </Badge>
  );
}

export function ModeBadge({ mode }: { mode: 'paper' | 'live' }) {
  return mode === 'live' ? (
    <Badge color="#ff8f3f">LIVE</Badge>
  ) : (
    <Badge color="#8a9bd0" dashed>
      PAPER
    </Badge>
  );
}

export function TierBadge({ tier }: { tier: number }) {
  const c = ['#6fdc8c', '#6cb6ff', '#ffd166', '#ff5c7a'][tier] ?? '#8a9bd0';
  return <Badge color={c}>T{tier}</Badge>;
}

/** Segmented pixel progress bar. */
export function Bar({ value, color = '#6fdc8c', segments = 12, className = '', height = 10 }: { value: number; color?: string; segments?: number; className?: string; height?: number }) {
  const v = Math.max(0, Math.min(1, value || 0));
  const filled = Math.round(v * segments);
  return (
    <div className={`flex gap-[2px] border-2 border-ink-600 bg-ink-950 p-[2px] ${className}`} style={{ height: height + 8 }}>
      {Array.from({ length: segments }, (_, i) => (
        <div key={i} className="flex-1" style={{ background: i < filled ? color : '#1b2852' }} />
      ))}
    </div>
  );
}

export function Modal({ title, onClose, children, wide, actions }: { title: ReactNode; onClose: () => void; children: ReactNode; wide?: boolean; actions?: ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-40 flex items-start justify-center overflow-y-auto bg-black/65 p-4 pt-10" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`px-frame flex max-h-[calc(100vh-5rem)] w-full flex-col ${wide ? 'max-w-5xl' : 'max-w-2xl'}`}>
        <div className="flex items-center gap-3 border-b-[3px] border-ink-600 bg-ink-800 px-4 py-2">
          <div className="min-w-0 flex-1 truncate font-pixel text-[14px] uppercase text-gold">{title}</div>
          {actions}
          <button className="px-btn" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-4">{children}</div>
      </div>
    </div>
  );
}

export function Confirm({ title, body, confirmLabel, danger, onConfirm, onCancel }: { title: string; body: ReactNode; confirmLabel: string; danger?: boolean; onConfirm: () => void; onCancel: () => void }) {
  return (
    <Modal title={title} onClose={onCancel}>
      <div className="mb-4 text-[14px] leading-relaxed text-ink-200">{body}</div>
      <div className="flex justify-end gap-2">
        <button className="px-btn" onClick={onCancel}>
          Cancel
        </button>
        <button className={`px-btn ${danger ? 'bad' : 'gold'}`} onClick={onConfirm} autoFocus>
          {confirmLabel}
        </button>
      </div>
    </Modal>
  );
}

export function JsonBlock({ value, collapsed = true, label = 'JSON', maxHeight = 260 }: { value: unknown; collapsed?: boolean; label?: string; maxHeight?: number }) {
  const [open, setOpen] = useState(!collapsed);
  if (value == null || value === '') return null;
  return (
    <div>
      <button className="font-pixel text-[10px] uppercase text-ink-300 hover:text-gold" onClick={() => setOpen(!open)}>
        {open ? '▾' : '▸'} {label}
      </button>
      {open && (
        <pre className="mt-1 overflow-auto border-2 border-ink-700 bg-ink-950 p-2 font-mono text-[11px] leading-snug text-ink-200" style={{ maxHeight }}>
          {pretty(value)}
        </pre>
      )}
    </div>
  );
}

export function Section({ title, children, right, className = '' }: { title: ReactNode; children: ReactNode; right?: ReactNode; className?: string }) {
  return (
    <section className={`mb-4 ${className}`}>
      <div className="mb-2 flex items-center gap-2 border-b-2 border-ink-700 pb-1">
        <H className="flex-1">{title}</H>
        {right}
      </div>
      {children}
    </section>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="py-2 text-[12px] italic text-ink-400">{children}</div>;
}

export function Loading() {
  return <div className="py-6 text-center font-pixel text-[11px] text-ink-300 blink">Loading…</div>;
}

export function ExtLink({ href, children }: { href: string; children?: ReactNode }) {
  const safe = /^https?:\/\//i.test(href) ? href : undefined;
  return (
    <a href={safe} target="_blank" rel="noreferrer noopener" className="break-all text-info underline decoration-dotted hover:text-gold">
      {children ?? href}
    </a>
  );
}

export function Toggle({ on, onChange, label, title, disabled }: { on: boolean; onChange: (v: boolean) => void; label: ReactNode; title?: string; disabled?: boolean }) {
  return (
    <button className={`px-btn ${on ? 'on' : ''}`} title={title} disabled={disabled} onClick={() => onChange(!on)}>
      {label}
    </button>
  );
}
