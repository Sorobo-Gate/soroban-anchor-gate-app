import { test, expect, type Locator, type Page } from "@playwright/test";

const MIN_TOUCH_TARGET_PX = 48;

async function expectTouchTarget(locator: Locator, label: string) {
  const box = await locator.boundingBox();
  expect(box, `${label} should be visible`).not.toBeNull();
  expect(box!.width, `${label} width`).toBeGreaterThanOrEqual(MIN_TOUCH_TARGET_PX);
  expect(box!.height, `${label} height`).toBeGreaterThanOrEqual(MIN_TOUCH_TARGET_PX);
}

async function expectNoHorizontalPageOverflow(page: Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow, "page must not scroll horizontally").toBeLessThanOrEqual(1);
}

const drawer = (page: Page) => page.getByTestId("mobile-nav-drawer").first();
const trigger = (page: Page) => page.getByTestId("mobile-nav-trigger").first();

/** Navigate and wait until React has hydrated the nav, so taps are not lost. */
async function gotoHydrated(page: Page, path: string) {
  await page.goto(path);
  await expect(page.locator('[data-testid="mobile-nav"][data-hydrated="true"]').first()).toBeAttached({ timeout: 60_000 });
}

test.describe("mobile & tablet navigation drawer", () => {
  test.skip(({ viewport }) => (viewport?.width ?? 0) >= 768, "drawer only applies below the md breakpoint");

  test.beforeEach(async ({ page }) => {
    await gotoHydrated(page, "/");
    await expect(trigger(page)).toBeVisible();
  });

  test("hamburger trigger is visible and meets the 48x48 touch target", async ({ page }) => {
    await expectTouchTarget(trigger(page), "menu trigger");
    await expect(trigger(page)).toHaveAttribute("aria-expanded", "false");
  });

  test("drawer slides in, lists routes with 48px targets, and marks the active page", async ({ page }) => {
    await expect(drawer(page)).toHaveAttribute("data-state", "closed");
    const closedBox = await drawer(page).boundingBox();
    expect(closedBox!.x + closedBox!.width).toBeLessThanOrEqual(1);

    await trigger(page).tap();
    await expect(drawer(page)).toHaveAttribute("data-state", "open");
    await expect(trigger(page)).toHaveAttribute("aria-expanded", "true");
    await expect(page.getByRole("dialog", { name: "Navigation" })).toBeVisible();

    // Wait for the slide transition to settle on-screen.
    await expect.poll(async () => (await drawer(page).boundingBox())?.x ?? -1).toBe(0);

    // Regression: the drawer must span the full viewport height, not be clipped to the
    // sticky blurred header (backdrop-filter creates a containing block for fixed elements).
    const openBox = (await drawer(page).boundingBox())!;
    expect(openBox.height).toBeGreaterThanOrEqual(page.viewportSize()!.height - 1);

    const links = drawer(page).getByTestId("mobile-nav-link");
    await expect(links).toHaveCount(3);
    for (let i = 0; i < 3; i++) await expectTouchTarget(links.nth(i), `nav link ${i}`);
    await expectTouchTarget(page.getByTestId("mobile-nav-close").first(), "close button");
    await expect(drawer(page).locator('a[aria-current="page"]')).toHaveAttribute("href", "/");

    // Body scroll is locked while open.
    expect(await page.evaluate(() => document.body.style.overflow)).toBe("hidden");
  });

  test("closes via close button, backdrop tap, and Escape", async ({ page }) => {
    await trigger(page).tap();
    await page.getByTestId("mobile-nav-close").first().tap();
    await expect(drawer(page)).toHaveAttribute("data-state", "closed");
    await expect(trigger(page)).toBeFocused();

    await trigger(page).tap();
    const viewport = page.viewportSize()!;
    await page.mouse.click(viewport.width - 10, viewport.height / 2); // tap the backdrop beside the panel
    await expect(drawer(page)).toHaveAttribute("data-state", "closed");

    await trigger(page).tap();
    await page.keyboard.press("Escape");
    await expect(drawer(page)).toHaveAttribute("data-state", "closed");
    expect(await page.evaluate(() => document.body.style.overflow)).toBe("");
  });

  test("navigating via a drawer link routes and closes the drawer", async ({ page }) => {
    await trigger(page).tap();
    await drawer(page).getByRole("link", { name: /Disputes/ }).tap();
    await expect(page).toHaveURL(/\/disputes$/);
    await expect(drawer(page)).toHaveAttribute("data-state", "closed");
    await trigger(page).tap();
    await expect(drawer(page).locator('a[aria-current="page"]')).toHaveAttribute("href", "/disputes");
  });

  test("closed drawer links are not focusable (inert)", async ({ page }) => {
    const firstLink = drawer(page).getByTestId("mobile-nav-link").first();
    await firstLink.focus().catch(() => undefined);
    await expect(firstLink).not.toBeFocused();
  });

  for (const path of ["/", "/create", "/disputes"]) {
    test(`no horizontal page overflow on ${path}`, async ({ page }) => {
      await gotoHydrated(page, path);
      await expectNoHorizontalPageOverflow(page);
    });
  }

  test("dashboard tabs meet the touch target height", async ({ page }) => {
    const tabs = page.getByRole("button", { name: /Deposit Milestone Escrow|Manage Escrow/ });
    await expect(tabs).toHaveCount(2);
    for (let i = 0; i < 2; i++) {
      const box = await tabs.nth(i).boundingBox();
      expect(box!.height).toBeGreaterThanOrEqual(MIN_TOUCH_TARGET_PX);
    }
  });
});

test.describe("desktop", () => {
  test.skip(({ viewport }) => (viewport?.width ?? 0) < 768, "desktop-only assertions");

  test("hamburger is hidden at md+ widths", async ({ page }) => {
    await gotoHydrated(page, "/");
    await expect(trigger(page)).toBeHidden();
  });
});
