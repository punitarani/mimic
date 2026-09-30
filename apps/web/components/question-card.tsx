'use client';
import type { PublicQuestion, Reveal } from '@mimic/core';
import { useEffect, useId, useRef, useState } from 'react';
import { Button, cn, Textarea } from './ui';

export interface QuestionCardProps {
  question: PublicQuestion;
  disabled?: boolean;
  reveal: (Reveal & { answer: string }) | null;
  onSubmit: (value: string, why: string | undefined) => void;
}

/**
 * PLAN §10.1 question card: large serif prompt; option buttons (choice), Yes/No (noul) or a 5-step scale (score);
 * optional "Why?" collapsed by default. Keyboard: 1–5 and Y/N select, Enter submits.
 */
export function QuestionCard({ question, disabled, reveal, onSubmit }: QuestionCardProps) {
  const [selected, setSelected] = useState<string | null>(null);
  const [showWhy, setShowWhy] = useState(false);
  const [why, setWhy] = useState('');
  const promptId = useId();
  const submitRef = useRef<HTMLButtonElement>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: reset whenever a new question arrives
  useEffect(() => {
    setSelected(null);
    setShowWhy(false);
    setWhy('');
  }, [question.id]);

  const submit = () => {
    if (!selected || disabled || reveal) return;
    onSubmit(selected, why.trim() || undefined);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (disabled || reveal) return;
      const typing = (e.target as HTMLElement | null)?.tagName === 'TEXTAREA';
      if (e.key === 'Enter' && (!typing || e.metaKey || e.ctrlKey)) {
        if (selected) {
          e.preventDefault();
          submit();
        }
        return;
      }
      if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
      if (question.type === 'noul' && (e.key === 'y' || e.key === 'n')) {
        setSelected(e.key === 'y' ? 'yes' : 'no');
        return;
      }
      const n = Number(e.key);
      if (Number.isInteger(n) && n >= 1 && n <= question.options.length)
        setSelected(question.options[n - 1]!.key);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const stateOf = (key: string): 'match' | 'miss' | 'guess' | null => {
    if (!reveal) return null;
    if (key === reveal.answer) return reveal.match ? 'match' : 'miss';
    if (key === reveal.optionKey) return 'guess';
    return null;
  };

  return (
    <div className="flex flex-col">
      <h1 id={promptId} className="prompt text-graphite">
        {question.prompt}
      </h1>

      <div
        role="radiogroup"
        aria-labelledby={promptId}
        className={cn(
          'mt-8',
          question.type === 'choice' && 'flex flex-col gap-2.5',
          question.type === 'noul' && 'grid grid-cols-2 gap-3',
          question.type === 'score' && 'grid grid-cols-5 gap-1.5 sm:gap-2',
        )}
      >
        {question.options.map((o, i) => {
          const s = stateOf(o.key);
          const isSel = selected === o.key;
          return (
            // biome-ignore lint/a11y/useSemanticElements: large tappable option cards with keyboard shortcuts
            <button
              key={o.key}
              type="button"
              role="radio"
              aria-checked={isSel}
              disabled={disabled || !!reveal}
              onClick={() => setSelected(o.key)}
              onDoubleClick={() => {
                setSelected(o.key);
                if (!disabled && !reveal) onSubmit(o.key, why.trim() || undefined);
              }}
              className={cn(
                'group relative rounded-[12px] border text-left transition-colors disabled:cursor-default',
                question.type === 'score'
                  ? 'flex min-h-[88px] flex-col items-center justify-between gap-1 px-1.5 py-2.5 text-center text-[12px] leading-tight sm:text-[13px]'
                  : 'flex min-h-[52px] items-center gap-3 px-4 py-3 text-[16px]',
                isSel && !reveal
                  ? 'border-graphite bg-graphite text-white'
                  : 'border-line bg-raised hover:border-line-strong',
                s === 'match' && 'border-moss bg-moss-soft text-graphite',
                s === 'miss' && 'border-graphite bg-graphite text-white',
                s === 'guess' && 'border-ink bg-ink-soft text-ink-strong',
              )}
            >
              <kbd
                className={cn(
                  'tabular hidden shrink-0 rounded-[6px] border px-1.5 text-[12px] font-normal sm:inline-block',
                  isSel && !reveal ? 'border-white/40 text-white/80' : 'border-line text-muted',
                )}
              >
                {question.type === 'noul' ? (o.key === 'yes' ? 'Y' : 'N') : i + 1}
              </kbd>
              <span>{o.label}</span>
            </button>
          );
        })}
      </div>

      <div className="mt-3 min-h-[28px]" aria-live="polite">
        {reveal && (
          <p className="animate-reveal text-[15px]">
            <span className={cn('mr-1.5 font-semibold', reveal.match ? 'text-moss' : 'text-rust')}>
              {reveal.match ? '✓ Match.' : '✗ Miss.'}
            </span>
            Your mimic guessed <span className="font-medium">{reveal.label}</span>{' '}
            <span className="tabular text-muted">({Math.round(reveal.p * 100)}%)</span>
          </p>
        )}
      </div>

      <div className="mt-2 flex flex-col gap-3">
        {showWhy ? (
          <Textarea
            aria-label="Why? (optional)"
            placeholder="Why? (optional, never scored)"
            rows={2}
            maxLength={1000}
            value={why}
            onChange={(e) => setWhy(e.target.value)}
            autoFocus
          />
        ) : (
          <button
            type="button"
            className="self-start text-[14px] text-muted underline-offset-2 hover:text-graphite hover:underline"
            onClick={() => setShowWhy(true)}
            disabled={!!reveal}
          >
            Add a why
          </button>
        )}
        <div className="sticky bottom-0 -mx-4 flex items-center gap-3 border-t border-line bg-canvas/95 px-4 py-3 backdrop-blur sm:static sm:mx-0 sm:border-0 sm:bg-transparent sm:p-0 sm:backdrop-blur-none">
          <Button
            ref={submitRef}
            size="lg"
            className="w-full sm:w-auto"
            onClick={submit}
            disabled={!selected || disabled || !!reveal}
          >
            Next
          </Button>
          <span className="hidden text-[13px] text-muted sm:inline">
            {question.type === 'noul' ? 'Y / N' : `1–${question.options.length}`} to choose · Enter to
            continue
          </span>
        </div>
      </div>
    </div>
  );
}
