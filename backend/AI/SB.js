// === FILE: bookgen.js ===

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

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const HISTORY_DIR = path.join(__dirname, 'history');
const CHAPTER_PREFIX = 'chapter';
const OUTPUT_DIR = path.join(__dirname, '../pdfs');
const COMBINED_FILE = 'combined-chapters.txt';

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

if (!fs.existsSync(HISTORY_DIR)) fs.mkdirSync(HISTORY_DIR);
if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR);

const together = new Together({
  apiKey: '18a96a823e402ef5dfedc1e372bf50fc8e6357bb25a0eff0bea25a07f51a1087',
});

marked.setOptions({
  highlight: (code, lang) => {
    const validLang = hljs.getLanguage(lang) ? lang : 'plaintext';
    return hljs.highlight(code, { language: validLang }).value;
  }
});

const userHistories = new Map();

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
    content: "Your name is Hailu. You are a kind, smart teacher explaining to a curious kid...\n\n" + tocMessage.content
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

async function askAI(prompt, userId, bookTopic) {
  const history = userHistories.get(userId) || [];
  const trimmedHistory = trimHistory(history);
  const messages = [...trimmedHistory, { role: 'user', content: prompt }];

  const response = await together.chat.completions.create({
    messages,
    model: "deepseek-ai/DeepSeek-R1-Distill-Llama-70B-free",
    top_p: 0.9,
    temperature: 0.6,
    presence_penalty: 0.3,
    frequency_penalty: 0.3,
    max_tokens: 3000
  });

  let reply = response.choices[0].message.content
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/^I'm DeepSeek-R1.*?help you\.\s*/i, '')
    .trim();

  const topicWords = bookTopic.toLowerCase().split(/\s+/);
  const isRelevant = topicWords.some(word => reply.toLowerCase().includes(word));
  if (!isRelevant) throw new Error(`Output not relevant to topic: ${bookTopic}`);

  history.push({ role: 'user', content: prompt });
  history.push({ role: 'assistant', content: reply });
  userHistories.set(userId, history);
  saveConversationHistory(userId, history);

  return reply;
}

async function generateChapter(prompt, chapterNum, userId, bookTopic) {
  const chapterText = await askAI(prompt, userId, bookTopic);
  const filename = path.join(OUTPUT_DIR, `${CHAPTER_PREFIX}-${userId}-${chapterNum}.txt`);
  saveToFile(filename, chapterText);
  return filename;
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
  const html = `<!DOCTYPE html><html><head><meta charset='utf-8'><script src='https://cdn.jsdelivr.net/npm/mathjax@3/es5/tex-mml-chtml.js'></script><link rel='stylesheet' href='https://cdn.jsdelivr.net/npm/prismjs@1.29.0/themes/prism.min.css'></head><body>${marked.parse(cleaned)}</body></html>`;

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
    footerTemplate: `<div style='font-size:10px; text-align:center; width:100%'>Page <span class='pageNumber'></span> of <span class='totalPages'></span></div>`,
    headerTemplate: `<div style='font-size:10px; text-align:center; width:100%'>bookgenai.vercel.app</div>`,
    margin: { top: "80px", bottom: "80px", left: "60px", right: "60px" },
  });
  await browser.close();
  logger.info(`Generated PDF: ${outputPath}`);
}

function generatePrompts(bookTopic) {
  const prefix = `As Hailu, explain "${bookTopic}" to a curious 16-year-old. Focus only on CHAPTER_NUMBER. Write clearly.`;
  return [
    `As Hailu, create a Table of Contents for a book about "${bookTopic}" with 5 chapters and 2-3 subtopics per chapter.`,
    ...Array.from({ length: 5 }, (_, i) => `${prefix.replace('CHAPTER_NUMBER', `Chapter ${i + 1}`)}`),
    `As Hailu, write a Conclusion and References for the book about "${bookTopic}".`
  ];
}

const bookQueue = async.queue(async (task, callback) => {
  try {
    const { bookTopic, userId } = task;
    await generateBookS(bookTopic, userId);
    callback();
  } catch (error) {
    callback(error);
  }
}, 1);

export async function generateBookS(bookTopic, userId) {
  const safeUserId = `${userId}-${bookTopic.replace(/\s+/g, '_').toLowerCase()}`;
  userHistories.set(safeUserId, [{
    role: "system",
    content: "Your name is Hailu. You're a kind teacher explaining clearly."
  }]);

  const prompts = generatePrompts(bookTopic);
  const chapterFiles = [];

  for (const [index, prompt] of prompts.entries()) {
    const chapterNum = index + 1;
    const chapterFile = await generateChapter(prompt, chapterNum, safeUserId, bookTopic);
    chapterFiles.push(chapterFile);
  }

  const combinedContent = combineChapters(chapterFiles);
  const safeTopic = bookTopic.slice(0, 20).replace(/\s+/g, "_");
  const fileName = `output_${safeUserId}_${safeTopic}.pdf`;
  const outputPath = path.join(OUTPUT_DIR, fileName);
  await generatePDF(combinedContent, outputPath);

  chapterFiles.forEach(deleteFile);
  userHistories.delete(safeUserId);

  return outputPath;
}

export function queueBookGeneration(bookTopic, userId) {
  return new Promise((resolve, reject) => {
    bookQueue.push({ bookTopic, userId }, (error, result) => {
      if (error) reject(error);
      else resolve(result);
    });
  });
}
