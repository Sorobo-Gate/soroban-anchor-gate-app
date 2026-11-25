"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { createPortal } from "react-dom";
import { Menu, X, LayoutDashboard, PlusCircle, Scale, type LucideIcon } from "lucide-react";
import { getFocusableElements, trapDialogFocus } from "@/lib/a11y";

/**
 * Responsive mobile navigation + touch optimisations.
 *
 *  - `MobileNav`: hamburger trigger (hidden ≥ md) opening a slide-over drawer.
 *  - `ResponsiveTable`: horizontally scrollable, keyboard-focusable table region with
 *    momentum scrolling and an edge fade, for wide data tables on small screens.
 *  - `StickyActionCell` / `StickyActionHeader`: keep row action buttons pinned to the
 *    right edge while the rest of the table scrolls horizontally.
 *
 * All interactive targets are ≥ 48×48 CSS px (WCAG 2.5.5 / Material touch target guidance).
 */

/** Minimum touch target edge length in CSS pixels. */
export const MIN_TOUCH_TARGET_PX = 48;
/** Tailwind classes that enforce the minimum touch target (12 × 4px = 48px). */
export const TOUCH_TARGET_CLASS = "min-h-12 min-w-12";
/** Width of the drawer panel. Capped so a sliver of page remains visible as a tap-to-close area. */
export const DRAWER_WIDTH_CLASS = "w-[85vw] max-w-xs";

export interface NavItem {
  href: string;
  label: string;
  description?: string;
  icon?: LucideIcon;
}

export const DEFAULT_NAV_ITEMS: NavItem[] = [
  { href: "/", label: "Dashboard", description: "Deposit & manage escrows", icon: LayoutDashboard },
  { href: "/create", label: "Create Escrow", description: "Step-by-step escrow wizard", icon: PlusCircle },
  { href: "/disputes", label: "Disputes", description: "Evidence & arbitration", icon: Scale },
];

/** True when `meetsTouchTarget` dimensions satisfy the 48×48 px minimum. */
export function meetsTouchTarget(width: number, height: number, min: number = MIN_TOUCH_TARGET_PX): boolean {
  return Number.isFinite(width) && Number.isFinite(height) && width >= min && height >= min;
}

