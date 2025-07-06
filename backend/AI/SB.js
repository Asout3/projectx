import { Together } from "together-ai";
import { marked } from 'marked';
import hljs from 'highlight.js';
import puppeteer from 'puppeteer-core';
import chromium from '@sparticuz/chromium';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import async from 'async';
import winston from 'winston';
import dotenv from 'dotenv';

// Load environment variables
dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Constants
const HISTORY_DIR = path.join(__dirname, 'history');
const CHAPTER_PREFIX = 'chapter';
const OUTPUT_DIR = path.join(__dirname, '../pdfs');
const COMBINED_FILE = 'combined-chapters.txt';

// Logger Setup
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [
    new winston.transports.File({ filename: 'bookgen.log' }),
    new winston.transports.Console()
  ]
});

// Ensure directories exist
if (!fs.existsSync(HISTORY_DIR)) fs.mkdirSync(HISTORY_DIR);
if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR);

// Init
const together = new Together({
  apiKey: process.env.TOGETHER_API_KEY || 'your-api-key-here', // Fallback for local testing
});

// Markdown & Code Highlighting
marked.setOptions({
  highlight: (code, lang) => {
    const validLang = hljs.getLanguage(lang) ? lang : 'plaintext';
    return hljs.highlight(code, { language: validLang }).value;
  }
});

// Per-user conversation history
const userHistories = new Map();

// === Utilities ===
function getHistoryFile(userId) {
  return path.join(HISTORY_DIR, `history-${userId}.json`);
}

function loadConversationHistory(userId) {
  const historyFile = getHistoryFile(userId);
  try {
    return JSON.parse(fs.readFileSync(historyFile, 'utf8'));
  } catch {
    logger.info(`No history found for user ${userId}. Starting fresh.`);
    return [];
  }
}

function saveConversationHistory(userId, history) {
  const trimmed = trimHistory(history);
  fs.writeFileSync(getHistoryFile(userId), JSON.stringify(trimmed, null, 2));
  logger.info(`Saved history for user ${userId}`);
}

function trimHistory(messages) {
  const tocMessage = messages.find(
    (msg) => msg.role === "assistant" && msg.content.toLowerCase().includes("table of contents")
  );
  return tocMessage ? [{
    role: "system",
    content:
      "Your name is Hailu. You are a kind, smart teacher explaining to a curious 10-year-old. Use simple, clear words, break down complex ideas step-by-step, and include human-like examples. Always start with a table of contents, then write chapters. Focus only on the requested topic, ignore unrelated contexts. Table of Contents:\n\n" +
      tocMessage.content,
  }] : [];
}

function saveToFile(filename, content) {
  fs.writeFileSync(filename, content);
  logger.info(`Saved: ${filename}`);
}

function deleteFile(filePath) {
  try {
    fs.unlinkSync(filePath);
    logger.info(`Deleted: ${filePath}`);
  } catch (err) {
    logger.error(`Error deleting ${filePath}: ${err.message}`);
  }
}

function combineChapters(files) {
  let combined = '';
  for (const file of files) {
    combined += fs.readFileSync(file, 'utf8') + '\n\n';
  }
  fs.writeFileSync(path.join(OUTPUT_DIR, COMBINED_FILE), combined);
  return combined;
}

