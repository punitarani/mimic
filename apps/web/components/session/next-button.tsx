import { forwardRef } from 'react';

/** Next (design: NextButton): one pattern after every answer, with the Enter hint inside on desktop. */
export const NextButton = forwardRef<HTMLButtonElement, { onClick: () => void; disabled?: boolean }>(
  function NextButton({ onClick, disabled }, ref) {
    return (
      <button
        ref={ref}
        type="button"
        onClick={onClick}
        disabled={disabled}
        className="inline-flex h-11 items-center gap-2.5 rounded-[8px] border border-rule bg-sheet pl-4 pr-4 text-[16px] font-medium leading-6 text-graphite hover:border-slate active:bg-[linear-gradient(var(--g8),var(--g8))] disabled:cursor-default disabled:text-slate lg:pr-2 focus-visible:rounded-[8px]"
      >
        <span>Next</span>
        <Kbd desktopOnly>Enter</Kbd>
      </button>
    );
  },
);

export function Kbd({ children, desktopOnly = false }: { children: string; desktopOnly?: boolean }) {
  return (
    <span
      className={`${desktopOnly ? 'hidden lg:inline-flex' : 'inline-flex'} h-6 items-center rounded-[4px] border border-rule px-1.5 text-[12px] font-medium leading-[22px] text-slate tabular-nums`}
    >
      {children}
    </span>
  );
}
