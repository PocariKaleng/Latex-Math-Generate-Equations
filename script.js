"use strict";

const COPY_SCALE = 2;
const DOWNLOAD_SCALE = 4;
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
let aiEquations = [];

function resetAiResults() {
  aiEquations = [];
  aiSelect.replaceChildren(new Option("No equations extracted yet", ""));
  aiSelect.disabled = true;
  aiImportButton.disabled = true;
  aiCode.textContent = "Your selected LaTeX will appear here.";
  aiResult.textContent = "Extract equations to get started.";
  aiError.textContent = "";
  aiError.hidden = true;
}

function showAiSelection() {
  const equation = aiEquations[Number(aiSelect.value)];
  aiCode.textContent = equation ? wrapEquation(equation.latex, equation.display) : "";
}

aiSource.addEventListener("input", resetAiResults);
document.querySelector("#ai-raw").addEventListener("change", resetAiResults);
aiSelect.addEventListener("change", showAiSelection);
document.querySelector("#extract-equations").addEventListener("click", () => {
  resetAiResults();
  try {
    if (document.querySelector("#ai-raw").checked) {
      if (!aiSource.value.trim()) throw new Error("Paste a LaTeX equation first.");
      if (aiSource.value.length > 50000) throw new Error("Paste up to 50,000 characters at a time.");
      aiEquations = [{ latex: aiSource.value.trim(), display: true }];
    } else {
      aiEquations = extractAiEquations(aiSource.value);
    }
    if (!aiEquations.length) {
      throw new Error("No equations found. Paste a latex, tex, or math code block, or enclose the formula in $$...$$, $...$, \\[...\\], or \\(...\\).");
    }
    aiSelect.replaceChildren(...aiEquations.map((equation, index) =>
      new Option((index + 1) + ". " + (equation.display ? "Display" : "Inline") + " — " + equation.latex.replace(/\s+/g, " ").slice(0, 90), String(index))));
    aiSelect.disabled = false;
    aiImportButton.disabled = false;
    aiResult.textContent = aiEquations.length + (aiEquations.length === 1 ? " equation found." : " equations found.") + " Choose one to render.";
    showAiSelection();
  } catch (error) {
    aiError.textContent = error.message;
    aiError.hidden = false;
  }
});
document.querySelector("#clear-ai").addEventListener("click", () => {
  aiSource.value = "";
  document.querySelector("#ai-raw").checked = false;
  resetAiResults();
  aiSource.focus();
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
  statusTimer = setTimeout(() => { status.textContent = ""; }, 1800);
}

function setError(message) {
  errorMessage.textContent = message;
  errorMessage.hidden = !message;
}

function setImageActionsEnabled(enabled) {
  copyImageButton.disabled = !enabled;
  downloadButton.disabled = !enabled;
}

function queueRender(immediate = false) {
  const version = ++changeVersion;
  clearTimeout(debounceTimer);
  preview.classList.remove("is-selected");
  renderedVersion = -1;
  cachedPngBlobs.clear();
  pngPromises.clear();
  setImageActionsEnabled(false);
  setError("");

  const schedule = () => {
    // MathJax 3 conversions share internal state, so they must run in sequence.
    renderQueue = renderQueue.catch(() => {}).then(() => renderEquation(version));
  };
  if (immediate) schedule();
  else debounceTimer = setTimeout(schedule, DEBOUNCE_MS);
}

async function renderEquation(version) {
  if (version !== changeVersion) return;

  const latex = input.value;
  if (!latex.trim()) {
    preview.classList.remove("inline");
    preview.replaceChildren(makePlaceholder("Enter LaTeX to see an equation."));
    return;
  }

  if (!window.MathJax?.tex2svgPromise) {
    preview.replaceChildren(makePlaceholder("Equation preview could not load."));
    setError("Equation preview could not load. Check your internet connection and reload the page.");
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
    preview.replaceChildren(result);
    renderedVersion = version;
    setImageActionsEnabled(true);
    setError("");
  } catch (error) {
    if (version !== changeVersion) return;
    preview.classList.remove("inline");
    preview.replaceChildren(makePlaceholder("Fix the LaTeX to update the preview."));
    setError(error?.message || "The equation could not be rendered.");
  }
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

function generatePngBlob(scale) {
  if (cachedPngBlobs.has(scale)) return Promise.resolve(cachedPngBlobs.get(scale));
  if (pngPromises.has(scale)) return pngPromises.get(scale);
  if (renderedVersion !== changeVersion) return Promise.reject(new Error("The preview is still updating."));

  const svg = preview.querySelector("svg");
  if (!svg) return Promise.reject(new Error("There is no equation to export."));

  const version = renderedVersion;
  const pngPromise = svgToPng(svg, equationColor(), scale).then(blob => {
    if (version !== changeVersion) throw new Error("The equation changed. Try again.");
    cachedPngBlobs.set(scale, blob);
    return blob;
  }).finally(() => {
    if (version === changeVersion) pngPromises.delete(scale);
  });
  pngPromises.set(scale, pngPromise);
  return pngPromise;
}

async function copyEquationImage() {
  if (renderedVersion !== changeVersion) {
    showStatus("Wait for the equation preview to update.", true);
    return;
  }
  if (!navigator.clipboard?.write || typeof ClipboardItem === "undefined" ||
      (ClipboardItem.supports && !ClipboardItem.supports("image/png"))) {
    showStatus("Image clipboard is unsupported. Use Download PNG instead.", true);
    return;
  }

  try {
    const isWhite = equationColor() === "#ffffff";
    // Pass the Blob promise directly so clipboard.write starts during the user gesture.
    const png = generatePngBlob(COPY_SCALE);
    await navigator.clipboard.write([new ClipboardItem({ "image/png": png })]);
    showStatus(isWhite
      ? "White equation copied as transparent image"
      : "Dark equation copied as transparent image");
  } catch (error) {
    showStatus("Clipboard access failed. Use Download PNG instead.", true);
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
  if (!preview.querySelector("svg")) return;
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
  }).catch(() => {
    preview.replaceChildren(makePlaceholder("Equation preview could not load."));
    setError("Equation preview could not load. Check your internet connection and reload the page.");
  });
} else {
  preview.replaceChildren(makePlaceholder("Equation preview could not load."));
  setError("Equation preview could not load. Check your internet connection and reload the page.");
}
