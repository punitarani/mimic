'use client';
import { useCombobox } from 'downshift';
import {
  type ChangeEvent,
  type InputHTMLAttributes,
  type KeyboardEvent,
  useCallback,
  useDeferredValue,
  useMemo,
  useState,
} from 'react';
import { cn, Input } from '@/components/ui';
import type { Finder, Suggestion } from '@/lib/autocomplete';

/**
 * A text field with suggestions (WAI-ARIA combobox via downshift). Picking a suggestion fills the field; anything
 * typed is kept as is, so places and titles outside the list still work. The dataset loads when the field is first
 * focused; until then, or if it fails, the field is a plain input.
 */
export function AutocompleteInput({
  id,
  labelId,
  value,
  onChange,
  load,
  ...inputProps
}: {
  id: string;
  /** The id of the visible label, which names the input and the list. */
  labelId: string;
  value: string;
  onChange: (value: string) => void;
  load: () => Promise<Finder>;
} & Omit<InputHTMLAttributes<HTMLInputElement>, 'id' | 'value' | 'onChange'>) {
  const [find, setFind] = useState<Finder | null>(null);
  const ensureLoaded = useCallback(() => {
    if (find) return;
    load().then(
      (f) => setFind(() => f),
      () => {}, // logged by the loader; the next focus tries again
    );
  }, [find, load]);

  // The menu counts as open only while it shows something. downshift would otherwise treat an empty, hidden menu as
  // open: Enter wouldn't submit the form and aria-expanded would be wrong.
  const [wantsOpen, setWantsOpen] = useState(false);
  const query = useDeferredValue(value); // typing stays responsive while the list catches up
  const items = useMemo(
    () => (find && wantsOpen && query.trim() ? find(query) : []),
    [find, wantsOpen, query],
  );

  const { isOpen, highlightedIndex, getMenuProps, getInputProps, getItemProps } = useCombobox<Suggestion>({
    items,
    inputId: id,
    labelId,
    // Only the text is controlled. A controlled selectedItem makes downshift reset the text after every pick.
    inputValue: value,
    isOpen: wantsOpen && items.length > 0,
    onIsOpenChange: ({ isOpen: open }) => setWantsOpen(Boolean(open)),
    itemToString: (item) => item?.value ?? '',
    // downshift reports changes from an effect, a render late: fast typing would land on the stale value. Typing
    // updates the parent from the input's own onChange below; this only carries picks.
    onInputValueChange: ({ type, inputValue }) => {
      if (type !== useCombobox.stateChangeTypes.InputChange) onChange(inputValue ?? '');
    },
    stateReducer: (state, { type, changes }) => {
      // Escape closes the list and keeps what was typed, rather than clearing the field.
      if (type === useCombobox.stateChangeTypes.InputKeyDownEscape)
        return { ...changes, inputValue: state.inputValue };
      return changes;
    },
  });

  return (
    <div className="relative">
      <Input
        {...getInputProps({
          ...inputProps,
          spellCheck: false,
          onFocus: ensureLoaded,
          onChange: (e: ChangeEvent<HTMLInputElement>) => {
            ensureLoaded();
            onChange(e.currentTarget.value);
          },
          onKeyDown: (
            e: KeyboardEvent<HTMLInputElement> & { nativeEvent: { preventDownshiftDefault?: boolean } },
          ) => {
            // With no suggestion highlighted, Enter submits the form as in a plain field.
            if (e.key === 'Enter' && highlightedIndex < 0) e.nativeEvent.preventDownshiftDefault = true;
          },
        })}
      />
      <ul
        {...getMenuProps()}
        className={cn(
          'absolute inset-x-0 top-full z-20 mt-1 max-h-72 overflow-auto rounded-[10px] border border-line bg-raised py-1 shadow-[var(--shadow-card)]',
          !isOpen && 'hidden',
        )}
      >
        {isOpen
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
