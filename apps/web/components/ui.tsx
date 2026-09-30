'use client';
import {
  type ButtonHTMLAttributes,
  type ComponentProps,
  forwardRef,
  type InputHTMLAttributes,
  type ReactNode,
  type TextareaHTMLAttributes,
  useEffect,
  useRef,
} from 'react';

export function cn(...xs: Array<string | false | null | undefined>): string {
  return xs.filter(Boolean).join(' ');
}

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';
const VARIANTS: Record<Variant, string> = {
  primary: 'bg-graphite text-fog hover:bg-graphite-soft disabled:bg-line-strong',
  secondary: 'bg-raised text-graphite border border-line hover:border-line-strong disabled:text-muted',
  ghost: 'text-graphite-soft hover:text-graphite hover:bg-surface',
  danger: 'bg-rust text-fog hover:brightness-95 disabled:opacity-60',
};

export const Button = forwardRef<
  HTMLButtonElement,
  ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: 'sm' | 'md' | 'lg' }
>(function Button({ variant = 'primary', size = 'md', className, ...props }, ref) {
  return (
    <button
      ref={ref}
      className={cn(
        'inline-flex items-center justify-center gap-2 rounded-[10px] font-medium transition-colors disabled:cursor-not-allowed',
        size === 'sm' && 'h-8 px-3 text-sm',
        size === 'md' && 'h-10 px-4 text-[15px]',
        size === 'lg' && 'h-12 px-6 text-base',
        VARIANTS[variant],
        className,
      )}
      {...props}
    />
  );
});

export function Card({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      className={cn(
        'rounded-[var(--radius-card)] border border-line bg-raised shadow-[var(--shadow-card)]',
        className,
      )}
      {...props}
    />
  );
}

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input(
  { className, ...props },
  ref,
) {
  return (
    <input
      ref={ref}
      className={cn(
        'h-11 w-full rounded-[10px] border border-line bg-raised px-3 text-[15px] placeholder:text-muted/70 hover:border-line-strong',
        'disabled:cursor-not-allowed disabled:bg-surface disabled:text-muted disabled:hover:border-line',
        className,
      )}
      {...props}
    />
  );
});

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(
  function Textarea({ className, ...props }, ref) {
    return (
      <textarea
        ref={ref}
        className={cn(
          'w-full rounded-[10px] border border-line bg-raised px-3 py-2 text-[15px] placeholder:text-muted/70 hover:border-line-strong',
          'disabled:cursor-not-allowed disabled:bg-surface disabled:text-muted disabled:hover:border-line',
          className,
        )}
        {...props}
      />
    );
  },
);

export function Field({
  label,
  hint,
  required,
  htmlFor,
  children,
}: {
  label: string;
  hint?: string;
  required?: boolean;
  htmlFor: string;
  children: ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <label htmlFor={htmlFor} className="block text-sm font-medium text-graphite">
        {label}
        {required ? (
          <span className="text-rust"> *</span>
        ) : (
          <span className="font-normal text-muted"> (optional)</span>
        )}
      </label>
      {children}
      {hint ? <p className="text-[13px] text-muted">{hint}</p> : null}
    </div>
  );
}

export function Checkbox({
  id,
  checked,
  onChange,
  label,
  hint,
}: {
  id: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  label: ReactNode;
  hint?: string;
}) {
  return (
    <label htmlFor={id} className="flex cursor-pointer gap-3 rounded-[10px] p-2 -m-2 hover:bg-surface">
      <input
        id={id}
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-0.5 size-[18px] shrink-0 accent-[var(--color-graphite)]"
      />
      <span>
        <span className="block text-[15px] text-graphite">{label}</span>
        {hint ? <span className="block text-[13px] text-muted">{hint}</span> : null}
      </span>
    </label>
  );
}

export function Spinner({ className }: { className?: string }) {
  return (
    <span
      role="status"
      aria-label="Loading"
      className={cn(
        'inline-block size-4 animate-spin rounded-full border-2 border-line-strong border-t-graphite motion-reduce:animate-none',
        className,
      )}
    />
  );
}

/** Bottom sheet built on <dialog> (focus trap, Esc to close). */
export function Sheet({
  open,
  onClose,
  title,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: backdrop click only; Esc closes the dialog natively
    <dialog
      ref={ref}
      onClose={onClose}
      onClick={(e) => {
        if (e.target === ref.current) onClose();
      }}
      aria-label={title}
      className="m-0 mt-auto max-h-[85dvh] w-full max-w-none overflow-y-auto rounded-t-[18px] border-t border-line bg-surface p-0 backdrop:bg-graphite/30"
    >
      <div className="sticky top-0 z-10 flex items-center justify-between border-b border-line bg-surface/95 px-4 py-3 backdrop-blur">
        <span className="text-sm font-medium">{title}</span>
        <Button variant="ghost" size="sm" onClick={onClose}>
          Close
        </Button>
      </div>
      <div className="p-4">{open ? children : null}</div>
    </dialog>
  );
}

export function ErrorText({ children }: { children: ReactNode }) {
  if (!children) return null;
  return (
    <p role="alert" className="rounded-[10px] bg-rust-soft px-3 py-2 text-sm text-rust">
      {children}
    </p>
  );
}
