import { Together } from "together-ai";
import { marked } from 'marked';
import hljs from 'highlight.js';
import puppeteer from 'puppeteer-core';
import chromium from '@sparticuz/chromium';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);


// Constants
const HISTORY_FILE = 'history.json';
const CHAPTER_PREFIX = 'chapter';
const OUTPUT_PDF = 'book_output.pdf';
const COMBINED_FILE = 'combined-chapters.txt';

// Init
let conversationHistory = loadConversationHistory();
const together = new Together({
  apiKey: '18a96a823e402ef5dfedc1e372bf50fc8e6357bb25a0eff0bea25a07f51a1087',
});

// Markdown & Code Highlighting
marked.setOptions({
  highlight: function (code, lang) {
    const validLang = hljs.getLanguage(lang) ? lang : 'plaintext';
    return hljs.highlight(code, { language: validLang }).value;
  }
});

// === Utilities ===
function loadConversationHistory() {
  try {
    return JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
  } catch {
    console.log('No history found. Starting fresh.');
    return [];
  }
}

function saveConversationHistory() {
  const trimmed = trimHistory(conversationHistory);
  fs.writeFileSync(HISTORY_FILE, JSON.stringify(trimmed, null, 2));
}

function trimHistory(messages) {
  const tocMessage = messages.find(
    (msg) => msg.role === "assistant" && msg.content.toLowerCase().includes("table of contents")
  );
  if (!tocMessage) return [];

  return [{
    role: "system",
    content:
      "You are Hailu, an expert writer and researcher. You specialize in writing detailed, explanatory books. Follow this Table of Contents strictly and write each chapter sequentially. Here is the Table of Contents:\n\n" +
      tocMessage.content,
  }];
}

function saveToFile(filename, content) {
  fs.writeFileSync(filename, content);
  console.log(`✔ Saved: ${filename}`);
}

function deleteFile(filePath) {
  try {
    fs.unlinkSync(filePath);
    console.log(`🗑 Deleted: ${filePath}`);
  } catch (err) {
    console.error(`❌ Error deleting ${filePath}:`, err);
  }
}

function combineChapters(files) {
  let combined = '';
  for (const file of files) {
    combined += fs.readFileSync(file, 'utf8') + '\n\n';
  }
  fs.writeFileSync(COMBINED_FILE, combined);
  return combined;
}

// === AI ===
export async function askAI(prompt) {
  const trimmedHistory = trimHistory(conversationHistory);
  const messages = [...trimmedHistory, { role: 'user', content: prompt }];

  const response = await together.chat.completions.create({
    messages,
    model: "deepseek-ai/DeepSeek-R1-Distill-Llama-70B-free",
    max_tokens: 3000,
    temperature: 0.8,
  });

  let reply = response.choices[0].message.content
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/^I'm DeepSeek-R1.*?help you\.\s*/i, '')
    .trim();

  conversationHistory.push({ role: 'user', content: prompt });
  conversationHistory.push({ role: 'assistant', content: reply });
  saveConversationHistory();

  return reply;
}

// === Chapter ===
async function generateChapter(prompt, chapterNum) {
  const chapterText = await askAI(prompt);
  const filename = `${CHAPTER_PREFIX}-${chapterNum}.txt`;
  saveToFile(filename, chapterText);
  return filename;
}

// === Formatter ===
// function formatMath(content) {
//   return content
//     .replace(/(\d+)\s*\^\s*(\d+)/g, (_, base, exp) => `$${base}^${exp}$`)
//     .replace(/(\d+)\s*\/\s*(\d+)/g, (_, num, den) => `$\\frac{${num}}{${den}}$`);
// }

// function cleanUpAIText(text) {
//   // 1. Remove horizontal separator lines (e.g., -----, =====)
//   const noDividers = text.replace(/^(?:[-=_*~\s]{5,})$/gm, '');

//   // 2. Normalize extra newlines (max 2)
//   const normalized = noDividers
//     .replace(/\n{3,}/g, '\n\n')  // Convert 3+ newlines to 2
//     .replace(/\n\s*$/g, '')      // Trim trailing newlines
//     .trim();

//   // 3. Replace long dashes (em/en dashes) with standard hyphens
//   return normalized
//     .replace(/[\u2013\u2014]/g, '-');
// }

// // === PDF ===
// export async function generatePDF(content, outputPath) {
//   const cleaned = cleanUpAIText(formatMath(content));

//   const html = `
//   <html>
//     <head>
//       <meta charset="utf-8">
//       <title>Research Paper</title>
//       <meta http-equiv="Content-Security-Policy" content="default-src * 'unsafe-inline' 'unsafe-eval';">

