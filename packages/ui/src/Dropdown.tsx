import { useEffect, useId, useRef, useState } from 'react';

export interface DropdownOption {
  readonly value: string;
  readonly label: string;
}

interface DropdownProps {
  readonly value: string;
  readonly options: readonly DropdownOption[];
  readonly onChange: (value: string) => void;
  readonly ariaLabel: string;
  /** Which way the panel opens. Bottom-anchored controls should use 'top'. */
  readonly placement?: 'top' | 'bottom';
  /** Extra class on the root, for per-site trigger sizing. */
  readonly className?: string;
}

/**
 * A themed dropdown.
 *
 * A native <select> renders its option list via the OS, which ignores our CSS
 * entirely — that is why it appeared as a bright white system menu inside the
 * dark UI. This replaces it with a real listbox we control, styled to the app's
 * palette, while keeping proper combobox semantics and keyboard behaviour:
 * Enter/Space/Arrows open, Arrows move, Enter selects, Escape closes and
 * restores focus, and clicking outside dismisses.
 */
export function Dropdown({
  value,
  options,
  onChange,
  ariaLabel,
  placement = 'bottom',
  className,
}: DropdownProps): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listId = useId();

  const selectedIndex = Math.max(
    0,
    options.findIndex((o) => o.value === value),
  );
  const selected = options[selectedIndex];

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent): void => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const openMenu = (): void => {
    setActive(selectedIndex);
    setOpen(true);
  };

  const choose = (i: number): void => {
    const opt = options[i];
    if (opt) onChange(opt.value);
    setOpen(false);
    triggerRef.current?.focus();
  };

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (!open) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        openMenu();
      }
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      setOpen(false);
      triggerRef.current?.focus();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((i) => (i + 1) % options.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((i) => (i - 1 + options.length) % options.length);
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      choose(active);
    } else if (e.key === 'Tab') {
      setOpen(false);
    }
  };

  return (
    <div className={`dropdown${className ? ` ${className}` : ''}`} ref={rootRef}>
      <button
        type="button"
        ref={triggerRef}
        className="dropdown-trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        {...(open ? { 'aria-controls': listId, 'aria-activedescendant': `${listId}-${active}` } : {})}
        onClick={() => (open ? setOpen(false) : openMenu())}
        onKeyDown={onKeyDown}
      >
        <span className="dropdown-value">{selected?.label ?? ''}</span>
        <span className="dropdown-chevron" aria-hidden>
          ⌄
        </span>
      </button>

      {open && (
        <ul className={`dropdown-menu dropdown-${placement}`} id={listId} role="listbox" aria-label={ariaLabel}>
          {options.map((o, i) => (
            <li
              key={o.value}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={o.value === value}
              className={`dropdown-option${i === active ? ' is-active' : ''}`}
              onMouseEnter={() => setActive(i)}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => choose(i)}
            >
              <span className="dropdown-option-label">{o.label}</span>
              {o.value === value && (
                <span className="dropdown-check" aria-hidden>
                  ✓
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
