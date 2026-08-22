const { app, BrowserWindow, net, protocol, session, shell } = require("electron");
const fs = require("fs");
const path = require("path");
const { pathToFileURL } = require("url");

app.setName("MathMargin");

protocol.registerSchemesAsPrivileged([{
  scheme: "mathmargin",
  privileges: {
    standard: true,
    secure: true,
    supportFetchAPI: true,
    corsEnabled: true,
  },
}]);

const smokeArgument = process.argv.find((argument) => argument.startsWith("--smoke-test="));
const smokePdfPath = smokeArgument ? smokeArgument.slice("--smoke-test=".length) : "";

function registerAppProtocol(targetProtocol) {
  const appRoot = path.resolve(__dirname, "..", "desktop-dist");
  targetProtocol.handle("mathmargin", (request) => {
    const url = new URL(request.url);
    const requestedPath = decodeURIComponent(url.pathname).replace(/^\/+/, "") || "index.html";
    const filePath = path.resolve(appRoot, requestedPath);
    const relativePath = path.relative(appRoot, filePath);
    if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
      return new Response("Not found", { status: 404 });
    }
    return net.fetch(pathToFileURL(filePath).toString());
  });
}

async function runUploadSmokeTest(window) {
  const encodedPdf = fs.readFileSync(smokePdfPath).toString("base64");
  const result = await window.webContents.executeJavaScript(`(async () => {
    const encoded = ${JSON.stringify(encodedPdf)};
    const bytes = Uint8Array.from(atob(encoded), character => character.charCodeAt(0));
    const input = document.querySelector('input[type="file"]');
    if (!input) return { ok: false, error: "The upload input was not rendered." };
    const smokeCards = () => [...document.querySelectorAll(".book-card")].filter(card => card.textContent?.includes("mathmargin-smoke"));
    const initialSmokeCount = smokeCards().length;
    const transfer = new DataTransfer();
    transfer.items.add(new File([bytes], "mathmargin-smoke.pdf", { type: "application/pdf" }));
    Object.defineProperty(input, "files", { configurable: true, value: transfer.files });
    input.dispatchEvent(new Event("change", { bubbles: true }));
    const startedAt = Date.now();
    while (Date.now() - startedAt < 15000) {
      const error = document.querySelector(".library-error")?.textContent?.replace("×", "").trim();
      if (error) return { ok: false, error };
      if (smokeCards().length > initialSmokeCount) {
        smokeCards().at(-1)?.querySelector(".open-button")?.click();
        const renderStartedAt = Date.now();
        while (!document.querySelector(".pdf-page-wrap canvas") && Date.now() - renderStartedAt < 10000) {
          const readerError = document.querySelector(".reader-toast")?.textContent?.replace("×", "").trim();
          if (readerError) return { ok: false, uploaded: true, error: readerError };
          await new Promise(resolve => setTimeout(resolve, 100));
        }
        if (!document.querySelector(".pdf-page-wrap canvas")) {
          return { ok: false, uploaded: true, error: "The saved PDF did not render within 10 seconds." };
        }
        const pdfStage = document.querySelector(".pdf-stage");
        const pageBounds = document.querySelector(".pdf-page-wrap")?.getBoundingClientRect();
        const zoomBefore = document.querySelector(".zoom-controls span")?.textContent;
        if (!pdfStage || !pageBounds || !zoomBefore) return { ok: false, uploaded: true, rendered: true, error: "The zoom controls were not rendered." };
        pdfStage.dispatchEvent(new WheelEvent("wheel", { bubbles: true, cancelable: true, ctrlKey: true, deltaY: -100, clientX: pageBounds.left + pageBounds.width / 2, clientY: pageBounds.top + pageBounds.height / 2 }));
        const zoomStartedAt = Date.now();
        while (document.querySelector(".zoom-controls span")?.textContent === zoomBefore && Date.now() - zoomStartedAt < 3000) {
          await new Promise(resolve => setTimeout(resolve, 100));
        }
        if (document.querySelector(".zoom-controls span")?.textContent === zoomBefore) return { ok: false, uploaded: true, rendered: true, error: "Ctrl+wheel did not change the PDF zoom." };
        let textSpan = document.querySelector(".react-pdf__Page__textContent span");
        const textLayerStartedAt = Date.now();
        while (!textSpan && Date.now() - textLayerStartedAt < 5000) {
          await new Promise(resolve => setTimeout(resolve, 100));
          textSpan = document.querySelector(".react-pdf__Page__textContent span");
        }
        if (!textSpan) return { ok: false, uploaded: true, rendered: true, error: "The PDF text layer was not rendered." };
        const range = document.createRange();
        range.selectNodeContents(textSpan);
        const selection = getSelection();
        selection?.removeAllRanges();
        selection?.addRange(range);
        document.querySelector(".pdf-page-wrap")?.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
        const editorStartedAt = Date.now();
        while (!document.querySelector(".live-note-editor")?.mathMarginEditorView && Date.now() - editorStartedAt < 5000) {
          await new Promise(resolve => setTimeout(resolve, 100));
        }
        const editorHost = document.querySelector(".live-note-editor");
        const editorView = editorHost?.mathMarginEditorView;
        const editor = editorView?.contentDOM;
        if (!editorView || !editor) return { ok: false, uploaded: true, rendered: true, error: "The live note editor could not be created." };
        const selectedHighlight = document.querySelector(".annotation-mark.text.selected");
        const selectedHighlightStyle = selectedHighlight ? getComputedStyle(selectedHighlight) : null;
        if (!selectedHighlightStyle || selectedHighlightStyle.outlineStyle !== "none" || parseFloat(selectedHighlightStyle.borderTopWidth) > 0 || parseFloat(selectedHighlightStyle.borderRightWidth) > 0 || parseFloat(selectedHighlightStyle.borderBottomWidth) > 0 || parseFloat(selectedHighlightStyle.borderLeftWidth) > 0) {
          return { ok: false, uploaded: true, rendered: true, error: "Selected text highlights still displayed dark border lines." };
        }
        const setEditorValue = (value, position = value.length) => editorView.dispatch({ changes: { from: 0, to: editorView.state.doc.length, insert: value }, selection: { anchor: position }, scrollIntoView: true });
        const editorValue = () => editorView.state.doc.toString();
        setEditorValue("m");
        await new Promise(resolve => setTimeout(resolve, 100));
        editor.dispatchEvent(new KeyboardEvent("keydown", { key: "k", bubbles: true, cancelable: true }));
        await new Promise(resolve => setTimeout(resolve, 100));
        if (editorValue() !== "$$") return { ok: false, uploaded: true, rendered: true, error: "The mk shortcut produced " + JSON.stringify(editorValue()) + "." };
        setEditorValue("$@$", 2);
        await new Promise(resolve => setTimeout(resolve, 100));
        editor.dispatchEvent(new KeyboardEvent("keydown", { key: "a", bubbles: true, cancelable: true }));
        await new Promise(resolve => setTimeout(resolve, 100));
        if (editorValue() !== "$\\\\alpha$") return { ok: false, uploaded: true, rendered: true, error: "The @a shortcut produced " + JSON.stringify(editorValue()) + "." };
        setEditorValue("Before $$x^2$$ after");
        const displayMathStartedAt = Date.now();
        while (!document.querySelector(".live-note-editor .cm-live-math-display .katex-display") && Date.now() - displayMathStartedAt < 3000) {
          await new Promise(resolve => setTimeout(resolve, 100));
        }
        const liveEditorText = editorHost.textContent ?? "";
        if (!document.querySelector(".live-note-editor .cm-live-math-display .katex-display") || !liveEditorText.includes("Before") || !liveEditorText.includes("after") || document.querySelector(".note-preview")) {
          return { ok: false, uploaded: true, rendered: true, shortcuts: true, error: "LaTeX was not rendered directly inside the single live note surface." };
        }
        const resizer = document.querySelector(".notes-resizer");
        const panel = document.querySelector(".notes-panel");
        const readerBody = document.querySelector(".reader-body");
        const storedNotesWidth = localStorage.getItem("mathmargin:notes-width");
        if (!resizer || !panel || !readerBody) return { ok: false, uploaded: true, rendered: true, shortcuts: true, displayMath: true, error: "The annotation panel resize handle was not rendered." };
        readerBody.style.transition = "none";
        resizer.dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true, cancelable: true }));
        await new Promise(resolve => setTimeout(resolve, 350));
        const panelWidthBefore = panel.getBoundingClientRect().width;
        const fontSizeBefore = parseFloat(getComputedStyle(editor).fontSize);
        resizer.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", shiftKey: true, bubbles: true, cancelable: true }));
        await new Promise(resolve => setTimeout(resolve, 350));
        const panelWidthAfter = panel.getBoundingClientRect().width;
        const fontSizeAfter = parseFloat(getComputedStyle(editor).fontSize);
        readerBody.style.removeProperty("transition");
        if (storedNotesWidth === null) localStorage.removeItem("mathmargin:notes-width"); else localStorage.setItem("mathmargin:notes-width", storedNotesWidth);
        if (panelWidthAfter <= panelWidthBefore || panelWidthAfter > innerWidth / 2 + 1 || fontSizeAfter <= fontSizeBefore) {
          return { ok: false, uploaded: true, rendered: true, shortcuts: true, displayMath: true, error: "The annotation panel resize check failed (" + panelWidthBefore + "px to " + panelWidthAfter + "px; " + fontSizeBefore + "px to " + fontSizeAfter + "px; limit " + innerWidth / 2 + "px; inline " + readerBody?.style.gridTemplateColumns + "; computed " + (readerBody ? getComputedStyle(readerBody).gridTemplateColumns : "missing") + ")." };
        }
        const longNote = Array.from({ length: 36 }, (_, index) => "Paragraph " + (index + 1) + ": $x_{" + (index + 1) + "}^2$").join("\\n\\n");
        editorView.focus();
        setEditorValue(longNote);
        await new Promise(resolve => setTimeout(resolve, 200));
        const editorScroller = document.querySelector(".live-note-editor .cm-scroller");
        if (!editorScroller) return { ok: false, uploaded: true, rendered: true, shortcuts: true, displayMath: true, resizablePanel: true, error: "The live note scroller was unavailable." };
        const editorBottomGap = editorScroller.scrollHeight - editorScroller.clientHeight - editorScroller.scrollTop;
        if (editorScroller.scrollHeight <= editorScroller.clientHeight || editorScroller.scrollTop <= 0 || editorBottomGap > 4) {
          return { ok: false, uploaded: true, rendered: true, shortcuts: true, displayMath: true, resizablePanel: true, error: "The live note editor did not follow the caret as the note grew (bottom gap " + editorBottomGap + "px)." };
        }
        const calloutButton = document.querySelector(".insert-callout-button");
        if (!calloutButton) return { ok: false, uploaded: true, rendered: true, shortcuts: true, displayMath: true, resizablePanel: true, liveNoteEditor: true, error: "The callout shortcut button was not rendered." };
        calloutButton.click();
        const calloutStartedAt = Date.now();
        while (!document.querySelector('.live-note-editor .cm-callout[data-callout="note"]') && Date.now() - calloutStartedAt < 3000) {
          await new Promise(resolve => setTimeout(resolve, 100));
        }
        const renderedCallout = document.querySelector('.live-note-editor .cm-callout[data-callout="note"]');
        if (!editorValue().includes("> [!note] Note") || !renderedCallout || !document.querySelector(".cm-callout-marker") || renderedCallout.textContent?.includes("[!note]") || parseFloat(getComputedStyle(renderedCallout).borderLeftWidth) < 3) {
          return { ok: false, uploaded: true, rendered: true, shortcuts: true, displayMath: true, resizablePanel: true, liveNoteEditor: true, error: "The callout shortcut did not render inside the live note editor." };
        }
        document.querySelector(".back-to-notes")?.click();
        const structureStartedAt = Date.now();
        while (!document.querySelector(".annotation-chapter-heading") && Date.now() - structureStartedAt < 10000) {
          await new Promise(resolve => setTimeout(resolve, 100));
        }
        if (!document.querySelector(".annotation-chapter-heading") || !document.querySelector(".annotation-section-heading") || !document.querySelector(".notes-list .note-card")) {
          return { ok: false, uploaded: true, rendered: true, shortcuts: true, displayMath: true, resizablePanel: true, liveNoteEditor: true, error: "All annotations were not grouped into a chapter and section." };
        }
        const emptySectionCounts = [...document.querySelectorAll(".annotation-section-heading small")].filter(element => element.textContent?.trim() === "0 notes");
        if (!emptySectionCounts.length || !document.querySelector(".empty-section-notes")) {
          return { ok: false, uploaded: true, rendered: true, shortcuts: true, displayMath: true, resizablePanel: true, liveNoteEditor: true, chapterGrouping: true, error: "Detected sections without annotations were hidden from All annotations." };
        }
        const detectedChapterTitle = document.querySelector(".annotation-chapter-heading strong")?.textContent?.trim();
        const detectedSectionTitle = document.querySelector(".annotation-section-heading > span")?.textContent?.trim();
        if (!detectedChapterTitle?.startsWith("Chapter 1 ·") || !detectedSectionTitle?.startsWith("Section 1.1 ·")) {
          return { ok: false, uploaded: true, rendered: true, shortcuts: true, displayMath: true, resizablePanel: true, liveNoteEditor: true, chapterGrouping: true, emptySectionsVisible: true, error: "Chapter and section numbers were not shown explicitly." };
        }
        const chapterHeading = document.querySelector("button.annotation-chapter-heading");
        const sectionHeading = document.querySelector("button.annotation-section-heading");
        const pageInput = document.querySelector(".page-controls input");
        if (!chapterHeading?.dataset.pageNumber || !sectionHeading?.dataset.pageNumber || !pageInput) {
          return { ok: false, uploaded: true, rendered: true, chapterGrouping: true, error: "Chapter and section headings were not page-navigation controls." };
        }
        chapterHeading.click();
        await new Promise(resolve => setTimeout(resolve, 100));
        if (pageInput.value !== chapterHeading.dataset.pageNumber) return { ok: false, uploaded: true, rendered: true, chapterGrouping: true, error: "Clicking a chapter heading did not jump to its page." };
        sectionHeading.click();
        await new Promise(resolve => setTimeout(resolve, 100));
        if (pageInput.value !== sectionHeading.dataset.pageNumber) return { ok: false, uploaded: true, rendered: true, chapterGrouping: true, error: "Clicking a section heading did not jump to its page." };
        const areaTool = [...document.querySelectorAll(".tool-group button")].find(button => button.textContent?.includes("Area"));
        areaTool?.click();
        await new Promise(resolve => setTimeout(resolve, 100));
        const interaction = document.querySelector(".area-interaction");
        const interactionBounds = interaction?.getBoundingClientRect();
        if (!interaction || !interactionBounds) return { ok: false, uploaded: true, rendered: true, error: "The area drawing tool was not available." };
        const areaStart = { x: interactionBounds.left + interactionBounds.width * .2, y: interactionBounds.top + interactionBounds.height * .2 };
        const areaEnd = { x: interactionBounds.left + interactionBounds.width * .4, y: interactionBounds.top + interactionBounds.height * .38 };
        interaction.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, pointerId: 17, pointerType: "mouse", buttons: 1, clientX: areaStart.x, clientY: areaStart.y }));
        interaction.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, cancelable: true, pointerId: 17, pointerType: "mouse", buttons: 1, clientX: areaEnd.x, clientY: areaEnd.y }));
        interaction.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, cancelable: true, pointerId: 17, pointerType: "mouse", buttons: 0, clientX: areaEnd.x, clientY: areaEnd.y }));
        await new Promise(resolve => setTimeout(resolve, 150));
        const annotateArea = [...document.querySelectorAll(".draft-actions button")].find(button => button.textContent?.includes("Annotate area"));
        if (!annotateArea) return { ok: false, uploaded: true, rendered: true, error: "A valid area selection did not show its save action." };
        annotateArea.click();
        const savedAreaStartedAt = Date.now();
        while ((!document.querySelector(".annotation-mark.area") || !document.querySelector(".area-resize-handle.se")) && Date.now() - savedAreaStartedAt < 5000) {
          await new Promise(resolve => setTimeout(resolve, 100));
        }
        const savedArea = document.querySelector(".annotation-mark.area");
        const southeastHandle = document.querySelector(".area-resize-handle.se");
        if (!savedArea || !southeastHandle) return { ok: false, uploaded: true, rendered: true, error: "A saved area did not expose resize handles when selected." };
        const areaWidthBefore = savedArea.getBoundingClientRect().width;
        southeastHandle.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", shiftKey: true, bubbles: true, cancelable: true }));
        await new Promise(resolve => setTimeout(resolve, 200));
        const areaWidthAfter = document.querySelector(".annotation-mark.area")?.getBoundingClientRect().width ?? 0;
        if (areaWidthAfter <= areaWidthBefore) return { ok: false, uploaded: true, rendered: true, error: "The saved area did not resize (" + areaWidthBefore + "px to " + areaWidthAfter + "px)." };
        document.querySelector(".notes-header > button")?.click();
        await new Promise(resolve => setTimeout(resolve, 400));
        const mark = document.querySelector(".annotation-mark.area");
        const markBounds = mark?.getBoundingClientRect();
        if (!markBounds || !document.querySelector(".area-interaction")) return { ok: false, uploaded: true, rendered: true, error: "The annotation overlay click test could not start." };
        const hitTarget = document.elementFromPoint(markBounds.left + markBounds.width / 2, markBounds.top + markBounds.height / 2);
        if (!hitTarget?.closest(".annotation-mark")) return { ok: false, uploaded: true, rendered: true, error: "The Area drawing layer covered the saved annotation." };
        hitTarget.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
        await new Promise(resolve => setTimeout(resolve, 200));
        if (!document.querySelector(".reader-shell")?.classList.contains("sidebar-is-open")) return { ok: false, uploaded: true, rendered: true, error: "Clicking the saved annotation did not open the sidebar." };
        if (!document.querySelector(".area-resize-handle")) return { ok: false, uploaded: true, rendered: true, error: "Reselecting a saved area did not restore its resize handles." };
        location.hash = "";
        const libraryStartedAt = Date.now();
        while (!document.querySelector(".desktop-library") && Date.now() - libraryStartedAt < 5000) {
          await new Promise(resolve => setTimeout(resolve, 100));
        }
        window.confirm = () => true;
        for (const card of smokeCards()) {
          const buttons = [...card.querySelectorAll("button")];
          buttons.find(button => button.textContent?.trim() === "Delete")?.click();
        }
        const cleanupStartedAt = Date.now();
        while (smokeCards().length && Date.now() - cleanupStartedAt < 5000) {
          await new Promise(resolve => setTimeout(resolve, 100));
        }
        return { ok: smokeCards().length === 0, uploaded: true, reopened: true, rendered: true, zoomed: true, borderlessHighlights: true, shortcuts: true, inlineLatex: true, displayMath: true, resizablePanel: true, liveNoteEditor: true, autoScrollingEditor: true, obsidianCallouts: true, chapterGrouping: true, structureNavigation: true, emptySectionsVisible: true, detectedChapterTitle, detectedSectionTitle, areaResized: true, annotationClicked: true, cleanedUp: smokeCards().length === 0 };
      }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    return { ok: false, error: "The upload did not finish within 15 seconds." };
  })()`);
  fs.writeFileSync(path.join(app.getPath("temp"), "mathmargin-smoke-result.json"), JSON.stringify(result, null, 2));
  process.stdout.write(`MATHMARGIN_SMOKE:${JSON.stringify(result)}\n`);
  app.exit(result.ok ? 0 : 1);
}

function createWindow() {
  const window = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 720,
    minHeight: 520,
    backgroundColor: "#f8f7f2",
    show: !smokePdfPath,
    autoHideMenuBar: true,
    title: "MathMargin",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      partition: "persist:mathmargin-v2",
      sandbox: true,
      webSecurity: true,
    },
  });

  window.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//i.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });
  window.webContents.on("will-navigate", (event, url) => {
    if (!url.startsWith("mathmargin://app/")) event.preventDefault();
  });
  if (!smokePdfPath) window.once("ready-to-show", () => window.show());
  else window.webContents.once("did-finish-load", () => {
    runUploadSmokeTest(window).catch((error) => {
      process.stderr.write(`MATHMARGIN_SMOKE_ERROR:${error instanceof Error ? error.stack : String(error)}\n`);
      app.exit(1);
    });
  });
  window.loadURL("mathmargin://app/index.html");
}

app.whenReady().then(() => {
  registerAppProtocol(session.fromPartition("persist:mathmargin-v2").protocol);
  createWindow();
  app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
