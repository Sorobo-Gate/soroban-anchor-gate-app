import React from "react";
import Image from "next/image";

interface LogoProps {
  className?: string;
  size?: number;
}

/**
 * Full logo with SAG monogram image + wordmark.
 * Renders the image at 2x the display size for retina sharpness.
 */
export function SorobanAnchorLogo({ className = "", size = 42 }: LogoProps) {
  return (
    <div className={`flex items-center gap-3 ${className}`}>
      <Image
        src="/sag-logo.jpg"
        alt="SAG — Soroban Anchor Gate"
        width={size * 6}
        height={size * 12}
        className="shrink-0 rounded-lg transition-transform duration-300 hover:scale-105"
        style={{ width: size, height: size }}
        priority
        unoptimized
      />

      <div className="flex flex-col">
        <span className="font-bold text-lg leading-tight tracking-tight text-foreground font-mono">
          <span className="text-primary font-black">SAG</span>
          <span className="text-muted-foreground text-xs ml-1 font-medium tracking-wider">
            PROTOCOL
          </span>
        </span>
        <span className="text-[10px] tracking-[0.25em] text-muted-foreground uppercase font-semibold">
          Soroban Anchor Gate
        </span>
      </div>
    </div>
  );
}

/**
 * Compact icon-only logo for favicons, nav icons, etc.
 */
export function SAGIcon({ size = 24 }: { size?: number }) {
  return (
    <div className="inline-flex items-center justify-center rounded-lg bg-primary/10 p-1.5 transition-colors hover:bg-primary/20">
      <Image
        src="/sag-logo.jpg"
        alt="SAG"
        width={size * 2}
        height={size * 2}
        className="rounded-md"
        style={{ width: size, height: size }}
        unoptimized
      />
    </div>
  );
}