//       <!-- KaTeX for math rendering -->
//       <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@0.16.7/dist/katex.min.css">
//       <script defer src="https://cdn.jsdelivr.net/npm/katex@0.16.7/dist/katex.min.js"></script>
//       <script defer src="https://cdn.jsdelivr.net/npm/katex@0.16.7/dist/contrib/auto-render.min.js"
//         onload="renderMathInElement(document.body, {
//           delimiters: [
//             {left: '$$', right: '$$', display: true},
//             {left: '$', right: '$', display: false}
//           ]
//         });"></script>

//       <!-- Highlight.js for code block rendering -->
//       <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.7.0/styles/default.min.css">
//       <script src="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.7.0/highlight.min.js"></script>
//       <script>document.addEventListener('DOMContentLoaded', (event) => { hljs.highlightAll(); });</script>

//       <!-- Default simple style -->
//       <style>
//         @page {
//           margin: 80px 60px;
//         }

//         body {
//           font-family: 'Georgia', serif;
//           font-size: 14px;
//           line-height: 1.6;
//           color: #222;
//           margin: 0;
//           padding: 0;
//           text-align: justify;
//         }

//         h1, h2, h3 {
//           margin-top: 40px;
//           margin-bottom: 15px;
//         }

//         p {
//           margin: 0 0 1em 0;
//         }

//         pre {
//           background: #f5f5f5;
//           color: #333;
//           padding: 15px;
//           overflow-x: auto;
//           border-radius: 6px;
//           font-size: 13px;
//           font-family: 'Consolas', 'Monaco', monospace;
//           border: 1px solid #ddd;
//         }

//         code {
//           background: #f4f4f4;
//           padding: 2px 6px;
//           border-radius: 4px;
//           font-family: 'Consolas', 'Monaco', monospace;
//           font-size: 13px;
//         }

//         pre code {
//           background: none;
//           padding: 0;
//           border-radius: 0;
//         }

//         table {
//           border-collapse: collapse;
//           margin: 1em 0;
//           width: 100%;
//         }

//         table, th, td {
//           border: 1px solid #ccc;
//         }

//         th, td {
//           padding: 8px;
//           text-align: left;
//         }
//       </style>
//     </head>
//     <body>
//       ${marked.parse(cleaned)}
//     </body>
//   </html>
//   `;

//   const browser = await puppeteer.launch({
//   executablePath: await chromium.executablePath(),
//   headless: chromium.headless,
//   args: chromium.args,
// });

//   const page = await browser.newPage();

//   await page.setContent(html, { waitUntil: 'networkidle0' });

//   await page.pdf({
//     path: outputPath,
//     format: 'A4',
//     printBackground: true,
//     displayHeaderFooter: true,
//     footerTemplate: `
//       <div style="font-size:10px; text-align:center; width:100%;">
//         Page <span class="pageNumber"></span> of <span class="totalPages"></span>
//       </div>`,
//     headerTemplate: `<div></div>`,
//     margin: {
//       top: '80px',
//       bottom: '80px',
//       left: '60px',
//       right: '60px',
//     },
//   });

//   await browser.close();
// 

// === Formatter ===
function formatMath(content) {
  // Preserve existing LaTeX delimiters ($...$ or $$...$$) and enhance basic math
  return content
    // Handle basic exponents (e.g., x^2 -> $x^2$)
    .replace(/([a-zA-Z0-9]+)\s*\^\s*([a-zA-Z0-9]+)/g, (_, base, exp) => `$${base}^{${exp}}$`)
    // Handle fractions (e.g., a/b -> $\frac{a}{b}$)
    .replace(/([0-9]+)\s*\/\s*([0-9]+)/g, (_, num, den) => `$\\frac{${num}}{${den}}$`)
    // Protect existing LaTeX by not double-wrapping (avoid touching $...$ or $$...$$)
    .replace(/(?<!\$)([a-zA-Z0-9]+)\s*([+\-*/])\s*([a-zA-Z0-9]+)/g, (_, left, op, right) => {
      // Wrap simple arithmetic in $...$ if not already wrapped
      if (!content.match(/\$[^$]*\$\s*$/)) {
        return `$${left}${op}${right}$`;
      }
      return `${left}${op}${right}`;
    });
}

function cleanUpAIText(text) {
  // 1. Remove horizontal separator lines (e.g., -----, =====)
  const noDividers = text.replace(/^(?:[-=_*~\s]{5,})$/gm, '');

  // 2. Normalize extra newlines (max 2)
  const normalized = noDividers
    .replace(/\n{3,}/g, '\n\n') // Convert 3+ newlines to 2
    .replace(/\n\s*$/g, '')     // Trim trailing newlines
    .trim();

  // 3. Replace long dashes with standard hyphens
  return normalized.replace(/[\u2013\u2014]/g, '-');
}

