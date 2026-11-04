import React from "react";
import Image from "next/image";

interface LogoProps {
  className?: string;
  size?: number;
  showSubtitle?: boolean;
}

/**
 * Full logo with extracted brand emblem + official wordmark typography.
 * Matches banner brand identity:
 * - Emblem: Anchor badge with maritime waves & electric cyan border outline
 * - Typography: "SorobanAnchor" (white) + "Gate" (sky blue)
 * - Subtitle: "WEB APPLICATION"
 */
export function SorobanAnchorLogo({
  className = "",
  size = 42,
  showSubtitle = true,
}: LogoProps) {
  return (
    <div className={`flex items-center gap-3 select-none ${className}`}>
      <div
        className="relative shrink-0 rounded-full transition-transform duration-300 hover:scale-105"
        style={{ width: size, height: size }}
      >
        <Image
          src="/sag-logo.png"
          alt="SorobanAnchor Gate"
          width={size * 2}
          height={size * 2}
          className="rounded-full object-contain"
          style={{ width: size, height: size }}
          priority
          unoptimized
        />
      </div>

      <div className="flex flex-col justify-center">
        <div className="flex items-center text-lg leading-tight tracking-tight">
          <span className="font-bold text-foreground">SorobanAnchor</span>
          <span className="font-extrabold text-brand-gate ml-1">Gate</span>
        </div>
        {showSubtitle && (
          <span className="text-[10px] tracking-[0.26em] text-muted-foreground uppercase font-medium mt-0.5">
            Web Application
          </span>
        )}
      </div>
    </div>
  );
}

/**
 * Compact icon-only logo for favicons, nav badges, and wallet status indicators.
 */
export function SAGIcon({ size = 24 }: { size?: number }) {
  return (
    <div
      className="inline-flex items-center justify-center rounded-full bg-primary/10 p-0.5 transition-colors hover:bg-primary/20"
      style={{ width: size + 6, height: size + 6 }}
    >
      <Image
        src="/sag-logo.png"
        alt="SorobanAnchor Gate Icon"
        width={size * 2}
        height={size * 2}
        className="rounded-full object-contain"
        style={{ width: size, height: size }}
        unoptimized
      />
    </div>
  );
}
