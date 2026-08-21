import { LATEX_SUITE_RULES, LATEX_SUITE_SETTINGS, type LatexSuiteRule } from "./latexSuiteRules";

export type LatexTabStop = { index: number; start: number; end: number };
export type LatexTabState = { stops: LatexTabStop[]; currentIndex: number } | null;

export type LatexEditorOperation = {
  value: string;
  selectionStart: number;
  selectionEnd: number;
  tabState: LatexTabState;
  reason: "snippet" | "tabstop" | "autofraction" | "matrix" | "tabout" | "paired-delete";
};

type MathContext = {
  inMath: boolean;
  inline: boolean;
  display: boolean;
  textEnvironment: boolean;
  equationStart: number;
  equationEnd: number;
};

type Match = { start: number; end: number; captures: string[] };

const regexCache = new Map<string, RegExp>();
const WORD_DELIMITERS = LATEX_SUITE_SETTINGS.wordDelimiters.replace("\\n", "\n");

function isEscaped(value: string, index: number) {
  let slashes = 0;
  for (let cursor = index - 1; cursor >= 0 && value[cursor] === "\\"; cursor--) slashes++;
  return slashes % 2 === 1;
}

function findEquationEnd(value: string, start: number, display: boolean) {
  for (let index = start; index < value.length; index++) {
    if (value[index] !== "$" || isEscaped(value, index)) continue;
    if (display) {
      if (value[index + 1] === "$") return index;
    } else if (value[index + 1] !== "$" && value[index - 1] !== "$") return index;
  }
  return value.length;
}

function inTextEnvironment(value: string, start: number, end: number) {
  const stack: boolean[] = [];
  for (let index = start; index < end; index++) {
    if (value.startsWith("\\text{", index)) {
      stack.push(true);
      index += 5;
    } else if (value[index] === "{" && !isEscaped(value, index)) {
      stack.push(stack.at(-1) ?? false);
    } else if (value[index] === "}" && !isEscaped(value, index)) {
      stack.pop();
    }
  }
  return stack.includes(true);
}

function mathContext(value: string, position: number): MathContext {
  let inline = false;
  let display = false;
  let equationStart = 0;
  for (let index = 0; index < position; index++) {
    if (value[index] !== "$" || isEscaped(value, index)) continue;
    if (value[index + 1] === "$") {
      if (!inline) {
        display = !display;
        equationStart = display ? index + 2 : 0;
      }
      index++;
    } else if (!display) {
      inline = !inline;
      equationStart = inline ? index + 1 : 0;
    }
  }
  const inMath = inline || display;
  return {
    inMath,
    inline,
    display,
    textEnvironment: inMath && inTextEnvironment(value, equationStart, position),
    equationStart,
    equationEnd: inMath ? findEquationEnd(value, position, display) : position,
  };
}

function ruleRunsInContext(rule: LatexSuiteRule, context: MathContext) {
  const hasMode = /[mnMtc]/.test(rule.options);
  if (!hasMode) return true;
  if (rule.options.includes("t") && (!context.inMath || context.textEnvironment)) return true;
  if (context.textEnvironment) return false;
  if (rule.options.includes("m") && context.inMath) return true;
  if (rule.options.includes("n") && context.inline) return true;
  if (rule.options.includes("M") && context.display) return true;
  return false;
}

function isVisual(rule: LatexSuiteRule) {
  return rule.options.includes("v") || rule.replacement?.includes("${VISUAL}");
}

function matchRule(rule: LatexSuiteRule, beforeCaret: string): Match | null {
  if (!rule.regex) {
    if (!beforeCaret.endsWith(rule.trigger)) return null;
    return { start: beforeCaret.length - rule.trigger.length, end: beforeCaret.length, captures: [] };
  }
  const key = `${rule.trigger}/${rule.flags}`;
  let regex = regexCache.get(key);
  if (!regex) {
    regex = new RegExp(`${rule.trigger}$`, rule.flags);
    regexCache.set(key, regex);
  }
  const result = regex.exec(beforeCaret);
  return result ? { start: result.index, end: beforeCaret.length, captures: result.slice(1).map((value) => value ?? "") } : null;
}

function isWordBoundary(value: string, start: number, end: number) {
  const previous = value[start - 1] ?? "";
  const next = value[end] ?? "";
  return (!previous || WORD_DELIMITERS.includes(previous)) && (!next || WORD_DELIMITERS.includes(next));
}

function identityMatrix(captures: string[]) {
  const size = Math.max(1, Math.min(20, Number.parseInt(captures[0] || "1", 10)));
  const rows = Array.from({ length: size }, (_, row) => Array.from({ length: size }, (_, column) => row === column ? "1" : "0").join(" & "));
  return `\\begin{pmatrix}\n${rows.join(" \\\\\n")}\n\\end{pmatrix}`;
}

function fillCaptures(replacement: string, captures: string[]) {
  return captures.reduce((value, capture, index) => value.replaceAll(`[[${index}]]`, capture), replacement);
}

