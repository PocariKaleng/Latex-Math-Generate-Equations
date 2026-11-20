"use strict";

const COPY_SCALE = 2;
const DOWNLOAD_SCALE = 4;
// Export scales are relative to a 14px equation, so enlarging the on-screen preview
// does not change the pixel size of copied or downloaded PNGs.
const EXPORT_BASE_FONT_PX = 14;
const DEBOUNCE_MS = 150;
const SVG_NS = "http://www.w3.org/2000/svg";

const presets = {
  "rsa-encryption": String.raw`c \equiv m^e \pmod n`,
  "rsa-decryption": String.raw`m \equiv c^d \pmod n`,
  "euler-totient": String.raw`\phi(n) = (p-1)(q-1)`,
  "ecdsa-signature": String.raw`s \equiv k^{-1}(H(m) + dr) \pmod n`,
  "elliptic-curve": String.raw`y^2 \equiv x^3 + ax + b \pmod p`,
  "modular-inverse": String.raw`a^{-1}a \equiv 1 \pmod n`,
  polynomial: String.raw`f(x) = \sum_{i=0}^{n} a_i x^i`,
  matrix: String.raw`\begin{bmatrix}
a & b \\
c & d
\end{bmatrix}`
};

function wrapEquation(latex, display) {
  const delimiter = display ? "$$" : "$";
  return `${delimiter}${latex}${delimiter}`;
}

function readMathEnvironment(source, start = 0) {
  const opening = /^\\begin\{(aligned|alignedat|gathered|split|align\*?|gather\*?|equation\*?|[bpBvV]?matrix|cases)\}/.exec(source.slice(start));
  if (!opening) return null;
  const stack = [opening[1]];
  const tokens = /\\(begin|end)\{([^}]+)\}/g;
  tokens.lastIndex = start + opening[0].length;
  let token;
  while ((token = tokens.exec(source))) {
    if (token[1] === "begin") stack.push(token[2]);
    else {
      const expected = stack.pop();
      if (token[2] !== expected) {
        throw new Error("Mismatched LaTeX environment. Expected \\end{" + expected + "}.");
      }
      if (!stack.length) return { latex: source.slice(start, tokens.lastIndex), end: tokens.lastIndex };
    }
  }
  throw new Error("Incomplete LaTeX environment. Add \\end{" + stack[stack.length - 1] + "}.");
}

function parseEquationSource(source) {
  const value = source.trim();
  const environment = readMathEnvironment(value);
  if (environment && environment.end === value.length) {
    return { latex: environment.latex, display: true };
  }
  const delimiter = value.startsWith("$$") ? "$$" : value.startsWith("$") ? "$" : null;
  if (!delimiter || !value.endsWith(delimiter) ||
      (delimiter === "$" && value.endsWith("$$"))) {
    throw new Error("Wrap the equation in $$...$$ for Display or $...$ for Inline.");
  }

  const latex = value.slice(delimiter.length, -delimiter.length).trim();
  if (!latex) throw new Error("Enter an equation between the dollar signs.");
  return { latex, display: delimiter === "$$" };
}

function extractAiEquations(source) {
  if (source.length > 50000) throw new Error("Paste up to 50,000 characters at a time.");
  const text = source.replace(/\r\n?/g, "\n");
  const pattern = /\x60{3}([^\n\x60]*)\n([\s\S]*?)\x60{3}|(?<!\\)\$\$([\s\S]*?)(?<!\\)\$\$|(?<!\\)\\\[([\s\S]*?)(?<!\\)\\\]|(?<!\\)\\\(([\s\S]*?)(?<!\\)\\\)|(?<![\\$])\$(?![\s$])((?:\\[^\n]|[^$\\\n])+?)(?<!\s)\$(?!\$)|(?<!\\)\\begin\{(aligned|alignedat|gathered|split|align\*?|gather\*?|equation\*?|[bpBvV]?matrix|cases)\}/g;
  const equations = [];
  let match;
  while ((match = pattern.exec(text))) {
    if (match[7] !== undefined) {
      const environment = readMathEnvironment(text, match.index);
      equations.push({ latex: environment.latex, display: true });
      pattern.lastIndex = environment.end;
    } else if (match[1] !== undefined) {
      const language = match[1].trim().toLowerCase();
      if (!["", "latex", "tex", "math"].includes(language)) continue;
      const body = match[2].trim();
      const nested = extractAiEquations(body);
      if (nested.length) equations.push(...nested);
      else if (language && body) {
        if (/\$\$|\\[\[\]()]/.test(body)) {
          throw new Error("A LaTeX block has incomplete math delimiters. Check its opening and closing markers.");
        }
        equations.push({ latex: body, display: true });
      }
    } else {
      const latex = (match[3] ?? match[4] ?? match[5] ?? match[6]).trim();
      if (latex) equations.push({ latex, display: match[3] !== undefined || match[4] !== undefined });
    }
    if (equations.length > 100) throw new Error("Paste up to 100 equations at a time.");
  }
  return equations;
}

