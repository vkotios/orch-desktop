import React, { useMemo, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { callHost } from "../lib/api";

type Props = {
  text: string;
  /** Owned project/repo root used to resolve file references. */
  repoPath?: string | null;
};

type Segment = {
  type: "markdown" | "code";
  lang?: string;
  content: string;
  unfinished?: boolean;
};

const FILE_REF_RE =
  /^(?:(?:[A-Za-z]:)?[\\/])?(?:[\w.-]+[\\/])+[\w.-]+(?:\.\w+)?$|^\.\/[\w./\\-]+$|^[\w.-]+\.[A-Za-z0-9]{1,12}$/;

function splitStreamingFences(text: string): Segment[] {
  const out: Segment[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    const open = remaining.match(/```([a-zA-Z0-9_-]*)\r?\n/);
    if (!open || open.index === undefined) {
      out.push({ type: "markdown", content: remaining });
      break;
    }
    if (open.index > 0) {
      out.push({ type: "markdown", content: remaining.slice(0, open.index) });
    }
    const afterOpen = remaining.slice(open.index + open[0].length);
    const closeIdx = afterOpen.indexOf("```");
    if (closeIdx === -1) {
      out.push({
        type: "code",
        lang: open[1] || "text",
        content: afterOpen.replace(/\n$/, ""),
        unfinished: true,
      });
      break;
    }
    // Keep closed fences in markdown so the maintained renderer owns them.
    const fence = remaining.slice(open.index, open.index + open[0].length + closeIdx + 3);
    const prev = out[out.length - 1];
    if (prev && prev.type === "markdown") {
      prev.content += fence;
    } else {
      out.push({ type: "markdown", content: fence });
    }
    remaining = afterOpen.slice(closeIdx + 3);
  }
  return out;
}

function isSafeExternalHref(href: string): boolean {
  try {
    const url = new URL(href);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

function looksLikeFileRef(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 512) return false;
  if (/\s/.test(trimmed)) return false;
  if (/^https?:\/\//i.test(trimmed) || /^mailto:/i.test(trimmed)) return false;
  return FILE_REF_RE.test(trimmed.replace(/\\/g, "/"));
}

async function resolveFileRef(repoPath: string, filePath: string) {
  return callHost<{
    path: string;
    absolutePath: string;
    exists: boolean;
  }>("project_resolve_path", { repoPath, path: filePath.replace(/\\/g, "/") });
}

function FileReference({
  label,
  repoPath,
}: {
  label: string;
  repoPath?: string | null;
}) {
  const [note, setNote] = React.useState<string | null>(null);
  const disabled = !repoPath;
  return (
    <button
      type="button"
      className="md-file-ref"
      title={disabled ? "No project path available for file references" : `Resolve ${label} under the project`}
      disabled={disabled}
      onClick={() => {
        if (!repoPath) return;
        void resolveFileRef(repoPath, label)
          .then((resolved) => {
            setNote(
              `${resolved.exists ? "Found" : "Missing"}: ${resolved.path}${
                resolved.absolutePath ? ` → ${resolved.absolutePath}` : ""
              }`,
            );
          })
          .catch((err) => {
            setNote(err instanceof Error ? err.message : String(err));
          });
      }}
    >
      <code className="md-inline-code md-file-ref-code">{label}</code>
      {note ? <span className="md-file-ref-note">{note}</span> : null}
    </button>
  );
}

function CodeBlock({
  lang,
  content,
  unfinished,
}: {
  lang?: string;
  content: string;
  unfinished?: boolean;
}) {
  return (
    <div className={`md-code-block${unfinished ? " md-code-unfinished" : ""}`}>
      <div className="md-code-header">
        <span>
          {lang || "code"}
          {unfinished ? " · streaming" : ""}
        </span>
        <button
          type="button"
          className="md-copy-btn"
          onClick={() => navigator.clipboard?.writeText(content)}
        >
          Copy
        </button>
      </div>
      <pre>
        <code>{content}</code>
      </pre>
    </div>
  );
}

/**
 * Maintained Markdown renderer (react-markdown + GFM) with streaming-safe
 * unfinished fences and repository-relative file references.
 */
export function FormattedMarkdown({ text, repoPath = null }: Props) {
  const segments = useMemo(() => splitStreamingFences(text), [text]);

  if (!text || !text.trim()) {
    return <span className="empty-stream-placeholder">Working…</span>;
  }

  const markdownComponents = {
    a: ({ href, children }: { href?: string; children?: ReactNode }) => {
      const target = typeof href === "string" ? href : "";
      if (target && looksLikeFileRef(target)) {
        return <FileReference label={target} repoPath={repoPath} />;
      }
      if (target && isSafeExternalHref(target)) {
        return (
          <a href={target} target="_blank" rel="noreferrer noopener">
            {children}
          </a>
        );
      }
      return <span className="md-link-blocked">{children}</span>;
    },
    code: ({ className, children }: { className?: string; children?: ReactNode }) => {
      const value = String(children ?? "").replace(/\n$/, "");
      const isBlock = Boolean(className) || value.includes("\n");
      if (isBlock) {
        const lang = className?.replace(/^language-/, "") || "text";
        return <CodeBlock lang={lang} content={value} />;
      }
      if (looksLikeFileRef(value)) {
        return <FileReference label={value} repoPath={repoPath} />;
      }
      return <code className="md-inline-code">{value}</code>;
    },
    pre: ({ children }: { children?: ReactNode }) => <>{children}</>,
  };

  return (
    <div className="md-body">
      {segments.map((seg, i) => {
        if (seg.type === "code") {
          return (
            <CodeBlock
              key={i}
              lang={seg.lang}
              content={seg.content}
              unfinished={seg.unfinished}
            />
          );
        }
        return (
          <div key={i} className="md-prose-block">
            <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
              {seg.content}
            </ReactMarkdown>
          </div>
        );
      })}
    </div>
  );
}
