import { Together } from "together-ai";
import { marked } from 'marked';
import hljs from 'highlight.js';
import puppeteer from 'puppeteer';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Configuration
const HISTORY_FILE = 'history.json';
const CHAPTER_PREFIX = 'chapter';
const OUTPUT_PDF = 'book_output.pdf';
const COMBINED_FILE = 'combined-chapters.txt';

// Initialize
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

// === Utility Functions ===
function loadConversationHistory() {
  try {
    const data = fs.readFileSync(HISTORY_FILE, 'utf8');
    return JSON.parse(data);
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
  return combined;
}

// === AI Interaction ===
export async function askAI(prompt) {
  const trimmedHistory = trimHistory(conversationHistory);
  const messages = [...trimmedHistory, { role: 'user', content: prompt }];

  const response = await together.chat.completions.create({
    messages,
    model: "deepseek-ai/DeepSeek-R1-Distill-Llama-70B-free",
    max_tokens: 2000,
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

// === Chapter Generator ===
async function generateChapter(prompt, chapterNum) {
  const chapterText = await askAI(prompt);
  const filename = `${CHAPTER_PREFIX}-${chapterNum}.txt`;
  saveToFile(filename, chapterText);
  return filename;
}

// === Formatter ===
function formatMath(content) {
  return content
    .replace(/(\d+)\s*\^\s*(\d+)/g, (_, base, exp) => `$${base}^${exp}$`)
    .replace(/(\d+)\s*(\s*)/g, (_, num, den) => `$\\frac{${num}}{${den}}$`);
}

function cleanUpAIText(text) {
  // Remove horizontal separator lines (e.g., -----, =====)
  let cleaned = text.replace(/[-_=*~]{5,}/g, '');

  // Normalize newlines and replace long dashes
  return cleaned
    .replace(/\n{3,}/g, '\n\n')   // Convert 3+ newlines to 2
    .replace(/\n\s*$/g, '')         // Trim trailing newlines
    .replace(/[\u2013-\u2014]/g, '-') // Replace em/en dashes with hyphens
    .trim();
}

// === PDF Generator ===
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

      <script defer src="https://cdn.jsdelivr.net/npm/katex@0.16.9/dist/katex.min.js"></script>
      <script defer src="https://cdn.jsdelivr.net/npm/katex@0.16.9/dist/katex.contrib/auto-render.min.js"
        onload="renderMathInElement(document.body, {
          delimiters: [
            {left: '$$', right: '$$', display: true},
            {left: '$', right: '$', display: false}
          ]
        });"></script>

      <!-- Highlight.js for code block rendering -->
      <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.7.0/styles/default.min.css">
      <script src="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.7.0/highlight.min.js"></script>
      <script>document.addEventListener('DOMContentLoaded', (event) => { hljs.highlightAll(); });</script>

      <!-- Styles -->
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

        h1 {
          font-size: 20pt;
          text-align: center;
          border-bottom: 1px solid #aaa;
          padding-bottom: 0.3em;
          margin-top: 60px;
          margin-bottom: 30px;
        }

        h2 {
          font-size: 16pt;
          color: #333;
          margin-top: 40px;
          margin-bottom: 15px;
        }

        h3 {
          font-size: 14pt;
          color: #444;
          margin-top: 30px;
          margin-bottom: 10px;
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

        ul, ol {
          margin: 1em 0;
          padding-left: 2em;
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
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
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

// === Main Function ===

export async function generateBookL(bookTopic, userId) {
  try {
    console.log(`📚 Generating book for user: ${userId} with topic: ${bookTopic}`);

    conversationHistory = [{
      role: "system",
      content:
        "You are Hailu, an expert writer and researcher. You specialize in creating detailed, well-structured and very explanatory books with at least 400 words per subtopic. Make sure you explain every single detail before moving to the next one. Always begin with a Table of Contents."
    }];

    const prompts = [
       `[User Request]: ${bookTopic}\n\nAs Hailu, please create a table of contents for the book. Include 15 chapters with 400+ words per subtopic.`,
       "Now write Chapter 1 in detail.",
       "Now write Chapter 2 in detail.",
       "Now write Chapter 3 in detail.",
       "Now write Chapter 4 in detail.",
       "Now write Chapter 5 in detail.",
       "Now write Chapter 6 in detail.",
       "Now write Chapter 7 in detail.",
       "Now write Chapter 8 in detail.",
       "Now write Chapter 9 in detail.",
       "Now write Chapter 10 in detail.",
       "Now write Chapter 11 in detail.",
       "Now write Chapter 12 in detail.",
       "Now write Chapter 13 in detail.",
       "Now write Chapter 14 in detail.",
       "Now write Chapter 15 in detail.",
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









// export async function generateBookL(bookTopic) {
//   try {
//     conversationHistory = [{
//       role: "system",
//       content:
//         "You are Hailu, an expert writer and researcher. You specialize in creating detailed, well-structured and very explanatory books with at least 400 words per subtopic. Make sure you explain every single detail before moving to the next one. Always begin with a Table of Contents."
//     }];

//     const prompts = [
//       `[User Request]: ${bookTopic}\n\nAs Hailu, please create a table of contents for the book. Include 15 chapters with 400+ words per subtopic.`,
//       "Now write Chapter 1 in detail.",
//       "Now write Chapter 2 in detail.",
//       "Now write Chapter 3 in detail.",
//       "Now write Chapter 4 in detail.",
//       "Now write Chapter 5 in detail.",
//       "Now write Chapter 6 in detail.",
//       "Now write Chapter 7 in detail.",
//       "Now write Chapter 8 in detail.",
//       "Now write Chapter 9 in detail.",
//       "Now write Chapter 10 in detail.",
//       "Now write Chapter 11 in detail.",
//       "Now write Chapter 12 in detail.",
//       "Now write Chapter 13 in detail.",
//       "Now write Chapter 14 in detail.",
//       "Now write Chapter 15 in detail.",
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