function looksLikeFlattenedMath(source) {
  return /[\u200b-\u200d\u2060]/.test(source) ||
    (/[∫∑∏∂∇ℏ∞≤]/.test(source) && !/\\(?:[a-zA-Z]+|[\[(])/.test(source));
}

function extractClipboardEquations(html) {
  if (!html) return [];
  if (html.length > 1000000) throw new Error("Copied response is too large. Copy a smaller selection.");
  // Template contents stay inert: pasted markup is never added to the live page.
  const template = document.createElement("template");
  template.innerHTML = html;
  const equations = [];
  const seenMath = new Set();
  let characters = 0;
  for (const annotation of template.content.querySelectorAll("math annotation[encoding]")) {
    const encoding = annotation.getAttribute("encoding").trim().toLowerCase();
    if (!["application/x-tex", "application/x-latex"].includes(encoding)) continue;
    const math = annotation.closest("math");
    const latex = annotation.textContent.trim();
    if (!latex || seenMath.has(math)) continue;
    seenMath.add(math);
    characters += latex.length;
    if (characters > 50000 || equations.length >= 100) {
      throw new Error("Copy up to 100 equations and 50,000 LaTeX characters at a time.");
    }
    equations.push({
      latex,
      display: math.getAttribute("display") === "block" || Boolean(math.closest(".katex-display"))
    });
  }
  return equations;
}

const FLATTENED_MATH_MESSAGE = "This looks like copied rendered math: fractions, powers, or duplicated formulas have lost their structure. Paste directly from the original chat with Ctrl+V, or use Copy LaTeX prompt to request the original LaTeX. Bare LaTeX cannot restore missing structure.";
const LATEX_REQUEST = "Please return the equations from your previous response as LaTeX source. Put each complete equation in a separate fenced code block labeled latex. Preserve all fractions, exponents, integral and sum limits, matrices, and line breaks. Do not use rendered equations or duplicated Unicode math text. Preserve the equations as written; do not evaluate or change them.";

const input = document.querySelector("#latex-input");
let isUntouchedExample = input.value === input.defaultValue;
const preview = document.querySelector("#equation-preview");
const errorMessage = document.querySelector("#error-message");
const status = document.querySelector("#status");
const presetSelect = document.querySelector("#preset-select");
const copyImageButton = document.querySelector("#copy-image");
const downloadButton = document.querySelector("#download-png");
const pasteBackgroundInputs = document.querySelectorAll('input[name="paste-background"]');
const aiSource = document.querySelector("#ai-source");
const aiSelect = document.querySelector("#ai-equations");
const aiCode = document.querySelector("#ai-equation-source");
const aiResult = document.querySelector("#ai-result");
const aiError = document.querySelector("#ai-error");
const aiImportButton = document.querySelector("#import-equation");
const aiRawInput = document.querySelector("#ai-raw");
const aiPanel = document.querySelector("#ai-import");
const previewHint = document.querySelector("#preview-help");

// Show the shortcut key this visitor will actually press.
if (/Mac|iPhone|iPad|iPod/.test(navigator.userAgentData?.platform || navigator.platform || "")) {
  document.querySelectorAll("[data-mod-key]").forEach(key => { key.textContent = "⌘"; });
}
let aiEquations = [];

function resetAiResults() {
  aiEquations = [];
  aiSelect.replaceChildren(new Option("No equations extracted yet", ""));
  aiSelect.disabled = true;
  aiImportButton.disabled = true;
  aiCode.textContent = "Your selected LaTeX will appear here.";
  aiResult.textContent = aiSource.value.trim()
    ? "Click Extract equations to find the equations in this response."
    : "Paste a response to get started.";
  aiError.textContent = "";
  aiError.hidden = true;
}

function showAiSelection() {
  const equation = aiEquations[Number(aiSelect.value)];
  aiCode.textContent = equation ? wrapEquation(equation.latex, equation.display) : "";
}

function showAiError(message) {
  aiError.textContent = message;
  aiError.hidden = false;
}

function extractFromSource() {
  resetAiResults();
  try {
    if (aiRawInput.checked) {
      if (!aiSource.value.trim()) throw new Error("Paste a LaTeX equation first.");
      if (aiSource.value.length > 50000) throw new Error("Paste up to 50,000 characters at a time.");
      if (looksLikeFlattenedMath(aiSource.value)) throw new Error(FLATTENED_MATH_MESSAGE);
      aiEquations = [{ latex: aiSource.value.trim(), display: true }];
    } else {
      aiEquations = extractAiEquations(aiSource.value);
    }
    if (!aiEquations.length) {
      if (looksLikeFlattenedMath(aiSource.value)) throw new Error(FLATTENED_MATH_MESSAGE);
      throw new Error("No equations found. Paste a latex, tex, or math code block, or enclose the formula in $$...$$, $...$, \\[...\\], or \\(...\\).");
    }
    aiSelect.replaceChildren(...aiEquations.map((equation, index) =>
      new Option((index + 1) + ". " + (equation.display ? "Display" : "Inline") + " — " + equation.latex.replace(/\s+/g, " ").slice(0, 90), String(index))));
    aiSelect.disabled = false;
    aiImportButton.disabled = false;
    aiResult.textContent = aiEquations.length === 1
      ? "1 equation found. Use it in the editor below."
      : aiEquations.length + " equations found. Choose one, then use it in the editor.";
    showAiSelection();
  } catch (error) {
    aiResult.textContent = "";
    showAiError(error.message);
  }
}

// A plain-text paste is extracted right away; typing still waits for the Extract button.
let extractAfterPaste = false;
aiSource.addEventListener("input", () => {
  if (extractAfterPaste) {
    extractAfterPaste = false;
    extractFromSource();
  } else {
    resetAiResults();
  }
});
aiSource.addEventListener("paste", event => {
  extractAfterPaste = true;
  setTimeout(() => { extractAfterPaste = false; });
  try {
    const equations = extractClipboardEquations(event.clipboardData?.getData("text/html"));
    if (!equations.length) return;
    event.preventDefault();
    extractAfterPaste = false;
    const start = aiSource.selectionStart;
    const end = aiSource.selectionEnd;
    const pasted = equations.map(equation => wrapEquation(equation.latex, equation.display)).join("\n\n");
    const prefix = start && aiSource.value[start - 1] !== "\n" ? "\n" : "";
    const suffix = end < aiSource.value.length && aiSource.value[end] !== "\n" ? "\n" : "";
    if (aiSource.value.length - (end - start) + prefix.length + pasted.length + suffix.length > 50000) {
      throw new Error("Paste up to 50,000 characters at a time.");
    }
    aiSource.setRangeText(prefix + pasted + suffix, start, end, "end");
    aiRawInput.checked = false;
    extractFromSource();
  } catch (error) {
    event.preventDefault();
    extractAfterPaste = false;
    resetAiResults();
    showAiError(error.message);
  }
});
document.querySelector("#copy-latex-prompt").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(LATEX_REQUEST);
    aiResult.textContent = "Prompt copied. Paste it into your AI chat, then copy its LaTeX code blocks here.";
  } catch {
    aiResult.textContent = LATEX_REQUEST;
  }
});
aiRawInput.addEventListener("change", () => {
  if (aiSource.value.trim()) extractFromSource();
  else resetAiResults();
});
aiSelect.addEventListener("change", showAiSelection);
document.querySelector("#extract-equations").addEventListener("click", extractFromSource);
document.querySelector("#clear-ai").addEventListener("click", () => {
  aiSource.value = "";
  aiRawInput.checked = false;
  resetAiResults();
  aiSource.focus();
});
aiPanel.addEventListener("toggle", () => {
  try { localStorage.setItem("ai-import-open", aiPanel.open ? "1" : "0"); } catch {}
});
aiImportButton.addEventListener("click", () => {
  const equation = aiEquations[Number(aiSelect.value)];
  if (!equation) return;
  input.value = wrapEquation(equation.latex, equation.display);
  isUntouchedExample = false;
  presetSelect.value = "";
  queueRender(true);
  input.focus();
  showStatus("Equation imported from AI response");
});

