// webview/ChatBar.tsx
// En “nästan identisk” chattbar som ChatGPTs inmatningsfält:
// - Sticky längst ned, centrerad layout, subtil blur/gradient-bakgrund.
// - Textarea som auto-resizar (Shift+Enter = ny rad, Enter = skicka).
// - Visar Send-knapp (pappersflyg) när det finns text, annars disabled.
// - Busy-läge visar Stop-knapp. Stöd för onSend/onStop.
// - Sparar draft lokalt via VS Code Webview API (överlever refresh).
// - Tillgänglighetsanpassad (sr-only label, ARIA).
//
// Användning:
// <ChatBar
//    onSend={async (text) => { ... }}
//    onStop={() => { ... }}
//    busy={isGenerating}
//    disabled={false}
//    placeholder="Skriv ett meddelande..."
// />
//
// Obs: Ingen extern CSS krävs, men .sr-only (finns i din index.css) utnyttjas.
// Komponent använder VS Code-temafärger om tillgängliga.

import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { getVsCodeApi } from "./vscodeApi";


type ChatBarProps = {
  onSend: (text: string) => void | Promise<void>;
  onStop?: () => void;
  busy?: boolean;
  disabled?: boolean;
  placeholder?: string;
  maxChars?: number;      // hårt max (klipper input), default 8000
  maxRows?: number;       // max visuella rader innan scroll, default 10
  autoFocus?: boolean;
  onHeightChange?: (px: number) => void;  // ⬅️ ny
};

const vscode = getVsCodeApi();

const DEFAULT_MAX_CHARS = 8000;
const DEFAULT_MAX_ROWS = 10;

