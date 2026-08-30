import { useEffect, useRef, type MutableRefObject } from "react";
import { EditorState, StateField } from "@codemirror/state";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { defaultHighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { markdown } from "@codemirror/lang-markdown";
import { Decoration, EditorView, keymap, placeholder, showTooltip, ViewPlugin, type DecorationSet, type Tooltip, type ViewUpdate, WidgetType } from "@codemirror/view";
import katex from "katex";
import { handleLatexSuiteKey, type LatexTabState } from "./latexSuite";

type LiveNoteEditorProps = {
  value: string;
  onChange: (value: string) => void;
  viewRef: MutableRefObject<EditorView | null>;
  macros: Record<string, string>;
};

const CALLOUT_TITLES: Record<string, string> = {
  note: "Note", abstract: "Abstract", summary: "Summary", tldr: "Summary", info: "Info", todo: "Todo",
  tip: "Tip", hint: "Hint", important: "Important", success: "Success", check: "Success", done: "Done",
  question: "Question", help: "Help", faq: "FAQ", warning: "Warning", caution: "Caution", attention: "Attention",
  failure: "Failure", fail: "Failure", missing: "Missing", danger: "Danger", error: "Error", bug: "Bug",
  example: "Example", quote: "Quote", cite: "Quote",
};

const CALLOUT_ICONS: Record<string, string> = {
  note: "✎", abstract: "≡", summary: "≡", tldr: "≡", info: "ⓘ", todo: "☑", tip: "⚡", hint: "⚡",
  important: "⚡", success: "✓", check: "✓", done: "✓", question: "?", help: "?", faq: "?", warning: "⚠",
  caution: "⚠", attention: "⚠", failure: "✕", fail: "✕", missing: "✕", danger: "⚡", error: "⚡",
  bug: "⌁", example: "▤", quote: "❝", cite: "❝",
};

function titleForCallout(type: string) {
  return CALLOUT_TITLES[type] || type.replace(/[-_]+/g, " ").replace(/^./, (letter) => letter.toUpperCase());
}

class MathWidget extends WidgetType {
  constructor(readonly source: string, readonly display: boolean, readonly macros: Record<string, string>) { super(); }
  eq(other: MathWidget) { return other.source === this.source && other.display === this.display; }
  toDOM() {
    const node = document.createElement(this.display ? "div" : "span");
    node.className = this.display ? "cm-live-math cm-live-math-display" : "cm-live-math cm-live-math-inline";
    try { katex.render(this.source, node, { displayMode: this.display, throwOnError: true, macros: this.macros }); }
    catch (error) {
      node.classList.add("cm-live-math-error");
      node.textContent = this.display ? `$$${this.source}$$` : `$${this.source}$`;
      node.title = error instanceof Error ? error.message : "Invalid LaTeX";
    }
    return node;
  }
  ignoreEvent() { return false; }
}

class CalloutMarkerWidget extends WidgetType {
  constructor(readonly type: string, readonly showDefaultTitle: boolean, readonly folded: boolean) { super(); }
  eq(other: CalloutMarkerWidget) { return other.type === this.type && other.showDefaultTitle === this.showDefaultTitle && other.folded === this.folded; }
  toDOM() {
    const marker = document.createElement("span");
    marker.className = "cm-callout-marker";
    marker.dataset.callout = this.type;
    marker.textContent = `${CALLOUT_ICONS[this.type] || "✦"}${this.showDefaultTitle ? `  ${titleForCallout(this.type)}` : ""}${this.folded ? "  ›" : ""}`;
    return marker;
  }
  ignoreEvent() { return false; }
}

function selectionTouches(view: EditorView, from: number, to: number) {
  return view.state.selection.ranges.some((range) => range.from <= to && range.to >= from);
}

function selectionEditsMath(state: EditorState, from: number, to: number) {
  return state.selection.ranges.some((range) => range.empty ? range.from > from && range.from < to : range.from < to && range.to > from);
}

type MathRange = { from: number; to: number; source: string; display: boolean };

function mathRanges(source: string) {
  const ranges: MathRange[] = [];
  const displayRanges: MathRange[] = [];
  for (const match of source.matchAll(/(?<!\\)\$\$([\s\S]*?)(?<!\\)\$\$/g)) {
    const from = match.index ?? 0;
    const range = { from, to: from + match[0].length, source: match[1].trim(), display: true };
    displayRanges.push(range); ranges.push(range);
  }
  for (const match of source.matchAll(/(?<![\\$])\$([^\n$]+?)(?<!\\)\$(?!\$)/g)) {
    const from = match.index ?? 0;
    const range = { from, to: from + match[0].length, source: match[1], display: false };
    if (!displayRanges.some((display) => range.from < display.to && range.to > display.from)) ranges.push(range);
  }
  return ranges.sort((left, right) => left.from - right.from);
}

function activeMathRange(state: EditorState) {
  const active = mathRanges(state.doc.toString()).filter((range) => range.source && selectionEditsMath(state, range.from, range.to));
  const head = state.selection.main.head;
  return active.find((range) => head > range.from && head < range.to) ?? active[0] ?? null;
}

function mathEditTooltip(range: MathRange | null, macros: Record<string, string>): Tooltip | null {
  if (!range) return null;
  return {
    pos: range.from,
    end: range.to,
    above: true,
    arrow: true,
    create() {
      const dom = document.createElement("div");
      dom.className = "cm-math-edit-tooltip";
      dom.dataset.mathSource = range.source;
      dom.setAttribute("role", "tooltip");
      dom.setAttribute("aria-label", "Rendered LaTeX preview");
      try { katex.render(range.source, dom, { displayMode: range.display, throwOnError: true, macros }); }
      catch (error) {
        dom.classList.add("cm-math-edit-tooltip-error");
        dom.textContent = "LaTeX preview unavailable";
        dom.title = error instanceof Error ? error.message : "Invalid LaTeX";
      }
      return { dom, offset: { x: 0, y: 7 } };
    },
  };
}

function mathDecorationSet(view: EditorView, macros: Record<string, string>) {
  const ranges: ReturnType<Decoration["range"]>[] = [];
  for (const range of mathRanges(view.state.doc.toString())) {
    if (range.source && !selectionEditsMath(view.state, range.from, range.to)) ranges.push(Decoration.replace({ widget: new MathWidget(range.source, range.display, macros) }).range(range.from, range.to));
  }
  return Decoration.set(ranges, true);
}

function calloutDecorationSet(view: EditorView) {
  const ranges: ReturnType<Decoration["range"]>[] = [];
  let activeType = "";
  let folded = false;
  for (let number = 1; number <= view.state.doc.lines; number++) {
    const line = view.state.doc.line(number);
    const heading = line.text.match(/^(\s*)>\s*\[!([a-z0-9_-]+)\]([+-])?[ \t]*(.*)$/i);
    if (heading) {
      activeType = heading[2].toLowerCase();
      folded = heading[3] === "-";
      ranges.push(Decoration.line({ attributes: { class: `cm-callout cm-callout-${activeType} cm-callout-title-line`, "data-callout": activeType } }).range(line.from));
      if (!selectionTouches(view, line.from, line.to)) {
        const markerLength = heading[0].length - heading[4].length;
        ranges.push(Decoration.replace({ widget: new CalloutMarkerWidget(activeType, !heading[4].trim(), folded) }).range(line.from + heading[1].length, line.from + markerLength));
      }
      continue;
    }
    const quote = line.text.match(/^(\s*)>\s?/);
    if (activeType && quote) {
      ranges.push(Decoration.line({ attributes: { class: `cm-callout cm-callout-${activeType} cm-callout-body-line`, "data-callout": activeType } }).range(line.from));
      if (!selectionTouches(view, line.from, line.to)) ranges.push(Decoration.replace({}).range(line.from + quote[1].length, line.from + quote[0].length));
      continue;
    }
    activeType = "";
    folded = false;
  }
  return Decoration.set(ranges, true);
}

function liveMathPlugin(macros: Record<string, string>) {
  return ViewPlugin.fromClass(class {
    decorations: DecorationSet;
    constructor(view: EditorView) { this.decorations = mathDecorationSet(view, macros); }
    update(update: ViewUpdate) {
      if (update.docChanged || update.selectionSet || update.viewportChanged || update.focusChanged) {
        this.decorations = mathDecorationSet(update.view, macros);
      }
    }
  }, { decorations: (plugin) => plugin.decorations });
}

function liveMathTooltipField(macros: Record<string, string>) {
  return StateField.define<Tooltip | null>({
    create: (state) => mathEditTooltip(activeMathRange(state), macros),
    update: (_value, transaction) => mathEditTooltip(activeMathRange(transaction.state), macros),
    provide: (field) => showTooltip.from(field),
  });
}

const calloutPlugin = ViewPlugin.fromClass(class {
  decorations: DecorationSet;
  constructor(view: EditorView) { this.decorations = calloutDecorationSet(view); }
  update(update: ViewUpdate) { if (update.docChanged || update.selectionSet || update.viewportChanged) this.decorations = calloutDecorationSet(update.view); }
}, { decorations: (plugin) => plugin.decorations });

export function LiveNoteEditor({ value, onChange, viewRef, macros }: LiveNoteEditorProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const onChangeRef = useRef(onChange);
  const tabState = useRef<LatexTabState>(null);
  useEffect(() => { onChangeRef.current = onChange; }, [onChange]);

  useEffect(() => {
    if (!hostRef.current) return;
    let followTimer: ReturnType<typeof setTimeout> | null = null;
    const state = EditorState.create({
      doc: value,
      extensions: [
        history(),
        markdown(),
        syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
        keymap.of([...defaultKeymap, ...historyKeymap]),
        EditorView.lineWrapping,
        placeholder("Write your reasoning… Markdown, LaTeX, and callouts render here as you type."),
        EditorView.contentAttributes.of({ "aria-label": "Annotation note — Markdown and LaTeX live editor", spellcheck: "true" }),
        EditorView.updateListener.of((update) => {
          if (!update.docChanged) return;
          onChangeRef.current(update.state.doc.toString());
          if (update.state.selection.main.head === update.state.doc.length) {
            update.view.requestMeasure({
              read: (view) => view.scrollDOM.scrollHeight,
              write: (height, view) => { view.scrollDOM.scrollTop = height; },
            });
            if (followTimer) clearTimeout(followTimer);
            followTimer = setTimeout(() => {
              if (update.view.state.selection.main.head === update.view.state.doc.length) update.view.scrollDOM.scrollTop = update.view.scrollDOM.scrollHeight;
            }, 120);
          }
        }),
        EditorView.domEventHandlers({
          keydown(event, view) {
            const selection = view.state.selection.main;
            const operation = handleLatexSuiteKey({
              value: view.state.doc.toString(), selectionStart: selection.from, selectionEnd: selection.to,
              key: event.key, shiftKey: event.shiftKey, ctrlKey: event.ctrlKey || event.metaKey,
              altKey: event.altKey, composing: event.isComposing, tabState: tabState.current,
            });
            if (!operation) return false;
            event.preventDefault();
            tabState.current = operation.tabState;
            view.dispatch({
              changes: { from: 0, to: view.state.doc.length, insert: operation.value },
              selection: { anchor: operation.selectionStart, head: operation.selectionEnd },
              scrollIntoView: true,
            });
            return true;
          },
        }),
        liveMathPlugin(macros),
        liveMathTooltipField(macros),
        calloutPlugin,
      ],
    });
    const view = new EditorView({ state, parent: hostRef.current });
    viewRef.current = view;
    (hostRef.current as HTMLDivElement & { mathMarginEditorView?: EditorView }).mathMarginEditorView = view;
    return () => { if (followTimer) clearTimeout(followTimer); viewRef.current = null; view.destroy(); };
  }, []);

  return <div ref={hostRef} className="live-note-editor" />;
}