let changeVersion = 0;
let renderedVersion = -1;
let debounceTimer;
let scheduleRender = () => {};
// pending, ready, invalid, empty, or unavailable: describes the latest finished render.
let renderState = "pending";
let statusTimer;
let renderQueue = Promise.resolve();
const cachedPngBlobs = new Map();
const pngPromises = new Map();

function equationColor() {
  return document.querySelector('input[name="paste-background"]:checked').value === "dark"
    ? "#ffffff" : "#1f252b";
}

function showStatus(message, isError = false) {
  clearTimeout(statusTimer);
  status.textContent = message;
  status.classList.toggle("is-error", isError);
  status.classList.add("is-visible");
  // Errors stay longer because they carry a next step to read.
  statusTimer = setTimeout(() => {
    status.classList.remove("is-visible");
    statusTimer = setTimeout(() => { status.textContent = ""; }, 200);
  }, isError ? 4500 : 2000);
}

function setError(message) {
  errorMessage.textContent = message;
  errorMessage.hidden = !message;
}

function setImageActionsEnabled(enabled) {
  copyImageButton.disabled = !enabled;
  downloadButton.disabled = !enabled;
  // The copy hint only makes sense while there is an equation to copy.
  previewHint.hidden = !enabled;
}

// Buttons and errors keep their last state while typing, so they do not flicker on every key.
function queueRender(immediate = false) {
  const version = ++changeVersion;
  clearTimeout(debounceTimer);
  debounceTimer = undefined;
  preview.classList.remove("is-selected");
  renderedVersion = -1;
  renderState = "pending";
  cachedPngBlobs.clear();
  pngPromises.clear();

  scheduleRender = () => {
    debounceTimer = undefined;
    // MathJax 3 conversions share internal state, so they must run in sequence.
    renderQueue = renderQueue.catch(() => {}).then(() => renderEquation(version));
  };
  if (immediate) scheduleRender();
  else debounceTimer = setTimeout(scheduleRender, DEBOUNCE_MS);
}