function renderPlaceholders(replacement: string) {
  const matcher = /\$\{(\d+)(?::((?:\\.|[^}])*)?)?\}|\$(\d+)/g;
  const defaults = new Map<number, string>();
  const stops: LatexTabStop[] = [];
  let text = "";
  let cursor = 0;
  for (const match of replacement.matchAll(matcher)) {
    const offset = match.index ?? 0;
    text += replacement.slice(cursor, offset);
    const index = Number.parseInt(match[1] ?? match[3], 10);
    const explicitDefault = match[2];
    const placeholder = explicitDefault ?? defaults.get(index) ?? "";
    if (!defaults.has(index)) defaults.set(index, placeholder);
    const start = text.length;
    text += placeholder;
    stops.push({ index, start, end: text.length });
    cursor = offset + match[0].length;
  }
  text += replacement.slice(cursor);
  return { text, stops };
}

function operationFromReplacement(
  value: string,
  start: number,
  end: number,
  replacement: string,
  reason: LatexEditorOperation["reason"],
) {
  const rendered = renderPlaceholders(replacement);
  const nextValue = value.slice(0, start) + rendered.text + value.slice(end);
  const absoluteStops = rendered.stops.map((stop) => ({ ...stop, start: stop.start + start, end: stop.end + start }));
  const uniqueStops = [...new Map(absoluteStops.map((stop) => [stop.index, stop])).values()].sort((a, b) => a.index - b.index);
  const first = uniqueStops[0];
  return {
    value: nextValue,
    selectionStart: first?.start ?? start + rendered.text.length,
    selectionEnd: first?.end ?? start + rendered.text.length,
    tabState: first ? { stops: uniqueStops, currentIndex: first.index } : null,
    reason,
  } satisfies LatexEditorOperation;
}

function snippetOperation(
  value: string,
  caret: number,
  context: MathContext,
  automatic: boolean,
  selectedText = "",
) {
  const hasSelection = selectedText.length > 0;
  const beforeCaret = value.slice(0, caret);
  for (const rule of LATEX_SUITE_RULES) {
    const visual = isVisual(rule);
    if (visual ? !automatic || !hasSelection : rule.options.includes("A") !== automatic || hasSelection) continue;
    if (!ruleRunsInContext(rule, context)) continue;
    const match = matchRule(rule, beforeCaret);
    if (!match) continue;
    if (rule.options.includes("w") && !isWordBoundary(value, match.start, match.end)) continue;
    let replacement = rule.dynamic === "identityMatrix" ? identityMatrix(match.captures) : fillCaptures(rule.replacement ?? "", match.captures);
    let start = match.start;
    let end = match.end;
    if (visual) {
      replacement = replacement.replace("${VISUAL}", selectedText);
      start = match.start;
      end = match.end;
    }
    return operationFromReplacement(value, start, end, replacement, "snippet");
  }
  return null;
}

function nextTabstop(value: string, state: LatexTabState): LatexEditorOperation | null {
  if (!state) return null;
  const next = state.stops.find((stop) => stop.index > state.currentIndex);
  if (!next) return null;
  return { value, selectionStart: next.start, selectionEnd: next.end, tabState: { ...state, currentIndex: next.index }, reason: "tabstop" };
}

function scanNumeratorStart(value: string, context: MathContext, position: number) {
  let round = 0;
  let square = 0;
  let curly = 0;
  const breaking = ` $([{\n${LATEX_SUITE_SETTINGS.autofractionBreakingChars}`;
  for (let index = position - 1; index >= context.equationStart; index--) {
    const character = value[index];
    if (character === ")") round++;
    else if (character === "]") square++;
    else if (character === "}") curly++;
    else if (character === "(" && round) round--;
    else if (character === "[" && square) square--;
    else if (character === "{" && curly) curly--;
    else if (!round && !square && !curly && breaking.includes(character)) return index + 1;
  }
  return context.equationStart;
}

function autofraction(value: string, selectionStart: number, selectionEnd: number, context: MathContext) {
  if (!context.inMath || context.textEnvironment) return null;
  const start = selectionStart !== selectionEnd ? selectionStart : scanNumeratorStart(value, context, selectionStart);
  if (start === selectionEnd) return null;
  let numerator = value.slice(start, selectionEnd);
  if (numerator.startsWith("(") && numerator.endsWith(")")) numerator = numerator.slice(1, -1);
  return operationFromReplacement(value, start, selectionEnd, `\\frac{${numerator}}{$0}$1`, "autofraction");
}

function activeMatrixEnvironment(value: string, position: number) {
  const before = value.slice(0, position);
  return LATEX_SUITE_SETTINGS.matrixEnvironments.some((environment) =>
    before.lastIndexOf(`\\begin{${environment}}`) > before.lastIndexOf(`\\end{${environment}}`));
}

function insertAtSelection(value: string, start: number, end: number, inserted: string, reason: LatexEditorOperation["reason"]) {
  const caret = start + inserted.length;
  return { value: value.slice(0, start) + inserted + value.slice(end), selectionStart: caret, selectionEnd: caret, tabState: null, reason } satisfies LatexEditorOperation;
}

