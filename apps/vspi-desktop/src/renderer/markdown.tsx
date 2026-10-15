import { memo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { cn } from "./lib/cn";

export const Markdown = memo(function Markdown({
  text,
  className,
}: {
  text: string;
  className?: string;
}) {
  return (
    <div className={cn("vspi-md", className)}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ children, href }) => (
            <span
              className="text-primary underline underline-offset-2"
              title={href}
            >
              {children}
            </span>
          ),
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
});
