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
  const links = [];
  content = content.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, text, url) => {
    links.push(`<a href="${url}" target="_blank">${text}</a>`);
    return `__LINK__${links.length - 1}__`;
  });

  content = content
    // Brackets to inline MathJax
    .replace(/\[\s*(.*?)\s*\]/gs, (_, math) => `\\(${math}\\)`)
    .replace(/\(\s*(.*?)\s*\)/gs, (_, math) => `\\(${math}\\)`)

    // x^2, a^b → \(a^b\)
    .replace(
      /([a-zA-Z0-9]+)\s*\^\s*([a-zA-Z0-9]+)/g,
      (_, base, exp) => `\\(${base}^{${exp}}\\)`,
    )

    // simple fractions 2/3 → \(\frac{2}{3}\)
    .replace(
      /(?<!\\)(?<!\w)(\d+)\s*\/\s*(\d+)(?!\w)/g,
      (_, num, den) => `\\(\\frac{${num}}{${den}}\\)`,
    );

  // Restore links
  content = content.replace(/__LINK__(\d+)__/g, (_, i) => links[i]);

  return content;
}

function cleanUpAIText(text) {
  return (
    text
      // Remove long dividers (---, ===, etc.) but leave ** and *
      .replace(/^(?:[-=_~\s]{5,})$/gm, "")
      .replace(/\n{3,}/g, "\n\n") // Collapse multiple newlines to 2
      .replace(/\n\s*$/g, "") // Remove trailing blank lines
      .replace(/[\u2013\u2014]/g, "-") // Normalize em/en dashes
      .trim()
  );
}