// Starts a waiting debounced render now, so an export reflects the text in the editor.
function flushRender() {
  if (debounceTimer !== undefined) {
    clearTimeout(debounceTimer);
    scheduleRender();
  }
  return renderQueue.catch(() => {});
}

function showPreviewMessage(message) {
  preview.classList.remove("inline", "is-stale");
  preview.replaceChildren(makePlaceholder(message));
}

function showPreviewUnavailable() {
  renderState = "unavailable";
  setImageActionsEnabled(false);
  showPreviewMessage("Equation preview could not load.");
  setError("Equation preview could not load. Check your internet connection and reload the page.");
}

async function renderEquation(version) {
  if (version !== changeVersion) return;

  const latex = input.value;
  if (!latex.trim()) {
    renderState = "empty";
    setImageActionsEnabled(false);
    setError("");
    input.removeAttribute("aria-invalid");
    showPreviewMessage("Enter LaTeX to see an equation.");
    return;
  }

  if (!window.MathJax?.tex2svgPromise) {
    showPreviewUnavailable();
    return;
  }

  try {
    const equation = parseEquationSource(latex);
    const { display } = equation;
    document.querySelector(`input[name="mode"][value="${display ? "display" : "inline"}"]`).checked = true;
    const metrics = MathJax.getMetricsFor(preview, display);
    const result = await MathJax.tex2svgPromise(equation.latex, { ...metrics, display });
    if (version !== changeVersion) return;

    const svg = result.querySelector("svg");
    if (!svg) throw new Error("Equation renderer did not return an SVG equation.");

    preview.classList.toggle("inline", !display);
    preview.classList.remove("is-stale");
    preview.replaceChildren(result);
    renderedVersion = version;
    renderState = "ready";
    setImageActionsEnabled(true);
    setError("");
    input.removeAttribute("aria-invalid");
  } catch (error) {
    if (version !== changeVersion) return;
    renderState = "invalid";
    setImageActionsEnabled(false);
    setError(renderErrorMessage(error));
    input.setAttribute("aria-invalid", "true");
    // Keep the last good equation, dimmed, instead of flashing a placeholder mid-edit.
    if (preview.querySelector("mjx-container")) preview.classList.add("is-stale");
    else showPreviewMessage("Fix the LaTeX to update the preview.");
  }
}

