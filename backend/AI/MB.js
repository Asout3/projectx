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
  console.log(`✔ Saved: ${filename} (${content.length} characters)`);
}

function deleteFile(filePath) {
  try {
    fs.unlinkSync(filePath);
    console.log(`Deleted: ${filePath}`);
  } catch (err) {
    console.error(`Error deleting ${filePath}:`, err);
  }
}

function combineChapters(files) {
  let combined = '';
  for (const file of files) {
    const content = fs.readFileSync(file, 'utf8');
    combined += content + '\n\n';
  }
  fs.writeFileSync(COMBINED_FILE, combined);
  console.log(`Combined content length: ${combined.length} characters`);
  return combined;
}

// === AI ===
export async function askAI(prompt) {
  const trimmedHistory = trimHistory(conversationHistory);
  const messages = [...trimmedHistory, { role: 'user', content: prompt }];

  const response = await together.chat.completions.create({
    messages,
    model: "deepseek-ai/DeepSeek-R1-Distill-Llama-70B-free",
    max_tokens: 3500,
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
function formatMath(content) {
  // Handle simple exponents and fractions
  let formatted = content
    .replace(/(\d+)\s*\^\s*(\d+)/g, (_, base, exp) => `$${base}^${exp}$`)
    .replace(/(\d+)\s*\/\s*(\d+)/g, (_, num, den) => `$\\frac{${num}}{${den}}$`);

  // Handle complex LaTeX expressions (e.g., \beta_0, \epsilon)
  formatted = formatted.replace(/\\([a-zA-Z]+(_[0-9])?)/g, (_, symbol) => `$${symbol}$`);
  // Wrap equations in square brackets or standalone LaTeX
  formatted = formatted.replace(/\[(.*?)\]/g, (_, equation) => {
    if (equation.includes('\\')) return `$$${equation}$$`;
    return equation;
  });

  return formatted;
}

function cleanUpAIText(text) {
  // Remove horizontal separator lines (e.g., -----, =====)
  let cleaned = text.replace(/^(?:[-_=*~\s]{5,})$/gm, '');

  // Normalize newlines and replace long dashes
  cleaned = cleaned
    .replace(/\n{3,}/g, '\n\n')   // Convert 3+ newlines to 2
    .replace(/\n\s*$/g, '')       // Trim trailing newlines
    .replace(/[\u2010-\u2015]/g, '-') // Replace all Unicode dashes (hyphen, en, em, etc.) with standard hyphen
    .trim();

  return cleaned;
}

// === PDF ===
export async function generatePDF(content, outputPath) {
  const cleaned = cleanUpAIText(formatMath(content));

  const html = `
  <html>
    <head>
      <meta charset="utf-8">
      <title>Research Paper</title>
      <meta http-equiv="Content-Security-Policy" content="default-src * 'unsafe-inline' 'unsafe-eval';">

      <!-- KaTeX for math rendering -->
      <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@0.16.9/dist/katex.min.css">
      <script defer src="https://cdn.jsdelivr.net/npm/katex@0.16.9/dist/katex.min.js"></script>
      <script defer src="https://cdn.jsdelivr.net/npm/katex@0.16.9/dist/contrib/auto-render.min.js"
        onload="renderMathInElement(document.body, {
          delimiters: [
            {left: '$$', right: '$$', display: true},
            {left: '$', right: '$', display: false}
          ],
          throwOnError: false
        });"></script>

      <!-- Highlight.js for code block rendering -->
      <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.7.0/styles/default.min.css">
      <script src="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.7.0/highlight.min.js"></script>
      <script>document.addEventListener('DOMContentLoaded', (event) => { hljs.highlightAll(); });</script>

      <!-- Default simple style -->
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

        h1, h2, h3 {
          margin-top: 40px;
          margin-bottom: 15px;
        }

        p {
          margin: 0 0 1em 0;
        }

        pre {
          background: #f5f5f5;
          color: #333;
          padding: 15px;
          overflow-x: auto;
          border-radius: 6px;
          font-size: 13px;
          font-family: 'Consolas', 'Monaco', monospace;
          border: 1px solid #ddd;
        }

        code {
          background: #f4f4f4;
          padding: 2px 6px;
          border-radius: 4px;
          font-family: 'Consolas', 'Monaco', monospace;
          font-size: 13px;
        }

        pre code {
          background: none;
          padding: 0;
          border-radius: 0;
        }

        .katex {
          font-size: 1.1em;
          margin: 0 5px;
        }

        .katex-display {
          margin: 1em 0;
          text-align: center;
        }

        table {
          border-collapse: collapse;
          margin: 1em 0;
          width: 100%;
        }

        table, th, td {
          border: 1px solid #ccc;
        }

        th, td {
          padding: 8px;
          text-align: left;
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
export async function generateBookMedd(bookTopic, userId) {
  try {
    console.log(`📚 Generating MEDIUM book for user: ${userId} with topic: ${bookTopic}`);

    // Isolated history for this request only
    let conversationHistory = [{
      role: "system",
      content:
        "You are Hailu, an expert writer and researcher. You specialize in writing medium-sized books that are detailed but slightly more concise than long-form versions. Aim for about 700-800 words per chapter. Begin with a Table of Contents."
    }];

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

    async function generateChapter(prompt, chapterNum) {
      const chapterText = await askAI(prompt);
      const filename = `${CHAPTER_PREFIX}-med-${userId}-${chapterNum}.txt`;
      saveToFile(filename, chapterText);
      return filename;
    }

    const prompts = [
      `[User Request]: ${bookTopic}\n\nAs Hailu, create a table of contents for a medium-length book. Include 6 chapters.`,
      "Now write Chapter 1 in detail.",
      "Now write Chapter 2 in detail.",
      "Now write Chapter 3 in detail.",
      "Now write Chapter 4 in detail.",
      "Now write Chapter 5 in detail.",
      "Now write Chapter 6 in detail.",
      "Now conclude the book and provide references or recommendations."
    ];

    const chapterFiles = [];
    for (const [index, prompt] of prompts.entries()) {
      const chapterNum = index + 1;
      console.log(`📘 (MED) Generating Chapter ${chapterNum}`);
      chapterFiles.push(await generateChapter(prompt, chapterNum));
    }

    const combinedContent = combineChapters(chapterFiles);

    const safeTopic = bookTopic.slice(0, 20).replace(/\s+/g, "_");
    const fileName = `output_med_${userId}_${safeTopic}.pdf`;
    const outputDir = path.join(__dirname, '../pdfs');
    if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir);

    const outputPath = path.join(outputDir, fileName);
    await generatePDF(combinedContent, outputPath);

    chapterFiles.forEach(deleteFile);

    console.log(`✅ Medium book generation done. Output: ${outputPath}`);
    return outputPath;

  } catch (error) {
    console.error('❌ Medium book generation failed:', error);
    throw error;
  }
}



// export async function generateBookMed(bookTopic) {
//   try {
//     conversationHistory = [{
//       role: "system",
//       content:
//         "You are Hailu, an expert writer and researcher. You specialize in creating detailed, well-structured and very explanatory books with at least 400 words per subtopic. Make sure you explain every single detail before moving to the next one. Always begin with a Table of Contents."
//     }];

//     const prompts = [
//       `[User Request]: ${bookTopic}\n\nAs Hailu, please create a table of contents for the book. Include 10 chapters with 400+ words per subtopic.`,
//       "Now write Chapter 1 in detail. and Use proper and same mark down to represent each chapter title.",
//       "Now write Chapter 2 in detail. and Use proper and same mark down to represent each chapter title.",
//       "Now write Chapter 3 in detail. and Use proper and same mark down to represent each chapter title.",
//       "Now write Chapter 4 in detail. and Use proper and same mark down to represent each chapter title.",
//       "Now write Chapter 5 in detail. and Use proper and same mark down to represent each chapter title.",
//       "Now write Chapter 6 in detail. and Use proper and same mark down to represent each chapter title.",
//       "Now write Chapter 7 in detail. and Use proper and same mark down to represent each chapter title.",
//       "Now write Chapter 8 in detail. and Use proper and same mark down to represent each chapter title.",
//       "Now write Chapter 9 in detail. and Use proper and same mark down to represent each chapter title.",
//       "Now write Chapter 10 in detail. and Use proper and same mark down to represent each chapter title.",
//       "Now conclude the book and provide references and additional resources."
//     ];

//     const chapterFiles = [];
//     for (const [index, prompt] of prompts.entries()) {
//       const chapterNum = index + 1;
//       console.log(`\nGenerating Chapter ${chapterNum}`);
//       chapterFiles.push(await generateChapter(prompt, chapterNum));
//     }

//     const combinedContent = combineChapters(chapterFiles);
//     await generatePDF(combinedContent, OUTPUT_PDF);

//     chapterFiles.forEach(deleteFile);

//     console.log(`\nBook generation complete. Output: ${OUTPUT_PDF}`);
//     return OUTPUT_PDF;
//   } catch (error) {
//     console.error('Book generation failed:', error);
//     throw error;
//   }
// }

//generateBookMed('generate me a book that teaches Rust programing language for beginners')
