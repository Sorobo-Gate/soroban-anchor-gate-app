import assert from "node:assert";
import { describe, test } from "node:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  DEFAULT_NAV_ITEMS,
  MIN_TOUCH_TARGET_PX,
  MobileNav,
  ResponsiveTable,
  STICKY_ACTION_CELL_CLASS,
  StickyActionCell,
  StickyActionHeader,
  TOUCH_TARGET_CLASS,
  drawerReducer,
  isNavItemActive,
  meetsTouchTarget,
} from "../components/MobileNav";

describe("drawerReducer", () => {
  test("open / close / toggle", () => {
    assert.strictEqual(drawerReducer(false, "open"), true);
    assert.strictEqual(drawerReducer(true, "open"), true);
    assert.strictEqual(drawerReducer(true, "close"), false);
    assert.strictEqual(drawerReducer(false, "toggle"), true);
    assert.strictEqual(drawerReducer(true, "toggle"), false);
  });

  test("escape and navigation always close", () => {
    assert.strictEqual(drawerReducer(true, "escape"), false);
    assert.strictEqual(drawerReducer(true, "navigate"), false);
    assert.strictEqual(drawerReducer(false, "escape"), false);
  });

  test("unknown actions are a no-op", () => {
    assert.strictEqual(drawerReducer(true, "bogus" as never), true);
    assert.strictEqual(drawerReducer(false, "bogus" as never), false);
  });
});

describe("isNavItemActive", () => {
  test("root matches only the root", () => {
    assert.ok(isNavItemActive("/", "/"));
    assert.ok(!isNavItemActive("/", "/create"));
  });

  test("segment-prefix matching", () => {
    assert.ok(isNavItemActive("/disputes", "/disputes"));
    assert.ok(isNavItemActive("/disputes", "/disputes/42"));
    assert.ok(!isNavItemActive("/disputes", "/disputes-archive"));
  });

  test("ignores trailing slashes, query strings and hashes", () => {
    assert.ok(isNavItemActive("/create/", "/create?step=2"));
    assert.ok(isNavItemActive("/create", "/create#review"));
    assert.ok(isNavItemActive("/", "/?tab=manage"));
  });

  test("null/empty pathname is never active", () => {
    assert.ok(!isNavItemActive("/", null));
    assert.ok(!isNavItemActive("/", undefined));
    assert.ok(!isNavItemActive("/create", ""));
  });
});

describe("touch target sizing", () => {
  test("minimum is 48px and the Tailwind class matches it (12 * 4px)", () => {
    assert.strictEqual(MIN_TOUCH_TARGET_PX, 48);
    assert.ok(TOUCH_TARGET_CLASS.includes("min-h-12"));
    assert.ok(TOUCH_TARGET_CLASS.includes("min-w-12"));
  });

  test("meetsTouchTarget boundary values", () => {
    assert.ok(meetsTouchTarget(48, 48));
    assert.ok(meetsTouchTarget(200, 48));
    assert.ok(!meetsTouchTarget(47.9, 48));
    assert.ok(!meetsTouchTarget(48, 47));
    assert.ok(!meetsTouchTarget(Number.NaN, 48));
    assert.ok(!meetsTouchTarget(Infinity, 48));
  });
});