// TeX and delimiter errors explain themselves; internal JavaScript errors would not.
function renderErrorMessage(error) {
  if (!error?.message || error instanceof TypeError || error instanceof RangeError) {
    return "This LaTeX could not be rendered. Check it for stray or invisible characters.";
  }
  return error.message;
}

function makePlaceholder(message) {
  const span = document.createElement("span");
  span.className = "placeholder";
  span.textContent = message;
  return span;
}

function svgToPng(svg, color, scale) {
  const box = svg.getBoundingClientRect();
  if (!box.width || !box.height) return Promise.reject(new Error("Equation has no visible size."));

  const width = Math.ceil(box.width * scale);
  const height = Math.ceil(box.height * scale);
  const clone = svg.cloneNode(true);
  clone.setAttribute("xmlns", SVG_NS);
  clone.setAttribute("width", `${box.width}px`);
  clone.setAttribute("height", `${box.height}px`);
  clone.setAttribute("color", color);
  clone.style.color = color;

  const xml = new XMLSerializer().serializeToString(clone);
  const svgUrl = URL.createObjectURL(new Blob([xml], { type: "image/svg+xml;charset=utf-8" }));

  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => {
      URL.revokeObjectURL(svgUrl);
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext("2d");
      if (!context) return reject(new Error("Canvas is unavailable."));
      context.imageSmoothingEnabled = true;
      context.imageSmoothingQuality = "high";
      context.scale(scale, scale);
      context.drawImage(image, 0, 0, box.width, box.height);
      canvas.toBlob(blob => {
        if (blob) resolve(blob);
        else reject(new Error("PNG export failed."));
      }, "image/png");
    };
    image.onerror = () => {
      URL.revokeObjectURL(svgUrl);
      reject(new Error("Could not convert the equation SVG to PNG."));
    };
    image.src = svgUrl;
  });
}

function exportError(message) {
  const error = new Error(message);
  error.name = "ExportError";
  return error;
}

const EXPORT_BLOCKED = {
  invalid: "Fix the LaTeX error before exporting.",
  empty: "Enter an equation first.",
  unavailable: "Equation preview could not load.",
  pending: "The preview is still updating. Try again."
};

function generatePngBlob(scale) {
  if (cachedPngBlobs.has(scale)) return Promise.resolve(cachedPngBlobs.get(scale));
  if (pngPromises.has(scale)) return pngPromises.get(scale);
  if (renderedVersion !== changeVersion) {
    return Promise.reject(exportError(EXPORT_BLOCKED[renderState] || EXPORT_BLOCKED.pending));
  }

  const svg = preview.querySelector("svg");
  if (!svg) return Promise.reject(exportError("There is no equation to export."));

  const version = renderedVersion;
  const previewFontPx = parseFloat(getComputedStyle(preview).fontSize) || EXPORT_BASE_FONT_PX;
  const exportScale = scale * EXPORT_BASE_FONT_PX / previewFontPx;
  const pngPromise = svgToPng(svg, equationColor(), exportScale).then(blob => {
    if (version !== changeVersion) throw exportError("The equation changed. Try again.");
    cachedPngBlobs.set(scale, blob);
    return blob;
  }).finally(() => {
    if (version === changeVersion) pngPromises.delete(scale);
  });
  pngPromises.set(scale, pngPromise);
  return pngPromise;
}

