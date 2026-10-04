import * as React from "react";

export function Card({ className = "", ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={`rounded-2xl border border-border bg-card text-card-foreground shadow-sm ${className}`} {...props} />;
}

export function CardHeader({ className = "", ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={`flex flex-col space-y-1.5 p-6 border-b border-border/60 ${className}`} {...props} />;
}

export function CardTitle({ className = "", ...props }: React.HTMLAttributes<HTMLHeadingElement>) {
  return <h3 className={`text-lg font-semibold leading-none tracking-tight text-foreground ${className}`} {...props} />;
}

export function CardDescription({ className = "", ...props }: React.HTMLAttributes<HTMLParagraphElement>) {
  return <p className={`text-sm text-muted-foreground ${className}`} {...props} />;
}

export function CardContent({ className = "", ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={`p-6 ${className}`} {...props} />;
}