export default function ChatBar({
  onSend,
  onStop,
  busy = false,
  disabled = false,
  placeholder = "Message ChatGPT",
  maxChars = DEFAULT_MAX_CHARS,
  maxRows = DEFAULT_MAX_ROWS,
  autoFocus = false,
  onHeightChange,
}: ChatBarProps) {

  const [value, setValue] = useState<string>("");
  const [isComposing, setIsComposing] = useState(false);
  const [lastSent, setLastSent] = useState<string>("");
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const formRef = useRef<HTMLFormElement | null>(null);
  const [charCount, setCharCount] = useState<number>(0);

  // --- Draft persistence via VS Code Webview state
  useEffect(() => {
    try {
      const state = vscode.getState?.() || {};
      if (typeof state.chatDraft === "string") {
        setValue(state.chatDraft);
        setCharCount(state.chatDraft.length);
      }
    } catch {}
  }, []);

  useEffect(() => {
    try {
      const prev = vscode.getState?.() || {};
      vscode.setState?.({ ...prev, chatDraft: value });
    } catch {}
    setCharCount(value.length);
  }, [value]);

  // --- Autosize textarea (upp till maxRows)
  const resizeTextarea = useCallback(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    const lineHeight = getLineHeight(ta);
    const maxHeight = lineHeight * maxRows + getVerticalPadding(ta);
    const newH = Math.min(ta.scrollHeight, Math.max(lineHeight + getVerticalPadding(ta), maxHeight));
    ta.style.height = `${newH}px`;
    // Om scrollHeight > maxHeight -> visa scrollbar
    ta.style.overflowY = ta.scrollHeight > maxHeight ? "auto" : "hidden";
  }, [maxRows]);

  useLayoutEffect(() => {
    resizeTextarea();
  }, [value, resizeTextarea]);

  // Autofokus om begärt
  useEffect(() => {
    if (autoFocus && textareaRef.current) {
      textareaRef.current.focus();
      placeCaretAtEnd(textareaRef.current);
    }
  }, [autoFocus]);

  // --- Handlers
  const handleChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const text = e.target.value.slice(0, maxChars);
    setValue(text);
  }, [maxChars]);

  const doSend = useCallback(async () => {
    const text = value.trim();
    if (!text || busy || disabled) return;
    try {
      await onSend(text);
      setLastSent(text);
      setValue("");
    } catch (err) {
      // lämna texten om sändning misslyckas
      // ev. logg:
      console.error("ChatBar onSend error:", err);
    }
  }, [value, onSend, busy, disabled]);

  const onKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter") {
      if (isComposing) return; // respektera IME
      if (e.shiftKey) return;  // ny rad
      e.preventDefault();
      void doSend();
      return;
    }
    // Ctrl/Cmd+Enter skickar också
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "enter") {
      e.preventDefault();
      void doSend();
      return;
    }
    // Pil upp i tomt fält: hämta senaste skickade texten
    if (e.key === "ArrowUp" && !value) {
      if (lastSent) {
        setValue(lastSent);
        // flytta caret till slutet efter mount
        requestAnimationFrame(() => {
          const ta = textareaRef.current;
          if (ta) placeCaretAtEnd(ta);
        });
      }
    }
  }, [value, lastSent, isComposing, doSend]);

  const onCompositionStart = useCallback(() => setIsComposing(true), []);
  const onCompositionEnd = useCallback(() => setIsComposing(false), []);

  const onSubmit = useCallback((e: React.FormEvent) => {
    e.preventDefault();
    void doSend();
  }, [doSend]);

  const handleStop = useCallback(() => {
    if (onStop) onStop();
  }, [onStop]);

  // --- UI state helpers
  const canSend = useMemo(() => {
    return !!value.trim() && !busy && !disabled;
  }, [value, busy, disabled]);

  const nearLimit = useMemo(() => {
    return charCount > 0 && maxChars > 0 && charCount >= maxChars * 0.9;
  }, [charCount, maxChars]);

  // --- Styles (inline för robusthet i webview)
  const styles = useMemo(() => {
    const border = "var(--border, rgba(127,127,127,.25))";
    const fg = "var(--foreground, #e6e6e6)";
    const accent = "var(--accent, #6ea8fe)";
    const card = "color-mix(in srgb, var(--vscode-editorWidget-background, rgba(30,30,30,.85)) 92%, transparent)";
    const placeholder = "color-mix(in srgb, var(--foreground, #ccc) 55%, transparent)";

    return {
      wrap: {
        position: "fixed" as const,
        left: 0,
        right: 0,
        bottom: 0,
        padding: "12px 16px",
        zIndex: 100,
        // mjuk top-gradient som ChatGPT
        background:
          "linear-gradient(to top, color-mix(in srgb, var(--vscode-editor-background, #0b0b0b) 88%, transparent) 35%, transparent 100%)",
        backdropFilter: "saturate(1.1) blur(4px)",
        WebkitBackdropFilter: "saturate(1.1) blur(4px)",
      },
      inner: {
        maxWidth: 920,
        margin: "0 auto",
        pointerEvents: "auto" as const,
      },
      shell: {
        display: "flex",
        alignItems: "flex-end",
        gap: 8,
        border: `1px solid ${border}`,
        borderRadius: 16,
        padding: 8,
        background: card,
        boxShadow: "0 1px 8px rgba(0,0,0,.25)",
      },
      textarea: {
        flex: 1,
        border: "none",
        outline: "none",
        background: "transparent",
        resize: "none" as const,
        color: fg,
        fontSize: 15,
        lineHeight: "22px",
        maxHeight: 320, // fallback; autosize hanterar ändå
        caretColor: accent,
        padding: "6px 8px",
      },
      placeholder: {
        color: placeholder,
      },
      hint: {
        fontSize: 12,
        opacity: 0.6,
        marginTop: 6,
        paddingLeft: 4,
      },
      right: {
        display: "flex",
        alignItems: "center",
        gap: 6,
      },
      btn: {
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        width: 32,
        height: 32,
        borderRadius: 8,
        border: `1px solid ${border}`,
        background: "transparent",
        color: fg,
        cursor: "pointer",
      },
      btnDisabled: {
        opacity: 0.5,
        cursor: "not-allowed",
      },
      counter: {
        fontSize: 12,
        opacity: nearLimit ? 0.9 : 0.5,
        color: nearLimit ? "color-mix(in srgb, var(--foreground, #e6e6e6) 80%, red 20%)" : fg,
        marginRight: 4,
      },
    };
  }, [nearLimit]);

  const wrapRef = useRef<HTMLDivElement | null>(null);