// === AI ===
async function askAI(prompt, userId, bookTopic) {
  const history = userHistories.get(userId) || [];
  const trimmedHistory = trimHistory(history);
  const messages = [...trimmedHistory, { role: 'user', content: prompt }];

  try {
    const response = await together.chat.completions.create({
      messages,
      model: "deepseek-ai/DeepSeek-R1-Distill-Llama-70B-free",
      max_tokens: 3000,
      temperature: 0.6,
    });

    let reply = response.choices[0].message.content
      .replace(/<think>[\s\S]*?<\/think>/gi, '')
      .replace(/^I'm DeepSeek-R1.*?help you\.\s*/i, '')
      .trim();

    // Validate output relevance
    if (!reply.toLowerCase().includes(bookTopic.toLowerCase().replace(/\s+/g, ''))) {
      logger.warn(`Irrelevant output for ${userId}: ${reply.slice(0, 50)}...`);
      throw new Error(`Output does not match topic: ${bookTopic}`);
    }

    history.push({ role: 'user', content: prompt });
    history.push({ role: 'assistant', content: reply });
    userHistories.set(userId, history);
    saveConversationHistory(userId, history);

    return reply;
  } catch (error) {
    logger.error(`AI request failed for ${userId}: ${error.message}`);
    throw error;
  }
}

// === Chapter ===
async function generateChapter(prompt, chapterNum, userId, bookTopic) {
  const chapterText = await askAI(prompt, userId, bookTopic);
  const filename = path.join(OUTPUT_DIR, `${CHAPTER_PREFIX}-${userId}-${chapterNum}.txt`);
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
    .replace(/\[\s*(.*?)\s*\]/gs, (_, math) => `\\(${math}\\)`)
    .replace(/\(\s*(.*?)\s*\)/gs, (_, math) => `\\(${math}\\)`)

    .replace(
      /([a-zA-Z0-9]+)\s*\^\s*([a-zA-Z0-9]+)/g,
      (_, base, exp) => `\\(${base}^{${exp}}\\)`,
    )

    .replace(
      /(?<!\\)(?<!\w)(\d+)\s*\/\s*(\d+)(?!\w)/g,
      (_, num, den) => `\\(\\frac{${num}}{${den}}\\)`,
    );

  content = content.replace(/__LINK__(\d+)__/g, (_, i) => links[i]);
  return content;
}

function cleanUpAIText(text) {
  return text
    .replace(/^(?:[-=_~\s]{5,})$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/\n\s*$/g, "")
    .replace(/[\u2013\u2014]/g, "-")
    .trim();
}

async function generatePDF(content, outputPath) {
  const cleaned = cleanUpAIText(content);

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
      <බ

      <script src="https://cdn.jsdelivr.net/npm/prismjs@1.29.0/components/prism-python.min.js"></script>
      <script src="https://cdn.jsdelivr.net/npm/prismjs@1.29.0/components/prism-java.min.js"></script>
      <script src="https://cdn.jsdelivr.net/npm/prismjs@1.29.0/components/prism-cpp.min.js"></script>
      <link href="https://cdn.jsdelivr.net/npm/prismjs@1.29.0/themes/prism.min.css" rel="stylesheet">
      <style>
        @page { margin: 80px 60px; }
        body { font-family: 'Inter', 'Segoe UI', 'Helvetica Neue', sans-serif; font-size: 13.5px; line-height: 1.7; color: #1a1a1a; background: white; margin: 0; padding: 0; text-align: justify; }
        .cover { text-align: center; margin-top: 200px; }
        .cover h1 { font-size: 36px; font-weight: 700; margin-bottom: 0.2em; }
        .cover h2 { font-size: 20px; font-weight: 400; color: #555; }
        .page-break { page-break-before: always; }
        h1, h2, h3 { font-weight: 600; color: #2c3e50; margin-top: 2em; margin-bottom: 0.4em; }
        h1 { font-size: 24px; border-bottom: 2px solid #e0e0e0; padding-bottom: 5px; }
        h2 { font-size: 20px; border-bottom: 1px solid #e0e0e0; padding-bottom: 3px; }
        h3 { font-size: 16px; }
        p { margin: 0 0 1em 0; }
        a { color: #007acc; text-decoration: underline; }
        code, pre { font-family: 'Fira Code', monospace; border-radius: 6px; font-size: 13px; }
        code { background: #f4f4f4; padding: 3px 8px; border: 1px solid #e0e0e0; }
        pre { background: #f8f9fa; padding: 20px; overflow-x: auto; border: 1px solid #e0e0e0; line-height: 1.5; margin: 1.2em 0; white-space: pre-wrap; word-wrap: break-word; overflow-x: hidden; }
        pre code { background: none; border: none; padding: 0; }
        blockquote { border-left: 4px solid #007acc; margin: 1.5em 0; padding: 0.5em 0 0.5em 1.5em; background: #f8f9fa; color: #2c3e50; font-style: italic; border-radius: 4px; }
        hr { border: none; border-top: 1px solid #e0e0e0; margin: 2em 0; }
        .footer { font-size: 10px; text-align: center; width: 100%; color: #999; }
        .example { background: #f8f9fa; border-left: 4px solid #007acc; padding: 15px 20px; margin: 1.5em 0; border-radius: 4px; font-style: italic; }
        .toc { page-break-after: always; margin: 2em 0; padding: 1em; background: #f8f9fa; border-radius: 6px; }
        .toc h2 { font-size: 20px; border-bottom: 1px solid #e0e0e0; margin-bottom: 1em; }
        .toc ul { list-style: none; padding: 0; }
        .toc li { margin: 0.5em 0; }
        .toc a { text-decoration: none; color: #007acc; }
        .toc a:hover { text-decoration: underline; }
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

  try {
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
      margin: { top: "80px", bottom: "80px", left: "60px", right: "60px" },
    });
    await browser.close();
    logger.info(`Generated PDF: ${outputPath}`);
  } catch (error) {
    logger.error(`PDF generation failed: ${error.message}`);
    throw error;
  }
}

// === Prompt Generator ===
function generatePrompts(bookTopic) {
  return [
    // Table of Contents
    `As Hailu, create a table of contents for a book about "${bookTopic}" for someone with no prior knowledge. The book must have 5 chapters, each covering a unique aspect of ${bookTopic} (e.g., for trading bots: what they are, how they work, strategies, risks, tools). Each chapter must be at least 400 words and written in a fun, simple, friendly tone, like explaining to a curious 10-year-old. Use clear, descriptive chapter titles and include 2–3 subtopics per chapter (e.g., "What is a trading bot?" or "How do trading bots make decisions?"). Output only the table of contents as a numbered list with chapter titles and subtopics. Ensure topics are distinct, avoid overlap, and focus strictly on ${bookTopic}. If ${bookTopic} is unclear, suggest relevant subtopics and explain why. Ignore any unrelated topics like space or previous requests.`,

    // Chapter 1
    `As Hailu, write Chapter 1 of the book about "${bookTopic}", based on the table of contents you created. Focus only on the first chapter's topic and subtopics. Use a fun, simple, friendly tone, like explaining to a curious 10-year-old. Break down complex ideas into clear steps with vivid examples (e.g., for trading bots, compare them to a robot chef following a recipe) and at least one analogy per subtopic. Include a description of a diagram or table (e.g., "a diagram showing how a trading bot works") to aid understanding. Use clear headings for each subtopic. Write at least 400 words, avoid copyrighted material, ensure accuracy, and focus only on ${bookTopic}. If information is limited, explain in simple terms and note limitations. Do not include the table of contents, other chapters, or unrelated topics like space.`,

    // Chapter 2
    `As Hailu, write Chapter 2 of the book about "${bookTopic}", based on the table of contents you created. Focus only on the second chapter's topic and subtopics. Use a fun, simple, friendly tone, like explaining to a curious 10-year-old. Break down complex ideas into clear steps with vivid examples (e.g., for trading bots, compare strategies to game plans in sports) and at least one analogy per subtopic. Include a description of a diagram or table (e.g., "a table listing trading bot strategies") to aid understanding. Use clear headings for each subtopic. Write at least 400 words, avoid copyrighted material, ensure accuracy, and focus only on ${bookTopic}. If information is limited, explain in simple terms and note limitations. Do not include the table of contents, other chapters, or unrelated topics like space.`,

    // Chapter 3
    `As Hailu, write Chapter 3 of the book about "${bookTopic}", based on the table of contents you created. Focus only on the third chapter's topic and subtopics. Use a fun, simple, friendly tone, like explaining to a curious 10-year-old. Break down complex ideas into clear steps with vivid examples (e.g., for trading bots, compare risks to crossing a busy street) and at least one analogy per subtopic. Include a description of a diagram or table (e.g., "a diagram of trading bot risks") to aid understanding. Use clear headings for each subtopic. Write at least 400 words, avoid copyrighted material, ensure accuracy, and focus only on ${bookTopic}. If information is limited, explain in simple terms and note limitations. Do not include the table of contents, other chapters, or unrelated topics like space.`,

    // Chapter 4
    `As Hailu, write Chapter 4 of the book about "${bookTopic}", based on the table of contents you created. Focus only on the fourth chapter's topic and subtopics. Use a fun, simple, friendly tone, like explaining to a curious 10-year-old. Break down complex ideas into clear steps with vivid examples (e.g., for trading bots, compare tools to a toolbox) and at least one analogy per subtopic. Include a description of a diagram or table (e.g., "a table of trading bot tools") to aid understanding. Use clear headings for each subtopic. Write at least 400 words, avoid copyrighted material, ensure accuracy, and focus only on ${bookTopic}. If information is limited, explain in simple terms and note limitations. Do not include the table of contents, other chapters, or unrelated topics like space.`,

    // Chapter 5
    `As Hailu, write Chapter 5 of the book about "${bookTopic}", based on the table of contents you created. Focus only on the fifth chapter's topic and subtopics. Use a fun, simple, friendly tone, like explaining to a curious 10-year-old. Break down complex ideas into clear steps with vivid examples (e.g., for trading bots, compare building one to assembling a toy) and at least one analogy per subtopic. Include a description of a diagram or table (e.g., "a flowchart for building a trading bot") to aid understanding. Use clear headings for each subtopic. Write at least 400 words, avoid copyrighted material, ensure accuracy, and focus only on ${bookTopic}. If information is limited, explain in simple terms and note limitations. Do not include the table of contents, other chapters, or unrelated topics like space.`,

    // Conclusion and References
    `As Hailu, write the conclusion and references for the book about "${bookTopic}", based on the table of contents and chapters you created. Use a fun, simple, friendly tone, like explaining to a curious 10-year-old. In the conclusion (200–300 words), summarize the key ideas from all 5 chapters and inspire the reader to learn more about ${bookTopic}. In the references section, provide 3–5 reliable, beginner-friendly resources (e.g., for trading bots: Investopedia, Python libraries, or educational videos) with a 1–2 sentence description each. Use clear headings ("Conclusion" and "References"). Avoid copyrighted material, ensure resources are accessible and appropriate for beginners, and focus only on ${bookTopic}. If resources are limited, suggest general learning platforms and explain why. Do not include the table of contents, chapter content, or unrelated topics like space.`
  ];
}

// === Task Queue ===
const bookQueue = async.queue(async (task, callback) => {
  try {
    const { bookTopic, userId } = task;
    await generateBookS(bookTopic, userId);
    callback();
  } catch (error) {
    callback(error);
  }
}, 1); // Process one book at a time

// === Master Function ===
export async function generateBookS(bookTopic, userId) {
  const safeUserId = `${userId}-${bookTopic.replace(/\s+/g, '_').toLowerCase()}`; // Unique ID per user and topic
  logger.info(`Starting book generation for user: ${safeUserId}, topic: ${bookTopic}`);

  try {
    // Initialize fresh history for this user and topic
    userHistories.set(safeUserId, [{
      role: "system",
      content:
        "Your name is Hailu. You are a kind, smart teacher explaining to a curious 10-year-old. Use simple, clear words, break down complex ideas step-by-step, and include human-like examples. Always start with a table of contents, then write chapters. Focus only on the requested topic, ignore unrelated contexts."
    }]);

    const prompts = generatePrompts(bookTopic);
    const chapterFiles = [];

    for (const [index, prompt] of prompts.entries()) {
      const chapterNum = index + 1;
      logger.info(`Generating Chapter ${chapterNum} for ${bookTopic}`);
      try {
        const chapterFile = await generateChapter(prompt, chapterNum, safeUserId, bookTopic);
        chapterFiles.push(chapterFile);
      } catch (error) {
        logger.error(`Failed to generate Chapter ${chapterNum}: ${error.message}`);
        throw new Error(`Chapter ${chapterNum} generation failed`);
      }
    }

    const combinedContent = combineChapters(chapterFiles);

    const safeTopic = bookTopic.slice(0, 20).replace(/\s+/g, "_");
    const fileName = `output_${safeUserId}_${safeTopic}.pdf`;
    const outputPath = path.join(OUTPUT_DIR, fileName);
    await generatePDF(combinedContent, outputPath);

    chapterFiles.forEach(deleteFile);
    userHistories.delete(safeUserId); // Clean up history

    logger.info(`Book generation complete. Output: ${outputPath}`);
    return outputPath;
  } catch (error) {
    logger.error(`Book generation failed for ${safeUserId}: ${error.message}`);
    throw error;
  }
}

// === API Wrapper ===
export function queueBookGeneration(bookTopic, userId) {
  return new Promise((resolve, reject) => {
    bookQueue.push({ bookTopic, userId }, (error, result) => {
      if (error) {
        logger.error(`Queue failed for ${userId}: ${error.message}`);
        reject(error);
      } else {
        resolve(result);
      }
    });
  });
}
