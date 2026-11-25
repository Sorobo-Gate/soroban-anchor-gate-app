import assert from "node:assert";
import { describe, test } from "node:test";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

describe("Escrow Print Stylesheet Verification", () => {
  const cssPath = join(process.cwd(), "src/app/escrow/[id]/print.css");

  test("print.css exists in target route directory", () => {
    assert.strictEqual(existsSync(cssPath), true, "print.css must exist at apps/web/src/app/escrow/[id]/print.css");
  });

  test("print.css includes @media print block", () => {
    const css = readFileSync(cssPath, "utf-8");
    assert.match(css, /@media\s+print/);
  });

  test("print.css hides navigation, wallets, and interactive buttons", () => {
    const css = readFileSync(cssPath, "utf-8");
    assert.match(css, /button/);
    assert.match(css, /header/);
    assert.match(css, /nav/);
    assert.match(css, /display:\s*none\s*!important/);
  });

  test("print.css formats high-contrast typography and QR code for paper archiving", () => {
    const css = readFileSync(cssPath, "utf-8");
    // High-contrast typography
    assert.match(css, /#000000\s*!important/);
    assert.match(css, /#ffffff\s*!important/);
    // QR code formatting
    assert.match(css, /\.qr-code/);
    assert.match(css, /\.qr-container/);
    assert.match(css, /break-inside:\s*avoid/);
  });
});
