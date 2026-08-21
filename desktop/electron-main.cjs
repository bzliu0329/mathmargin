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
        const textSpan = document.querySelector(".react-pdf__Page__textContent span");
        if (!textSpan) return { ok: false, uploaded: true, rendered: true, error: "The PDF text layer was not rendered." };
        const range = document.createRange();
        range.selectNodeContents(textSpan);
        const selection = getSelection();
        selection?.removeAllRanges();
        selection?.addRange(range);
        document.querySelector(".pdf-page-wrap")?.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
        const editorStartedAt = Date.now();
        while (!document.querySelector(".note-editor textarea") && Date.now() - editorStartedAt < 5000) {
          await new Promise(resolve => setTimeout(resolve, 100));
        }
        const editor = document.querySelector(".note-editor textarea");
        if (!editor) return { ok: false, uploaded: true, rendered: true, error: "A text annotation could not be created." };
        const valueSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
        valueSetter?.call(editor, "m");
        editor.dispatchEvent(new Event("input", { bubbles: true }));
        await new Promise(resolve => setTimeout(resolve, 100));
        editor.setSelectionRange(1, 1);
        editor.dispatchEvent(new KeyboardEvent("keydown", { key: "k", bubbles: true, cancelable: true }));
        await new Promise(resolve => setTimeout(resolve, 100));
        if (editor.value !== "$$") return { ok: false, uploaded: true, rendered: true, error: "The mk shortcut produced " + JSON.stringify(editor.value) + "." };
        valueSetter?.call(editor, "$@$");
        editor.dispatchEvent(new Event("input", { bubbles: true }));
        await new Promise(resolve => setTimeout(resolve, 100));
        editor.setSelectionRange(2, 2);
        editor.dispatchEvent(new KeyboardEvent("keydown", { key: "a", bubbles: true, cancelable: true }));
        await new Promise(resolve => setTimeout(resolve, 100));
        if (editor.value !== "$\\\\alpha$") return { ok: false, uploaded: true, rendered: true, error: "The @a shortcut produced " + JSON.stringify(editor.value) + "." };
        valueSetter?.call(editor, "Before $$x^2$$ after");
        editor.dispatchEvent(new Event("input", { bubbles: true }));
        const displayMathStartedAt = Date.now();
        while (!document.querySelector(".note-preview .katex-display") && Date.now() - displayMathStartedAt < 3000) {
          await new Promise(resolve => setTimeout(resolve, 100));
        }
        const previewText = document.querySelector(".note-preview")?.textContent ?? "";
        if (!document.querySelector(".note-preview .katex-display") || !previewText.includes("Before") || !previewText.includes("after")) {
          return { ok: false, uploaded: true, rendered: true, shortcuts: true, error: "Double-dollar math did not render as a standalone block between Markdown text." };
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
        valueSetter?.call(editor, longNote);
        editor.dispatchEvent(new Event("input", { bubbles: true }));
        await new Promise(resolve => setTimeout(resolve, 200));
        const preview = document.querySelector(".note-preview");
        if (!preview) return { ok: false, uploaded: true, rendered: true, shortcuts: true, displayMath: true, resizablePanel: true, error: "The rendered preview was not available for its scroll test." };
        preview.scrollTop = preview.scrollHeight;
        if (preview.scrollHeight <= preview.clientHeight || preview.scrollTop <= 0 || getComputedStyle(preview).overflowY !== "auto" || getComputedStyle(preview).resize !== "vertical") {
          return { ok: false, uploaded: true, rendered: true, shortcuts: true, displayMath: true, resizablePanel: true, error: "A long rendered preview was not independently scrollable and vertically resizable." };
        }
        document.querySelector(".back-to-notes")?.click();
        const structureStartedAt = Date.now();
        while (!document.querySelector(".annotation-chapter-heading") && Date.now() - structureStartedAt < 10000) {
          await new Promise(resolve => setTimeout(resolve, 100));
        }
        if (!document.querySelector(".annotation-chapter-heading") || !document.querySelector(".annotation-section-heading") || !document.querySelector(".notes-list .note-card")) {
          return { ok: false, uploaded: true, rendered: true, shortcuts: true, displayMath: true, resizablePanel: true, scrollablePreview: true, error: "All annotations were not grouped into a chapter and section." };
        }
        const detectedChapterTitle = document.querySelector(".annotation-chapter-heading strong")?.textContent?.trim();
        const detectedSectionTitle = document.querySelector(".annotation-section-heading > span")?.textContent?.trim();
        [...document.querySelectorAll(".tool-group button")].find(button => button.textContent?.includes("Area"))?.click();
        document.querySelector(".notes-header > button")?.click();
        await new Promise(resolve => setTimeout(resolve, 400));
        const mark = document.querySelector(".annotation-mark");
        const markBounds = mark?.getBoundingClientRect();
        if (!markBounds || !document.querySelector(".area-interaction")) return { ok: false, uploaded: true, rendered: true, error: "The annotation overlay click test could not start." };
        const hitTarget = document.elementFromPoint(markBounds.left + markBounds.width / 2, markBounds.top + markBounds.height / 2);
        if (!hitTarget?.closest(".annotation-mark")) return { ok: false, uploaded: true, rendered: true, error: "The Area drawing layer covered the saved annotation." };
        hitTarget.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
        await new Promise(resolve => setTimeout(resolve, 200));
        if (!document.querySelector(".reader-shell")?.classList.contains("sidebar-is-open")) return { ok: false, uploaded: true, rendered: true, error: "Clicking the saved annotation did not open the sidebar." };
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
        return { ok: smokeCards().length === 0, uploaded: true, reopened: true, rendered: true, zoomed: true, shortcuts: true, displayMath: true, resizablePanel: true, scrollablePreview: true, chapterGrouping: true, detectedChapterTitle, detectedSectionTitle, annotationClicked: true, cleanedUp: smokeCards().length === 0 };
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