useLayoutEffect(() => {
  if (!wrapRef.current || !onHeightChange) return;
  const el = wrapRef.current;
  const ro = new ResizeObserver(() => onHeightChange(el.offsetHeight));
  ro.observe(el);
  onHeightChange(el.offsetHeight); // initial mätning
  return () => ro.disconnect();
}, [onHeightChange]);


  return (
    <div ref={wrapRef} style={styles.wrap} aria-live="polite" aria-atomic>
      <div style={styles.inner}>
        <form ref={formRef} onSubmit={onSubmit} role="form" aria-label="Chat input">
          <div style={styles.shell}>
            <label className="sr-only" htmlFor="chatgpt-like-textarea">Meddelande</label>
            <textarea
              id="chatgpt-like-textarea"
              ref={textareaRef}
              value={value}
              onChange={handleChange}
              onKeyDown={onKeyDown}
              onCompositionStart={onCompositionStart}
              onCompositionEnd={onCompositionEnd}
              placeholder={placeholder}
              disabled={disabled}
              rows={1}
              spellCheck
              autoCorrect="on"
              autoCapitalize="on"
              autoComplete="on"
              style={styles.textarea}
            />
            <div style={styles.right}>
              {/* Teckenräknare nära gränsen */}
              <div style={styles.counter} aria-live="off">
                {maxChars > 0 ? `${charCount}/${maxChars}` : ""}
              </div>
              {/* Stop eller Send beroende på busy */}
              {busy ? (
                <button
                  type="button"
                  aria-label="Stop generating"
                  title="Stop"
                  onClick={handleStop}
                  style={styles.btn}
                >
                  <StopIcon />
                </button>
              ) : (
                <button
                  type="submit"
                  aria-label="Send message"
                  title="Send"
                  disabled={!canSend}
                  style={{ ...styles.btn, ...(canSend ? null : styles.btnDisabled) }}
                >
                  <SendIcon />
                </button>
              )}
            </div>
          </div>

          {/* Hjälptext i samma stil som ChatGPT */}
          <div style={styles.hint} aria-hidden="true">
            Shift+Enter för radbrytning • Enter för att skicka
          </div>
        </form>
      </div>
    </div>
  );
}

// ───────────────────────────────────────────────
// Ikoner (inlined SVG – inga beroenden)
// ───────────────────────────────────────────────
function SendIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="18"
      height="18"
      aria-hidden="true"
      focusable="false"
      style={{ display: "block" }}
    >
      <path
        d="M3.4 20.6l17.9-8.6c.8-.4.8-1.5 0-1.9L3.4 1.4c-.8-.4-1.7.4-1.5 1.2l2.3 7.9c.1.3.3.5.6.6l7.8 1.9-7.8 1.9c-.3.1-.5.3-.6.6l-2.3 7.9c-.2.8.7 1.6 1.5 1.2z"
        fill="currentColor"
      />
    </svg>
  );
}

function StopIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="18"
      height="18"
      aria-hidden="true"
      focusable="false"
      style={{ display: "block" }}
    >
      <rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" />
    </svg>
  );
}

// ───────────────────────────────────────────────
// Hjälpfunktioner
// ───────────────────────────────────────────────
function getLineHeight(el: HTMLElement): number {
  const cs = window.getComputedStyle(el);
  const lh = cs.lineHeight;
  if (lh.endsWith("px")) return parseFloat(lh);
  // fallback: approx med font-size * 1.4
  const fs = parseFloat(cs.fontSize || "15");
  return Math.round(fs * 1.4);
}

function getVerticalPadding(el: HTMLElement): number {
  const cs = window.getComputedStyle(el);
  const pt = parseFloat(cs.paddingTop || "0");
  const pb = parseFloat(cs.paddingBottom || "0");
  const bt = parseFloat(cs.borderTopWidth || "0");
  const bb = parseFloat(cs.borderBottomWidth || "0");
  return pt + pb + bt + bb;
}

function placeCaretAtEnd(el: HTMLTextAreaElement) {
  const len = el.value.length;
  try {
    el.setSelectionRange(len, len);
  } catch {}
}