describe("<MobileNav /> rendering", () => {
  test("renders a 48px hamburger trigger with correct ARIA, hidden at md+", () => {
    const html = renderToStaticMarkup(React.createElement(MobileNav, { pathname: "/" }));
    assert.match(html, /class="md:hidden/);
    assert.match(html, /data-testid="mobile-nav-trigger"[^>]*class="[^"]*min-h-12 min-w-12/);
    assert.ok(html.includes('aria-expanded="false"'));
    assert.ok(html.includes('aria-label="Open navigation menu"'));
  });

  test("closed drawer is off-canvas, inert, and aria-hidden", () => {
    const html = renderToStaticMarkup(React.createElement(MobileNav, { pathname: "/" }));
    assert.match(html, /data-testid="mobile-nav-drawer"[^>]*data-state="closed"/);
    assert.ok(html.includes("-translate-x-full"));
    assert.ok(html.includes('aria-hidden="true"'));
    assert.match(html, /inert=""/);
  });

  test("open drawer renders all nav links with aria-current on the active route", () => {
    const html = renderToStaticMarkup(React.createElement(MobileNav, { pathname: "/disputes/12", defaultOpen: true }));
    assert.match(html, /data-state="open"/);
    assert.ok(html.includes('aria-expanded="true"'));
    for (const item of DEFAULT_NAV_ITEMS) {
      assert.ok(html.includes(`href="${item.href}"`), `missing link ${item.href}`);
      assert.ok(html.includes(item.label));
    }
    const active = [...html.matchAll(/<a[^>]*aria-current="page"[^>]*href="([^"]+)"|<a[^>]*href="([^"]+)"[^>]*aria-current="page"/g)];
    assert.strictEqual(active.length, 1);
    assert.strictEqual(active[0][1] ?? active[0][2], "/disputes");
  });

  test("every nav link and the close button meet the 48px touch target", () => {
    const html = renderToStaticMarkup(React.createElement(MobileNav, { pathname: "/", defaultOpen: true }));
    const links = [...html.matchAll(/<a [^>]*class="([^"]+)"/g)];
    assert.strictEqual(links.length, DEFAULT_NAV_ITEMS.length);
    for (const [, cls] of links) assert.ok(cls.includes("min-h-12"), cls);
    assert.match(html, /data-testid="mobile-nav-close"[^>]*class="[^"]*min-h-12 min-w-12/);
  });

  test("supports custom items, brand, and footer slots", () => {
    const html = renderToStaticMarkup(
      React.createElement(MobileNav, {
        pathname: "/x",
        defaultOpen: true,
        items: [{ href: "/x", label: "Custom" }],
        brand: React.createElement("span", null, "BrandMark"),
        footer: React.createElement("button", null, "Connect Freighter"),
      })
    );
    assert.ok(html.includes("Custom"));
    assert.ok(html.includes("BrandMark"));
    assert.ok(html.includes("Connect Freighter"));
    assert.ok(html.includes('class="sr-only"'), "dialog keeps an accessible name when a brand is supplied");
  });

  test("renders an empty list without crashing", () => {
    const html = renderToStaticMarkup(React.createElement(MobileNav, { pathname: "/", items: [], defaultOpen: true }));
    assert.ok(!html.includes("mobile-nav-link"));
  });
});

describe("<ResponsiveTable /> and sticky actions", () => {
  test("wraps tables in a focusable, labelled horizontal scroll region", () => {
    const html = renderToStaticMarkup(
      React.createElement(ResponsiveTable, { label: "Escrow records" }, React.createElement("table", null))
    );
    assert.ok(html.includes('role="region"'));
    assert.ok(html.includes('aria-label="Escrow records"'));
    assert.ok(html.includes('tabindex="0"'));
    assert.ok(html.includes("overflow-x-auto"));
    assert.ok(html.includes("overscroll-x-contain"));
  });

  test("sticky action cells pin to the right edge with 48px buttons", () => {
    const html = renderToStaticMarkup(
      React.createElement(
        "table",
        null,
        React.createElement(
          "tbody",
          null,
          React.createElement("tr", null, React.createElement(StickyActionCell, null, React.createElement("button", null, "Release")))
        )
      )
    );
    assert.ok(STICKY_ACTION_CELL_CLASS.includes("sticky"));
    assert.ok(STICKY_ACTION_CELL_CLASS.includes("right-0"));
    assert.ok(html.includes("sticky right-0"));
    assert.ok(html.includes("[&amp;&gt;button]:min-h-12"));
  });

  test("sticky header defaults to a screen-reader 'Actions' label", () => {
    const html = renderToStaticMarkup(
      React.createElement("table", null, React.createElement("thead", null, React.createElement("tr", null, React.createElement(StickyActionHeader))))
    );
    assert.ok(html.includes('scope="col"'));
    assert.ok(html.includes("Actions"));
  });
});
