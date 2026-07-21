import { useEffect, useRef, type ReactNode } from 'react';

interface ModalProps {
  /** id of the element inside that labels the dialog (aria-labelledby). */
  readonly titleId: string;
  /** Escape / dismiss handler. */
  readonly onClose: () => void;
  readonly overlayClassName: string;
  readonly cardClassName: string;
  readonly children: ReactNode;
}

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Accessible modal shell: dialog semantics (role, aria-modal, aria-labelledby),
 * initial focus into the dialog, a Tab focus-trap, focus restore to the trigger
 * on close, and Escape-to-dismiss. Without this, overlays like the first-run
 * Wizard left keyboard/screen-reader users focused on the page behind them with
 * no way out (WCAG 2.4.3 / 2.1.2).
 */
export function Modal({
  titleId,
  onClose,
  overlayClassName,
  cardClassName,
  children,
}: ModalProps): React.JSX.Element {
  const cardRef = useRef<HTMLDivElement>(null);
  const restoreRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    restoreRef.current = document.activeElement as HTMLElement | null;
    const card = cardRef.current;
    const focusables = (): HTMLElement[] =>
      card ? Array.from(card.querySelectorAll<HTMLElement>(FOCUSABLE)) : [];
    (focusables()[0] ?? card)?.focus();

    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key !== 'Tab') return;
      const items = focusables();
      if (items.length === 0) {
        e.preventDefault();
        return;
      }
      const first = items[0]!;
      const last = items[items.length - 1]!;
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      restoreRef.current?.focus?.();
    };
  }, [onClose]);

  return (
    <div className={overlayClassName}>
      <div
        className={cardClassName}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        ref={cardRef}
      >
        {children}
      </div>
    </div>
  );
}