async function copyEquationImage() {
  if (!navigator.clipboard?.write || typeof ClipboardItem === "undefined" ||
      (ClipboardItem.supports && !ClipboardItem.supports("image/png"))) {
    showStatus("Image clipboard is unsupported. Use Download PNG instead.", true);
    return;
  }

  let exportFailure;
  try {
    const isWhite = equationColor() === "#ffffff";
    // Pass the Blob promise directly so clipboard.write starts during the user gesture.
    const png = flushRender().then(() => generatePngBlob(COPY_SCALE)).catch(error => {
      exportFailure = error;
      throw error;
    });
    await navigator.clipboard.write([new ClipboardItem({ "image/png": png })]);
    showStatus(isWhite
      ? "White equation copied as a transparent image"
      : "Dark equation copied as a transparent image");
  } catch (error) {
    const failure = exportFailure || error;
    showStatus(failure?.name === "ExportError"
      ? failure.message
      : "Clipboard access failed. Use Download PNG instead.", true);
  }
}

async function copyLatex() {
  if (!navigator.clipboard?.writeText) {
    showStatus("Text clipboard is unavailable in this browser.", true);
    return;
  }
  try {
    await navigator.clipboard.writeText(input.value);
    showStatus("LaTeX copied");
  } catch (error) {
    showStatus("Clipboard access failed.", true);
  }
}

async function downloadPng() {
  try {
    await flushRender();
    const blob = await generatePngBlob(DOWNLOAD_SCALE);
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "equation.png";
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    showStatus("PNG downloaded");
  } catch (error) {
    showStatus(error?.message || "PNG download failed.", true);
  }
}

input.addEventListener("paste", event => {
  const pastedText = event.clipboardData?.getData("text/plain");
  if (!pastedText) {
    if ([...(event.clipboardData?.items || [])].some(item => item.type.startsWith("image/"))) {
      showStatus("Clipboard contains an image. Paste LaTeX text here.", true);
    }
    return;
  }

  // Let the browser perform its normal paste, replacing only the untouched starter example.
  if (isUntouchedExample && input.selectionStart === input.selectionEnd) input.select();
});
input.addEventListener("input", () => {
  isUntouchedExample = false;
  queueRender();
});
document.querySelectorAll('input[name="mode"]').forEach(radio => {
  radio.addEventListener("change", () => {
    if (input.value.trim()) {
      try {
        const { latex } = parseEquationSource(input.value);
        input.value = wrapEquation(latex, radio.value === "display");
        isUntouchedExample = false;
      } catch (error) {
        // Keep incomplete input editable; the preview will show the delimiter error.
      }
    }
    queueRender(true);
  });
});
presetSelect.addEventListener("change", () => {
  if (!presetSelect.value) return;
  const display = document.querySelector('input[name="mode"]:checked').value === "display";
  input.value = wrapEquation(presets[presetSelect.value], display);
  isUntouchedExample = false;
  queueRender(true);
  input.focus();
});
pasteBackgroundInputs.forEach(radio => {
  radio.addEventListener("change", () => {
    preview.classList.toggle("dark", radio.value === "dark");
    queueRender(true);
  });
});
document.querySelector("#copy-latex").addEventListener("click", copyLatex);
copyImageButton.addEventListener("click", copyEquationImage);
downloadButton.addEventListener("click", downloadPng);
document.querySelector("#clear-input").addEventListener("click", () => {
  input.value = "";
  isUntouchedExample = false;
  presetSelect.value = "";
  queueRender(true);
  input.focus();
});
function selectEquation() {
  if (!preview.querySelector("svg") || preview.classList.contains("is-stale")) return;
  preview.classList.add("is-selected");
  preview.focus({ preventScroll: true });
}

preview.addEventListener("pointerdown", event => {
  if (event.button === 0) selectEquation();
});
preview.addEventListener("click", selectEquation);
preview.addEventListener("focusout", event => {
  if (!preview.contains(event.relatedTarget)) preview.classList.remove("is-selected");
});
preview.addEventListener("keydown", event => {
  if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === "c") {
    event.preventDefault();
    copyEquationImage();
  }
});

if (window.MathJax?.startup?.promise) {
  MathJax.startup.promise.then(() => {
    // Direct tex2svgPromise conversion does not insert MathJax's SVG stylesheet.
    if (!document.querySelector("#MJX-SVG-styles")) {
      document.head.appendChild(MathJax.svgStylesheet());
    }
    queueRender(true);
  }).catch(showPreviewUnavailable);
} else {
  showPreviewUnavailable();
}
