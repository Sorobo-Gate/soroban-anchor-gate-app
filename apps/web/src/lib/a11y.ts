import type * as React from "react";

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])';

/**
 * Returns all keyboard-focusable descendants inside `container` in DOM order,
 * excluding elements hidden via `inert` or `aria-hidden="true"`.
 */
export function getFocusableElements(container: HTMLElement | null): HTMLElement[] {
  if (!container) return [];
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (el) => !el.hasAttribute("inert") && el.getAttribute("aria-hidden") !== "true"
  );
}

/**
 * Handles `Tab` / `Shift+Tab` inside a modal dialog so keyboard focus stays
 * trapped within `container`.
 */
export function trapDialogFocus(container: HTMLElement | null, event: KeyboardEvent): void {
  if (event.key !== "Tab") return;
  const focusable = getFocusableElements(container);
  if (focusable.length === 0) {
    event.preventDefault();
    return;
  }
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  const active = document.activeElement;

  if (event.shiftKey) {
    if (active === first || !container?.contains(active)) {
      event.preventDefault();
      last.focus();
    }
  } else if (active === last || !container?.contains(active)) {
    event.preventDefault();
    first.focus();
  }
}

/**
 * Handles `ArrowLeft` / `ArrowRight` (or `Home` / `End`) navigation across a
 * horizontal group of buttons without changing their implicit `button` role.
 */
export function handleHorizontalButtonKeyDown<T extends string>(
  event: React.KeyboardEvent<HTMLElement>,
  items: readonly T[],
  current: T,
  onSelect: (value: T) => void
): void {
  const index = items.indexOf(current);
  if (index === -1 || items.length === 0) return;

  let nextIndex: number | null = null;
  if (event.key === "ArrowRight") {
    nextIndex = (index + 1) % items.length;
  } else if (event.key === "ArrowLeft") {
    nextIndex = (index - 1 + items.length) % items.length;
  } else if (event.key === "Home") {
    nextIndex = 0;
  } else if (event.key === "End") {
    nextIndex = items.length - 1;
  }

  if (nextIndex === null) return;
  event.preventDefault();
  onSelect(items[nextIndex]);
  const buttons = event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>("button:not([disabled])");
  buttons?.[nextIndex]?.focus();
}
