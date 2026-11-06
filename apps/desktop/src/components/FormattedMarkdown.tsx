import React, { useMemo } from "react";

type Segment = {
  type: "code" | "prose";
  lang?: string;
  content: string;
  unfinished?: boolean;
};

function splitMarkdown(text: string): Segment[] {
  const out: Segment[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    const open = remaining.match(/```([a-zA-Z0-9_-]*)\r?\n/);
    if (!open || open.index === undefined) {
      out.push({ type: "prose", content: remaining });
      break;
    }
    if (open.index > 0) {
      out.push({ type: "prose", content: remaining.slice(0, open.index) });
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
    out.push({
      type: "code",
      lang: open[1] || "text",
      content: afterOpen.slice(0, closeIdx).replace(/\n$/, ""),
      unfinished: false,
    });
    remaining = afterOpen.slice(closeIdx + 3);
  }
  return out;
}

/**
 * Lightweight, dependency-free Markdown renderer for assistant response text.
 * Closed and unfinished fenced code blocks render as code (streaming-safe).
 */
export function FormattedMarkdown({ text }: { text: string }) {
  const segments = useMemo(() => splitMarkdown(text), [text]);

  if (!text || !text.trim()) {
    return <span className="empty-stream-placeholder">Working…</span>;
  }

  const renderInline = (line: string) => {
    const parts = line.split(/(`[^`]+`|\*\*[^*]+\*\*)/g);
    return parts.map((part, idx) => {
      if (part.startsWith("`") && part.endsWith("`") && part.length >= 2) {
        return (
          <code key={idx} className="md-inline-code">
            {part.slice(1, -1)}
          </code>
        );
      }
      if (part.startsWith("**") && part.endsWith("**") && part.length >= 4) {
        return <strong key={idx}>{part.slice(2, -2)}</strong>;
      }
      return <React.Fragment key={idx}>{part}</React.Fragment>;
    });
  };

  return (
    <div className="md-body">
      {segments.map((seg, i) => {
        if (seg.type === "code") {
          return (
            <div key={i} className={`md-code-block${seg.unfinished ? " md-code-unfinished" : ""}`}>
              <div className="md-code-header">
                <span>{seg.lang || "code"}{seg.unfinished ? " · streaming" : ""}</span>
                <button
                  type="button"
                  className="md-copy-btn"
                  onClick={() => navigator.clipboard?.writeText(seg.content)}
                >
                  Copy
                </button>
              </div>
              <pre>
                <code>{seg.content}</code>
              </pre>
            </div>
          );
        }

        const lines = seg.content.split(/\r?\n/);
        return (
          <div key={i} className="md-prose-block">
            {lines.map((line, lIdx) => {
              const trimmed = line.trim();
              if (!trimmed) return <div key={lIdx} className="md-spacer" />;
              if (trimmed.startsWith("### ")) {
                return (
                  <h4 key={lIdx} className="md-h4">
                    {renderInline(trimmed.slice(4))}
                  </h4>
                );
              }
              if (trimmed.startsWith("## ")) {
                return (
                  <h3 key={lIdx} className="md-h3">
                    {renderInline(trimmed.slice(3))}
                  </h3>
                );
              }
              if (trimmed.startsWith("# ")) {
                return (
                  <h2 key={lIdx} className="md-h2">
                    {renderInline(trimmed.slice(2))}
                  </h2>
                );
              }
              if (/^[-*]\s+/.test(trimmed)) {
                return (
                  <div key={lIdx} className="md-list-item">
                    <span className="md-bullet">•</span>
                    <span>{renderInline(trimmed.replace(/^[-*]\s+/, ""))}</span>
                  </div>
                );
              }
              if (/^\d+\.\s+/.test(trimmed)) {
                const numMatch = /^(\d+\.)\s+(.*)$/.exec(trimmed);
                if (numMatch) {
                  return (
                    <div key={lIdx} className="md-list-item">
                      <span className="md-bullet">{numMatch[1]}</span>
                      <span>{renderInline(numMatch[2])}</span>
                    </div>
                  );
                }
              }
              return (
                <p key={lIdx} className="md-p">
                  {renderInline(line)}
                </p>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}
