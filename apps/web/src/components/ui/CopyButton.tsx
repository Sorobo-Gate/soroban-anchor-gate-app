"use client";

import * as React from "react";
import { useState, useRef, useEffect } from "react";
import { Copy, Check } from "lucide-react";
import { copyToClipboard } from "@/lib/clipboard";

export interface CopyButtonProps
  extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "onCopy"> {
  text?: string;
  value?: string;
  label?: string;
  copiedLabel?: string;
  timeout?: number;
  variant?: "default" | "secondary" | "outline" | "ghost";
  size?: "default" | "sm" | "lg" | "icon";
  onCopy?: (success: boolean) => void;
}

export const CopyButton = React.forwardRef<HTMLButtonElement, CopyButtonProps>(
  (
    {
      text,
      value,
      label,
      copiedLabel = "Copied!",
      timeout = 2000,
      className = "",
      variant = "ghost",
      size = "icon",
      onCopy,
      onClick,
      ...props
    },
    ref
  ) => {
    const [copied, setCopied] = useState(false);
    const timerRef = useRef<NodeJS.Timeout | null>(null);

    const copyText = text ?? value ?? "";

    useEffect(() => {
      return () => {
        if (timerRef.current) {
          clearTimeout(timerRef.current);
        }
      };
    }, []);

    const handleCopy = async (e: React.MouseEvent<HTMLButtonElement>) => {
      if (onClick) {
        onClick(e);
      }

      if (!copyText) {
        return;
      }

      const success = await copyToClipboard(copyText);
      if (success) {
        setCopied(true);
        if (timerRef.current) {
          clearTimeout(timerRef.current);
        }
        timerRef.current = setTimeout(() => {
          setCopied(false);
        }, timeout);
      }

      if (onCopy) {
        onCopy(success);
      }
    };

    const baseStyles =
      "relative inline-flex items-center justify-center rounded-lg font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:pointer-events-none disabled:opacity-50 cursor-pointer group";

    const variantStyles = {
      default: "bg-primary text-primary-foreground shadow hover:bg-primary/90",
      secondary: "bg-secondary text-secondary-foreground hover:bg-secondary/80",
      outline: "border border-border bg-transparent hover:bg-muted text-foreground",
      ghost: "hover:bg-muted text-muted-foreground hover:text-foreground",
    };

    const sizeStyles = {
      default: "h-9 px-4 py-2 text-sm",
      sm: "h-8 px-2.5 text-xs",
      lg: "h-10 px-6 text-base",
      icon: "h-8 w-8",
    };

    return (
      <button
        ref={ref}
        type="button"
        onClick={handleCopy}
        aria-label={copied ? copiedLabel : label || "Copy to clipboard"}
        title={copied ? copiedLabel : label || "Copy to clipboard"}
        className={`${baseStyles} ${variantStyles[variant]} ${sizeStyles[size]} ${className}`}
        {...props}
      >
        {copied ? (
          <Check className="w-4 h-4 text-emerald-400 transition-transform duration-200 scale-110" />
        ) : (
          <Copy className="w-4 h-4 transition-transform duration-200 group-hover:scale-105" />
        )}

        {label && (
          <span className="ml-1.5 text-xs font-mono">
            {copied ? copiedLabel : label}
          </span>
        )}

        {/* Visual Tooltip Transition */}
        <span
          role="tooltip"
          className={`pointer-events-none absolute -top-8 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-md px-2 py-0.5 text-[11px] font-medium transition-all duration-200 ${
            copied
              ? "opacity-100 scale-100 translate-y-0 bg-emerald-500 text-white shadow-sm"
              : "opacity-0 scale-95 translate-y-1 group-hover:opacity-100 group-hover:scale-100 group-hover:translate-y-0 bg-foreground text-background shadow-sm"
          }`}
        >
          {copied ? copiedLabel : "Copy to clipboard"}
        </span>
      </button>
    );
  }
);

CopyButton.displayName = "CopyButton";