function normalizePath(path: string): string {
  const withoutQuery = path.split(/[?#]/)[0] || "/";
  const trimmed = withoutQuery.replace(/\/+$/, "");
  return trimmed === "" ? "/" : trimmed;
}

/**
 * Active-link matching: exact match for the root, prefix-on-segment match otherwise
 * (`/disputes/42` activates `/disputes`, but `/disputes-archive` does not).
 */
export function isNavItemActive(href: string, pathname: string | null | undefined): boolean {
  if (!pathname) return false;
  const target = normalizePath(href);
  const current = normalizePath(pathname);
  if (target === "/") return current === "/";
  return current === target || current.startsWith(`${target}/`);
}

export type DrawerAction = "open" | "close" | "toggle" | "escape" | "navigate";

/** Pure drawer state reducer. */
export function drawerReducer(isOpen: boolean, action: DrawerAction): boolean {
  switch (action) {
    case "open":
      return true;
    case "toggle":
      return !isOpen;
    case "close":
    case "escape":
    case "navigate":
      return false;
    default:
      return isOpen;
  }
}

const noopSubscribe = () => () => undefined;

export interface MobileNavProps {
  items?: NavItem[];
  /** Brand node rendered at the top of the drawer. */
  brand?: React.ReactNode;
  /** Extra content (e.g. wallet connect button) rendered at the bottom of the drawer. */
  footer?: React.ReactNode;
  /** Override the current pathname (defaults to `usePathname()`); useful for tests. */
  pathname?: string;
  /** Start open (tests / storybook). */
  defaultOpen?: boolean;
  className?: string;
}

export function MobileNav({
  items = DEFAULT_NAV_ITEMS,
  brand,
  footer,
  pathname: pathnameOverride,
  defaultOpen = false,
  className = "",
}: MobileNavProps) {
  const routerPathname = usePathname();
  const pathname = pathnameOverride ?? routerPathname;
  const [open, dispatch] = React.useReducer(drawerReducer, defaultOpen);
  // false during SSR, true once hydrated — exposed as data-hydrated for e2e synchronisation.
  const hydrated = React.useSyncExternalStore(
    noopSubscribe,
    () => true,
    () => false
  );
  const panelId = React.useId();
  const titleId = React.useId();
  const triggerRef = React.useRef<HTMLButtonElement>(null);
  const panelRef = React.useRef<HTMLDivElement>(null);
  const wasOpen = React.useRef(open);

  // Close the drawer whenever the route changes.
  const lastPathname = React.useRef(pathname);
  React.useEffect(() => {
    if (lastPathname.current !== pathname) {
      lastPathname.current = pathname;
      dispatch("navigate");
    }
  }, [pathname]);

  // Body scroll lock, focus management, Escape + focus trap while open.
  React.useEffect(() => {
    if (!open) {
      if (wasOpen.current) triggerRef.current?.focus();
      wasOpen.current = false;
      return;
    }
    wasOpen.current = true;
    const { body } = document;
    const previousOverflow = body.style.overflow;
    body.style.overflow = "hidden";
    getFocusableElements(panelRef.current)[0]?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        dispatch("escape");
        return;
      }
      trapDialogFocus(panelRef.current, event);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  // Auto-close if the viewport grows past the md breakpoint while open.
  React.useEffect(() => {
    if (!open || typeof window === "undefined" || !window.matchMedia) return;
    const mql = window.matchMedia("(min-width: 768px)");
    const onChange = (e: MediaQueryListEvent) => {
      if (e.matches) dispatch("close");
    };
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, [open]);

  // Rendered into document.body once hydrated: ancestors with transform/backdrop-filter
  // (e.g. a blurred sticky header) would otherwise become the containing block for
  // `position: fixed` and clip the drawer to the header's height.
  const overlay = (
    <>
      {/* Backdrop */}
      <div
        aria-hidden="true"
        data-testid="mobile-nav-backdrop"
        onClick={() => dispatch("close")}
        className={`md:hidden fixed inset-0 z-[70] bg-background/70 backdrop-blur-sm transition-opacity duration-200 motion-reduce:transition-none ${
          open ? "opacity-100" : "pointer-events-none opacity-0"
        }`}
      />

      {/* Slide-over panel */}
      <div
        ref={panelRef}
        id={panelId}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-hidden={!open}
        inert={!open}
        data-testid="mobile-nav-drawer"
        data-state={open ? "open" : "closed"}
        className={`md:hidden fixed inset-y-0 left-0 z-[80] flex ${DRAWER_WIDTH_CLASS} flex-col border-r border-border bg-card shadow-2xl transition-transform duration-200 ease-out motion-reduce:transition-none pb-[env(safe-area-inset-bottom)] pt-[env(safe-area-inset-top)] ${
          open ? "translate-x-0" : "-translate-x-full"
        }`}
      >
        <div className="flex items-center justify-between gap-2 border-b border-border px-4 py-3">
          <div className="min-w-0">
            {brand ?? (
              <span id={titleId} className="text-base font-semibold text-foreground">
                Navigation
              </span>
            )}
            {brand && (
              <span id={titleId} className="sr-only">
                Navigation
              </span>
            )}
          </div>
          <button
            type="button"
            onClick={() => dispatch("close")}
            aria-label="Close navigation menu"
            data-testid="mobile-nav-close"
            className={`inline-flex ${TOUCH_TARGET_CLASS} items-center justify-center rounded-xl text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary touch-manipulation`}
          >
            <X className="h-5 w-5" aria-hidden="true" />
          </button>
        </div>

        <nav aria-label="Main" className="flex-1 overflow-y-auto overscroll-contain p-3">
          <ul className="space-y-1">
            {items.map((item) => {
              const active = isNavItemActive(item.href, pathname);
              const Icon = item.icon;
              return (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    onClick={() => dispatch("navigate")}
                    aria-current={active ? "page" : undefined}
                    data-testid="mobile-nav-link"
                    className={`flex min-h-12 items-center gap-3 rounded-xl px-3 py-2 text-sm font-medium transition-colors touch-manipulation focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ${
                      active
                        ? "bg-primary/10 text-primary border border-primary/20"
                        : "text-foreground hover:bg-muted border border-transparent"
                    }`}
                  >
                    {Icon && <Icon className="h-5 w-5 shrink-0" aria-hidden="true" />}
                    <span className="min-w-0">
                      <span className="block">{item.label}</span>
                      {item.description && (
                        <span className="block text-[11px] font-normal text-muted-foreground">{item.description}</span>
                      )}
                    </span>
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>

        {footer && <div className="border-t border-border p-4">{footer}</div>}
      </div>
    </>
  );

  return (
    <div className={`md:hidden ${className}`} data-testid="mobile-nav" data-hydrated={hydrated ? "true" : "false"}>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => dispatch("toggle")}
        aria-label={open ? "Close navigation menu" : "Open navigation menu"}
        aria-expanded={open}
        aria-controls={panelId}
        data-testid="mobile-nav-trigger"
        className={`inline-flex ${TOUCH_TARGET_CLASS} items-center justify-center rounded-xl border border-border bg-input text-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary touch-manipulation`}
      >
        <Menu className="h-5 w-5" aria-hidden="true" />
      </button>

      {hydrated && typeof document !== "undefined" ? createPortal(overlay, document.body) : overlay}
    </div>
  );
}

export interface ResponsiveTableProps extends React.HTMLAttributes<HTMLDivElement> {
  /** Accessible name for the scrollable region (required so keyboard users can find it). */
  label: string;
  children?: React.ReactNode;
}

/**
 * Wraps a wide `<table>` so it scrolls horizontally on narrow screens with momentum
 * scrolling and contained overscroll (no accidental back-swipe navigation), while
 * remaining keyboard scrollable via `tabIndex=0`.
 */
export function ResponsiveTable({ label, children, className = "", ...rest }: ResponsiveTableProps) {
  return (
    <div
      role="region"
      aria-label={label}
      tabIndex={0}
      data-testid="responsive-table"
      className={`relative w-full overflow-x-auto overscroll-x-contain [-webkit-overflow-scrolling:touch] scroll-smooth focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ${className}`}
      {...rest}
    >
      {children}
    </div>
  );
}

/** Classes that pin a cell to the right edge of a horizontally scrolling table. */
export const STICKY_ACTION_CELL_CLASS =
  "sticky right-0 z-10 bg-card shadow-[-8px_0_8px_-8px_rgba(0,0,0,0.5)]";

export function StickyActionCell({ className = "", children, ...rest }: React.TdHTMLAttributes<HTMLTableCellElement>) {
  return (
    <td className={`${STICKY_ACTION_CELL_CLASS} px-2 py-1 ${className}`} {...rest}>
      <div className="flex items-center justify-end gap-1 [&>button]:min-h-12 [&>button]:min-w-12 [&>a]:min-h-12 [&>a]:min-w-12">
        {children}
      </div>
    </td>
  );
}

export function StickyActionHeader({ className = "", children, ...rest }: React.ThHTMLAttributes<HTMLTableCellElement>) {
  return (
    <th scope="col" className={`${STICKY_ACTION_CELL_CLASS} px-2 py-3 text-right ${className}`} {...rest}>
      {children ?? <span className="sr-only">Actions</span>}
    </th>
  );
}

export function DesktopNav({
  items = DEFAULT_NAV_ITEMS,
  pathname: pathnameOverride,
  className = "",
}: {
  items?: NavItem[];
  pathname?: string;
  className?: string;
}) {
  const routerPathname = usePathname();
  const pathname = pathnameOverride ?? routerPathname;

  return (
    <nav aria-label="Primary" className={`hidden md:flex items-center gap-1 ${className}`}>
      {items.map((item) => {
        const active = isNavItemActive(item.href, pathname);
        const Icon = item.icon;
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={active ? "page" : undefined}
            className={`inline-flex items-center gap-2 rounded-xl px-3 py-2 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ${
              active
                ? "bg-primary/15 text-primary border border-primary/25 font-semibold"
                : "text-muted-foreground hover:text-foreground hover:bg-muted/60 border border-transparent"
            }`}
          >
            {Icon && <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />}
            <span>{item.label}</span>
          </Link>
        );
      })}
    </nav>
  );
}

export default MobileNav;
