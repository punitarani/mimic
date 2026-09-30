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

import { type ButtonSize, type ButtonVariant, buttonClass, cn } from './button-styles';

export { type ButtonSize, type ButtonVariant, buttonClass, cn };

export const Button = forwardRef<
  HTMLButtonElement,
  ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant; size?: ButtonSize }
>(function Button({ variant, size, className, ...props }, ref) {
  return <button ref={ref} className={buttonClass(variant, size, className)} {...props} />;
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

/** The id `Field` gives its label, for inputs that name themselves with aria-labelledby. */
export function fieldLabelId(htmlFor: string): string {
  return `${htmlFor}-label`;
}

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
      <label id={fieldLabelId(htmlFor)} htmlFor={htmlFor} className="block text-sm font-medium text-graphite">
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
  disabled = false,
  describedBy,
}: {
  id: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  label: ReactNode;
  hint?: ReactNode;
  disabled?: boolean;
  /** Extra text that explains the box (for example why it is disabled), by element id. */
  describedBy?: string;
}) {
  const hintId = hint ? `${id}-hint` : undefined;
  const described = [hintId, describedBy].filter(Boolean).join(' ') || undefined;
  return (
    <label
      htmlFor={id}
      className={cn(
        'flex gap-3 rounded-[10px] p-2 -m-2',
        disabled ? 'cursor-not-allowed opacity-55' : 'cursor-pointer hover:bg-surface',
      )}
    >
      <input
        id={id}
        type="checkbox"
        checked={checked}
        disabled={disabled}
        aria-describedby={described}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-0.5 size-[18px] shrink-0 accent-[var(--color-graphite)]"
      />
      <span>
        <span className="block text-[15px] text-graphite">{label}</span>
        {hint ? (
          <span id={hintId} className="block text-[13px] text-muted">
            {hint}
          </span>
        ) : null}
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
