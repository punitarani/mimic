'use client';
import { useCombobox } from 'downshift';
import { type ChangeEvent, type InputHTMLAttributes, useEffect, useMemo, useState } from 'react';
import { cn, Input } from '@/components/ui';
import type { Finder, Suggestion } from '@/lib/autocomplete';

/**
 * A text field with suggestions (WAI-ARIA combobox via downshift). Picking a suggestion fills the field; anything
 * typed is kept as is, so places and titles outside the list still work. `load` runs once on mount; if it fails the
 * field is a plain input.
 */
export function AutocompleteInput({
  id,
  value,
  onChange,
  load,
  ...inputProps
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  load: () => Promise<Finder>;
} & Omit<InputHTMLAttributes<HTMLInputElement>, 'id' | 'value' | 'onChange'>) {
  const [find, setFind] = useState<Finder | null>(null);
  useEffect(() => {
    let live = true;
    load().then(
      (f) => live && setFind(() => f),
      () => {}, // no suggestions; the field still takes free text
    );
    return () => {
      live = false;
    };
  }, [load]);

  const items = useMemo(() => (find && value.trim() ? find(value) : []), [find, value]);

  const { isOpen, highlightedIndex, getMenuProps, getInputProps, getItemProps } = useCombobox<Suggestion>({
    items,
    inputId: id,
    labelId: `${id}-label`,
    // Only the text is controlled. A controlled selectedItem makes downshift reset the text after every pick.
    inputValue: value,
    itemToString: (item) => item?.value ?? '',
    // downshift reports changes from an effect, a render late: fast typing would land on the stale value. Typing
    // updates the parent from the input's own onChange below; this only carries picks.
    onInputValueChange: ({ type, inputValue }) => {
      if (type !== useCombobox.stateChangeTypes.InputChange) onChange(inputValue ?? '');
    },
    stateReducer: (state, { type, changes }) => {
      // Leaving the field or pressing Escape keeps what was typed rather than taking or clearing a suggestion.
      if (
        type === useCombobox.stateChangeTypes.InputBlur ||
        type === useCombobox.stateChangeTypes.InputKeyDownEscape
      )
        return { ...changes, inputValue: state.inputValue };
      return changes;
    },
  });

  const open = isOpen && items.length > 0;
  return (
    <div className="relative">
      <Input
        {...getInputProps({
          ...inputProps,
          spellCheck: false,
          onChange: (e: ChangeEvent<HTMLInputElement>) => onChange(e.currentTarget.value),
        })}
      />
      <ul
        {...getMenuProps()}
        className={cn(
          'absolute inset-x-0 top-full z-20 mt-1 max-h-72 overflow-auto rounded-[10px] border border-line bg-raised py-1 shadow-[var(--shadow-card)]',
          !open && 'hidden',
        )}
      >
        {open
          ? items.map((item, index) => (
              <li
                key={item.value}
                {...getItemProps({ item, index })}
                className={cn(
                  'flex cursor-pointer items-baseline justify-between gap-3 px-3 py-2 text-[15px] text-graphite',
                  highlightedIndex === index && 'bg-surface',
                )}
              >
                <span className="min-w-0 truncate">{item.value}</span>
                {item.detail ? <span className="shrink-0 text-[13px] text-muted">{item.detail}</span> : null}
              </li>
            ))
          : null}
      </ul>
    </div>
  );
}
