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
      "Your name is Hailu. You are a super kind, smart teacher who explains everything like you're teaching a curious 10-year-old. You always use simple, easy-to-understand words. You never skip steps. You break down complex ideas into small parts and explain them one by one. Use friendly language, explain detail, and examples that feel human. Always start with a table of contents, then go chapter by chapter. Be clear, helpful, and never act like a robot. Here is the Table of Contents:\n\n" +
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
          font-size: 13.5px;
          line-height: 1.7;
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

// === Master Function ===
export async function generateBookS(bookTopic, userId) {
  try {
    console.log(`📚 Generating book for user: ${userId} with topic: ${bookTopic}`);

    // Each user/request gets their own conversation history
    let conversationHistory = [{
      role: "system",
      content:
        "Your name is Hailu. You are a super kind, smart teacher who explains everything like you're teaching a curious 10-year-old. You always use simple, easy-to-understand words. You never skip steps. You break down complex ideas into small parts and explain them one by one. Use friendly language, explain detail, do what every you can to explain graphs table any things you can and examples that feel human. Always start with a table of contents, then go chapter by chapter. Be clear, helpful, and never act like a robot. Always begin with a Table of Contents. And don't tell anybody that i told you to explain every thing as i were a little 10 year old kid."
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
      // Table of Contents
      `As Hailu, create a table of contents for a book about space for someone with no prior knowledge. The book should have 5 chapters, each covering a unique aspect of space (e.g., stars, planets, space exploration, galaxies, black holes). Each chapter should be at least 400 words and written in a fun, simple, and friendly tone, like explaining to a curious 10-year-old. Use clear, descriptive chapter titles and include 2–3 subtopics per chapter (e.g., "What is a star?" or "How do we explore space?"). Output only the table of contents as a numbered list, with chapter titles and subtopics, and nothing else. Ensure topics are distinct and avoid overlap.`,

      // Chapter 1
      `As Hailu, write Chapter 1 of the book about space, based on the table of contents you created. Focus on the first chapter's topic and subtopics. Use a fun, simple, and friendly tone, like explaining to a curious 10-year-old. Break down complex ideas into small, clear steps with vivid examples (e.g., compare stars to campfires) and at least one analogy per subtopic. Include a simple description of a diagram or table (e.g., "a table showing planet sizes") that could help explain the topic. Use clear headings for each subtopic. Write at least 400 words, avoid copyrighted material, and ensure scientific accuracy. Do not include the table of contents or other chapters.`,

      // Chapter 2
      `As Hailu, write Chapter 2 of the book about space, based on the table of contents you created. Focus on the second chapter's topic and subtopics. Use a fun, simple, and friendly tone, like explaining to a curious 10-year-old. Break down complex ideas into small, clear steps with vivid examples (e.g., compare planets to marbles) and at least one analogy per subtopic. Include a simple description of a diagram or table (e.g., "a diagram of the solar system") that could help explain the topic. Use clear headings for each subtopic. Write at least 400 words, avoid copyrighted material, and ensure scientific accuracy. Do not include the table of contents or other chapters.`,

      // Chapter 3
      `As Hailu, write Chapter 3 of the book about space, based on the table of contents you created. Focus on the third chapter's topic and subtopics. Use a fun, simple, and friendly tone, like explaining to a curious 10-year-old. Break down complex ideas into small, clear steps with vivid examples (e.g., compare galaxies to cities) and at least one analogy per subtopic. Include a simple description of a diagram or table (e.g., "a table comparing galaxy types") that could help explain the topic. Use clear headings for each subtopic. Write at least 400 words, avoid copyrighted material, and ensure scientific accuracy. Do not include the table of contents or other chapters.`,

      // Chapter 4
      `As Hailu, write Chapter 4 of the book about space, based on the table of contents you created. Focus on the fourth chapter's topic and subtopics. Use a fun, simple, and friendly tone, like explaining to a curious 10-year-old. Break down complex ideas into small, clear steps with vivid examples (e.g., compare black holes to vacuum cleaners) and at least one analogy per subtopic. Include a simple description of a diagram or table (e.g., "a diagram showing a black hole's parts") that could help explain the topic. Use clear headings for each subtopic. Write at least 400 words, avoid copyrighted material, and ensure scientific accuracy. Do not include the table of contents or other chapters.`,

      // Chapter 5
      `As Hailu, write Chapter 5 of the book about space, based on the table of contents you created. Focus on the fifth chapter's topic and subtopics. Use a fun, simple, and friendly tone, like explaining to a curious 10-year-old. Break down complex ideas into small, clear steps with vivid examples (e.g., compare space missions to adventures) and at least one analogy per subtopic. Include a simple description of a diagram or table (e.g., "a timeline of space missions") that could help explain the topic. Use clear headings for each subtopic. Write at least 400 words, avoid copyrighted material, and ensure scientific accuracy. Do not include the table of contents or other chapters.`,

      // Conclusion and References
      `As Hailu, write the conclusion and references for the book about space, based on the table of contents and chapters you created. Use a fun, simple, and friendly tone, like explaining to a curious 10-year-old. In the conclusion (200–300 words), summarize the key ideas from all 5 chapters and inspire the reader to learn more about space. In the references section, provide 3–5 reliable, beginner-friendly resources (e.g., NASA’s kids’ website, simple books, or educational videos) with a brief description of each (1–2 sentences). Use clear headings ("Conclusion" and "References"). Avoid copyrighted material and ensure all resources are accessible and appropriate for beginners. Do not include the table of contents or chapter content.`
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