function matrixOperation(value: string, start: number, end: number, key: string, shift: boolean, context: MathContext) {
  if (!context.inMath || context.textEnvironment || !activeMatrixEnvironment(value, start)) return null;
  if (key === "Tab") return insertAtSelection(value, start, end, " & ", "matrix");
  if (key !== "Enter") return null;
  if (shift && context.inline) return tabout(value, start, context);
  if (shift && context.display) {
    const nextLineEnd = value.indexOf("\n", start + 1);
    const caret = nextLineEnd === -1 ? context.equationEnd : nextLineEnd;
    return { value, selectionStart: caret, selectionEnd: caret, tabState: null, reason: "matrix" } satisfies LatexEditorOperation;
  }
  return insertAtSelection(value, start, end, context.inline ? " \\\\ " : " \\\\\n", "matrix");
}

function tabout(value: string, position: number, context: MathContext): LatexEditorOperation | null {
  if (!context.inMath) return null;
  const rangle = "\\rangle";
  for (let index = position; index < context.equationEnd; index++) {
    if (["}", ")", "]", ">", "|", "$"].includes(value[index])) {
      return { value, selectionStart: index + 1, selectionEnd: index + 1, tabState: null, reason: "tabout" };
    }
    if (value.startsWith(rangle, index)) {
      return { value, selectionStart: index + rangle.length, selectionEnd: index + rangle.length, tabState: null, reason: "tabout" };
    }
  }
  if (value.slice(position, context.equationEnd).trim()) return null;
  const delimiterLength = context.display ? 2 : 1;
  const caret = Math.min(value.length, context.equationEnd + delimiterLength);
  return { value, selectionStart: caret, selectionEnd: caret, tabState: null, reason: "tabout" };
}

function prospectiveValue(value: string, start: number, end: number, key: string) {
  return value.slice(0, start) + key + value.slice(end);
}

export function handleLatexSuiteKey(input: {
  value: string;
  selectionStart: number;
  selectionEnd: number;
  key: string;
  shiftKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  composing: boolean;
  tabState: LatexTabState;
}): LatexEditorOperation | null {
  const { value, selectionStart, selectionEnd, key } = input;
  if (input.composing || input.ctrlKey || input.altKey) return null;
  const context = mathContext(value, selectionStart);

  if (key === "Backspace" && context.inMath && value[selectionStart - 1] === "$" && value[selectionStart] === "$") {
    const nextValue = value.slice(0, selectionStart - 1) + value.slice(selectionStart + 1);
    return { value: nextValue, selectionStart: selectionStart - 1, selectionEnd: selectionStart - 1, tabState: null, reason: "paired-delete" };
  }

  if (key.length === 1) {
    const prospective = prospectiveValue(value, selectionStart, selectionEnd, key);
    const prospectiveCaret = selectionStart + key.length;
    const snippet = snippetOperation(prospective, prospectiveCaret, context, true, value.slice(selectionStart, selectionEnd));
    if (snippet) return snippet;
  }

  if (key === LATEX_SUITE_SETTINGS.triggerKey) {
    const snippet = snippetOperation(value, selectionStart, context, false, value.slice(selectionStart, selectionEnd));
    if (snippet) return snippet;
    const stop = nextTabstop(value, input.tabState);
    if (stop) return stop;
  }

  if (key === "/") {
    const fraction = autofraction(value, selectionStart, selectionEnd, context);
    if (fraction) return fraction;
  }

  if (key === "Tab" || key === "Enter") {
    const matrix = matrixOperation(value, selectionStart, selectionEnd, key, input.shiftKey, context);
    if (matrix) return matrix;
  }

  if (key === "Tab") {
    const moved = tabout(value, selectionStart, context);
    if (moved) return moved;
  }

  if ([")", "]", "}"].includes(key) && value[selectionStart] === key) {
    return tabout(value, selectionStart, context);
  }
  return null;
}

export function reconcileLatexTabState(state: LatexTabState, previous: string, next: string): LatexTabState {
  if (!state || previous === next) return state;
  let prefix = 0;
  while (prefix < previous.length && prefix < next.length && previous[prefix] === next[prefix]) prefix++;
  let oldSuffix = previous.length;
  let newSuffix = next.length;
  while (oldSuffix > prefix && newSuffix > prefix && previous[oldSuffix - 1] === next[newSuffix - 1]) { oldSuffix--; newSuffix--; }
  const delta = (newSuffix - prefix) - (oldSuffix - prefix);
  const stops = state.stops.map((stop) => {
    if (stop.end <= prefix) return stop;
    if (stop.start >= oldSuffix) return { ...stop, start: stop.start + delta, end: stop.end + delta };
    return { ...stop, end: Math.max(stop.start, stop.end + delta) };
  });
  return { ...state, stops };
}

export const LATEX_SUITE_SHORTCUT_COUNT = LATEX_SUITE_RULES.length;