// === PDF ===
export async function generatePDF(content, outputPath) {
  const cleaned = cleanUpAIText(content); // Keep your formatMath optional if needed

  const html = `
  <html>
    <head>
      <meta charset="utf-8">
      <title>Document</title>
      <script type="text/javascript" id="MathJax-script" async
        src="https://cdn.jsdelivr.net/npm/mathjax@3/es5/tex-mml-chtml.js">
      </script>

      <style>
        @page {
          margin: 80px 60px;
        }

        body {
          font-family: 'Georgia', serif;
          font-size: 14px;
          line-height: 1.6;
          color: #222;
          margin: 0;
          padding: 0;
          text-align: justify;
        }

        a {
          color: #0645AD;
          text-decoration: underline;
        }

        pre {
          background: #f5f5f5;
          padding: 15px;
          overflow-x: auto;
          border-radius: 6px;
          border: 1px solid #ddd;
          font-family: 'Consolas', monospace;
        }

        code {
          background: #f4f4f4;
          padding: 2px 6px;
          border-radius: 4px;
          font-family: 'Consolas', monospace;
        }

        h1, h2, h3 {
          margin-top: 40px;
          margin-bottom: 15px;
        }

        p {
          margin: 0 0 1em 0;
        }
      </style>
    </head>
    <body>
      ${marked.parse(cleaned)}
    </body>
  </html>
  `;

  const browser = await puppeteer.launch({
    executablePath: await chromium.executablePath(),
    headless: chromium.headless,
    args: chromium.args,
  });

  const page = await browser.newPage();
  await page.setContent(html, { waitUntil: 'networkidle0' });

  await page.pdf({
    path: outputPath,
    format: 'A4',
    printBackground: true,
    displayHeaderFooter: true,
    footerTemplate: `
      <div style="font-size:10px; text-align:center; width:100%;">
        Page <span class="pageNumber"></span> of <span class="totalPages"></span>
      </div>`,
    headerTemplate: `<div></div>`,
    margin: {
      top: '80px',
      bottom: '80px',
      left: '60px',
      right: '60px',
    },
  });

  await browser.close();
}







// === Master Function ===
export async function generateBookS(bookTopic, userId) {
  try {
    console.log(`📚 Generating book for user: ${userId} with topic: ${bookTopic}`);

    // Each user/request gets their own conversation history
    let conversationHistory = [{
      role: "system",
      content:
        "You are Hailu, an expert writer and researcher. You specialize in creating detailed, well-structured and very explanatory books with at least 400 words per subtopic. Make sure you explain every single detail before moving to the next one. Always begin with a Table of Contents."
    }];

    // AI interaction scoped to user
    async function askAI(prompt) {
      const trimmedHistory = trimHistory(conversationHistory);
      const messages = [...trimmedHistory, { role: 'user', content: prompt }];

      const response = await together.chat.completions.create({
        messages,
        model: "deepseek-ai/DeepSeek-R1-Distill-Llama-70B-free",
        max_tokens: 3000,
        temperature: 0.8,
      });

      let reply = response.choices[0].message.content
        .replace(/<think>[\s\S]*?<\/think>/gi, '')
        .replace(/^I'm DeepSeek-R1.*?help you\.\s*/i, '')
        .trim();

      conversationHistory.push({ role: 'user', content: prompt });
      conversationHistory.push({ role: 'assistant', content: reply });

      return reply;
    }

    // Generate individual chapter text file
    async function generateChapter(prompt, chapterNum) {
      const chapterText = await askAI(prompt);
      const filename = `${CHAPTER_PREFIX}-${userId}-${chapterNum}.txt`;
      saveToFile(filename, chapterText);
      return filename;
    }

    const prompts = [
      `[User Request]: ${bookTopic}\n\nAs Hailu, please create a table of contents for the book. Include 5 chapters with 400+ words per subtopic.`,
      "Now write Chapter 1 in detail.",
      "Now write Chapter 2 in detail.",
      "Now write Chapter 3 in detail.",
      "Now write Chapter 4 in detail.",
      "Now write Chapter 5 in detail.",
      "Now conclude the book and provide references and additional resources."
    ];

    const chapterFiles = [];
    for (const [index, prompt] of prompts.entries()) {
      const chapterNum = index + 1;
      console.log(`\n📘 Generating Chapter ${chapterNum}`);
      chapterFiles.push(await generateChapter(prompt, chapterNum));
    }

    const combinedContent = combineChapters(chapterFiles);

    const safeTopic = bookTopic.slice(0, 20).replace(/\s+/g, "_");
    const fileName = `output_${userId}_${safeTopic}.pdf`;
    const outputDir = path.join(__dirname, '../pdfs');
    if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir);

    const outputPath = path.join(outputDir, fileName);
    await generatePDF(combinedContent, outputPath);

    chapterFiles.forEach(deleteFile);

    console.log(`\n✅ Book generation complete. Output: ${outputPath}`);
    return outputPath;

  } catch (error) {
    console.error('❌ Book generation failed:', error);
    throw error;
  }
}