export async function generatePDF(content, outputPath) {
  const cleaned = cleanUpAIText(content); // ✅ do NOT escape "**" or "*"

  const html = `
  <html>
    <head>
      <meta charset="utf-8">
      <title>Document</title>

      <script type="text/javascript" id="MathJax-script" async
        src="https://cdn.jsdelivr.net/npm/mathjax@3/es5/tex-mml-chtml.js">
      </script>

      <script src="https://cdn.jsdelivr.net/npm/prismjs@1.29.0/prism.min.js"></script>
      <script src="https://cdn.jsdelivr.net/npm/prismjs@1.29.0/components/prism-javascript.min.js"></script>
      <script src="https://cdn.jsdelivr.net/npm/prismjs@1.29.0/components/prism-python.min.js"></script>
      <script src="https://cdn.jsdelivr.net/npm/prismjs@1.29.0/components/prism-java.min.js"></script>
      <script src="https://cdn.jsdelivr.net/npm/prismjs@1.29.0/components/prism-cpp.min.js"></script>
      <link href="https://cdn.jsdelivr.net/npm/prismjs@1.29.0/themes/prism.min.css" rel="stylesheet">

      <style>
        @page {
          margin: 80px 60px;
        }

        body {
          font-family: 'Inter', 'Segoe UI', 'Helvetica Neue', sans-serif;
          font-size: 12.5px;
          line-height: 1.6;
          color: #1a1a1a;
          background: white;
          margin: 0;
          padding: 0;
          text-align: justify;
        }

        .cover {
          text-align: center;
          margin-top: 200px;
        }

        .cover h1 {
          font-size: 36px;
          font-weight: 700;
          margin-bottom: 0.2em;
        }

        .cover h2 {
          font-size: 20px;
          font-weight: 400;
          color: #555;
        }

        .page-break {
          page-break-before: always;
        }

        h1, h2, h3 {
          font-weight: 600;
          color: #2c3e50;
          margin-top: 2em;
          margin-bottom: 0.4em;
        }

        h1 { font-size: 24px; border-bottom: 2px solid #e0e0e0; padding-bottom: 5px; }
        h2 { font-size: 20px; border-bottom: 1px solid #e0e0e0; padding-bottom: 3px; }
        h3 { font-size: 16px; }

        p {
          margin: 0 0 1em 0;
        }

        a {
          color: #007acc;
          text-decoration: underline;
        }

        code, pre {
          font-family: 'Fira Code', monospace;
          border-radius: 6px;
          font-size: 13px;
        }

        code {
          background: #f4f4f4;
          padding: 3px 8px;
          border: 1px solid #e0e0e0;
        }

        pre {
          background: #f8f9fa;
          padding: 20px;
          overflow-x: auto;
          border: 1px solid #e0e0e0;
          line-height: 1.5;
          margin: 1.2em 0;
          white-space: pre-wrap;
          word-wrap: break-word;
          overflow-x: hidden;

          }

        pre code {
          background: none;
          border: none;
          padding: 0;
        }

        blockquote {
          border-left: 4px solid #007acc;
          margin: 1.5em 0;
          padding: 0.5em 0 0.5em 1.5em;
          background: #f8f9fa;
          color: #2c3e50;
          font-style: italic;
          border-radius: 4px;
        }

        hr {
          border: none;
          border-top: 1px solid #e0e0e0;
          margin: 2em 0;
        }

        .footer {
          font-size: 10px;
          text-align: center;
          width: 100%;
          color: #999;
        }

        .example {
          background: #f8f9fa;
          border-left: 4px solid #007acc;
          padding: 15px 20px;
          margin: 1.5em 0;
          border-radius: 4px;
          font-style: italic;
        }

        .toc {
          page-break-after: always;
          margin: 2em 0;
          padding: 1em;
          background: #f8f9fa;
          border-radius: 6px;
        }

        .toc h2 {
          font-size: 20px;
          border-bottom: 1px solid #e0e0e0;
          margin-bottom: 1em;
        }

        .toc ul {
          list-style: none;
          padding: 0;
        }

        .toc li {
          margin: 0.5em 0;
        }

        .toc a {
          text-decoration: none;
          color: #007acc;
        }

        .toc a:hover {
          text-decoration: underline;
        }
      </style>
    </head>
    <body>
      <div class="cover">
        <h1 style="font-family: sans-serif; margin-top: 100px; font-size: 14px; color: #777;">Generated by Bookgen.ai</h1>
        <p style="font-family: sans-serif; margin-top: 100px; font-size: 12px; color: #f00;">Caution: AI can make mistake </p>
      </div>


      <div class="page-break"></div>

      ${marked.parse(cleaned)}

      <script>
        document.addEventListener('DOMContentLoaded', () => {
          Prism.highlightAll();
        });
      </script>
    </body>
  </html>
  `;

  const browser = await puppeteer.launch({
    executablePath: await chromium.executablePath(),
    headless: chromium.headless,
    args: chromium.args,
  });

  const page = await browser.newPage();
  await page.setContent(html, { waitUntil: "networkidle0" });

  await page.pdf({
    path: outputPath,
    format: "A4",
    printBackground: true,
    displayHeaderFooter: true,
    footerTemplate: `
      <div class="footer" style="font-family: 'Inter', sans-serif; font-size: 10px; color: #999; text-align: center; width: 100%;">
        Page <span class="pageNumber"></span> of <span class="totalPages"></span>
      </div>
    `,
    headerTemplate: `<div style="font-size: 10px; text-align: center; width: 100%; color: #999;">
      bookgenai.vercel.app
    </div>`,
    margin: {
      top: "80px",
      bottom: "80px",
      left: "60px",
      right: "60px",
    },
  });

  await browser.close();
}


// === Main Function ===

export async function generateBookL(bookTopic, userId) {
  try {
    console.log(`📚 Generating LONG book for user: ${userId} with topic: ${bookTopic}`);

    // Unique conversation history per request
    let conversationHistory = [{
      role: "system",
      content:
        "You are Hailu, an expert writer and researcher. You specialize in writing long, comprehensive books with deep analysis. Each chapter should be at least 1000 words. Start with a very detailed Table of Contents."
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
      const filename = `${CHAPTER_PREFIX}-long-${userId}-${chapterNum}.txt`;
      saveToFile(filename, chapterText);
      return filename;
    }

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
      console.log(`📘 (LONG) Generating Chapter ${chapterNum}`);
      chapterFiles.push(await generateChapter(prompt, chapterNum));
    }

    const combinedContent = combineChapters(chapterFiles);

    const safeTopic = bookTopic.slice(0, 20).replace(/\s+/g, "_");
    const fileName = `output_long_${userId}_${safeTopic}.pdf`;
    const outputDir = path.join(__dirname, '../pdfs');
    if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir);

    const outputPath = path.join(outputDir, fileName);
    await generatePDF(combinedContent, outputPath);

    chapterFiles.forEach(deleteFile);

    console.log(`✅ Long book generation complete. Output: ${outputPath}`);
    return outputPath;

  } catch (error) {
    console.error('❌ Long book generation failed:', error);
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
