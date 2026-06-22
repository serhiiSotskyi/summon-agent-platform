import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Components } from "react-markdown";

function createMarkdownComponents(variant: "default" | "compact") {
  const compact = variant === "compact";

  return {
  a: ({ children, href }) => (
    <a
      className="text-emerald-100 underline underline-offset-4 hover:text-emerald-50"
      href={href}
      rel="noreferrer"
      target="_blank"
    >
      {children}
    </a>
  ),
  blockquote: ({ children }) => (
    <blockquote
      className={
        compact
          ? "my-3 border-l-2 border-emerald-200/40 pl-3 text-zinc-300"
          : "my-5 border-l-2 border-emerald-200/40 pl-4 text-zinc-300"
      }
    >
      {children}
    </blockquote>
  ),
  code: ({ children, className }) => {
    const isBlock = Boolean(className);

    if (isBlock) {
      return (
        <code
          className={
            compact
              ? "block overflow-x-auto rounded-md border border-white/10 bg-black/30 p-3 font-mono text-xs leading-5 text-zinc-200"
              : "block overflow-x-auto rounded-md border border-white/10 bg-black/30 p-4 font-mono text-xs leading-6 text-zinc-200"
          }
        >
          {children}
        </code>
      );
    }

    return (
      <code className="rounded border border-white/10 bg-white/5 px-1.5 py-0.5 font-mono text-[0.88em] text-emerald-100">
        {children}
      </code>
    );
  },
  h1: ({ children }) => (
    <h1
      className={
        compact
          ? "mt-4 first:mt-0 text-base font-semibold tracking-tight text-white"
          : "mt-8 first:mt-0 text-2xl font-semibold tracking-tight text-white"
      }
    >
      {children}
    </h1>
  ),
  h2: ({ children }) => (
    <h2
      className={
        compact
          ? "mt-4 first:mt-0 text-sm font-semibold tracking-tight text-white"
          : "mt-8 first:mt-0 text-xl font-semibold tracking-tight text-white"
      }
    >
      {children}
    </h2>
  ),
  h3: ({ children }) => (
    <h3
      className={
        compact
          ? "mt-3 first:mt-0 text-sm font-semibold tracking-tight text-zinc-100"
          : "mt-6 first:mt-0 text-lg font-semibold tracking-tight text-white"
      }
    >
      {children}
    </h3>
  ),
  h4: ({ children }) => (
    <h4
      className={
        compact
          ? "mt-3 first:mt-0 text-sm font-semibold text-zinc-100"
          : "mt-5 first:mt-0 text-base font-semibold text-zinc-100"
      }
    >
      {children}
    </h4>
  ),
  hr: () => <hr className={compact ? "my-4 border-white/10" : "my-6 border-white/10"} />,
  li: ({ children }) => <li className="pl-1">{children}</li>,
  ol: ({ children }) => (
    <ol
      className={
        compact
          ? "my-2 list-decimal space-y-1.5 pl-5 text-zinc-200"
          : "my-4 list-decimal space-y-2 pl-5 text-zinc-200"
      }
    >
      {children}
    </ol>
  ),
  p: ({ children }) => (
    <p className={compact ? "my-2 leading-6 text-zinc-200" : "my-4 leading-7 text-zinc-200"}>
      {children}
    </p>
  ),
  pre: ({ children }) => <pre className="my-4 overflow-x-auto">{children}</pre>,
  strong: ({ children }) => (
    <strong className="font-semibold text-white">{children}</strong>
  ),
  table: ({ children }) => (
    <div className="my-5 overflow-x-auto rounded-md border border-white/10">
      <table className="min-w-full divide-y divide-white/10 text-sm">{children}</table>
    </div>
  ),
  tbody: ({ children }) => (
    <tbody className="divide-y divide-white/10">{children}</tbody>
  ),
  td: ({ children }) => (
    <td className="px-3 py-2 align-top text-zinc-300">{children}</td>
  ),
  th: ({ children }) => (
    <th className="bg-white/[0.04] px-3 py-2 text-left font-medium text-zinc-100">
      {children}
    </th>
  ),
  ul: ({ children }) => (
    <ul
      className={
        compact
          ? "my-2 list-disc space-y-1.5 pl-5 text-zinc-200"
          : "my-4 list-disc space-y-2 pl-5 text-zinc-200"
      }
    >
      {children}
    </ul>
  ),
  } satisfies Components;
}

const markdownComponents = createMarkdownComponents("default");
const compactMarkdownComponents = createMarkdownComponents("compact");

export function MarkdownOutput({
  content,
  variant = "default",
}: {
  content: string;
  variant?: "default" | "compact";
}) {
  return (
    <div
      className={
        variant === "compact"
          ? "rounded-md border border-white/10 bg-black/20 p-4 text-sm leading-6 text-zinc-200"
          : "rounded-md border border-white/10 bg-black/20 p-5 text-sm leading-7 text-zinc-200"
      }
    >
      <ReactMarkdown
        components={variant === "compact" ? compactMarkdownComponents : markdownComponents}
        remarkPlugins={[remarkGfm]}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
