// File: AI/ai.js

import { Together } from "together-ai";
import { marked } from 'marked';
import pdf from 'html-pdf';
import fs from 'fs';
import path from 'path';

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
    console.log(` Deleted: ${filePath}`);
  } catch (err) {
    console.error(` Error deleting ${filePath}:`, err);
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
    max_tokens: 4000,
    temperature: 0.7,
  });

  let reply = response.choices[0].message.content;
  reply = reply.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  reply = reply.replace(/^I'm DeepSeek-R1.*?help you\.\s*/i, '').trim();

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

// === PDF Generator ===
async function generatePDF(content, outputPath) {
  const html = `<html><body>${marked.parse(content)}</body></html>`;
  return new Promise((resolve, reject) => {
    pdf.create(html, { format: 'A4' }).toFile(outputPath, (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

// === Main Function ===
export async function generateBook(bookTopic) {
  try {
    conversationHistory = [{
      role: "system",
      content:
        "You are Hailu, an expert writer and researcher. You specialize in creating detailed, well-structured and very explanatory books with at least 400 words per subtopic. Make sure you explain every single detail before moving to the next one. Always begin with a Table of Contents."
    }];

    const prompts = [
      `[User Request]: ${bookTopic}\n\nAs Hailu, please create a table of contents for the book. Include 4 chapters with 400+ words per subtopic.`,
      "Now write Chapter 1 in detail.",
      "Now write Chapter 2 in detail. okay does this really run  ",
      "Now write Chapter 3 in detail.",
      "Now write Chapter 4 in detail.",
      "Now conclude the book and provide references and additional resources."
    ];

    const chapterFiles = [];
    for (const [index, prompt] of prompts.entries()) {
      const chapterNum = index + 1;
      console.log(`\n Generating Chapter ${chapterNum}`);
      chapterFiles.push(await generateChapter(prompt, chapterNum));
    }

    const combinedContent = combineChapters(chapterFiles);
    await generatePDF(combinedContent, OUTPUT_PDF);

    // Optional Cleanup
    chapterFiles.forEach(deleteFile);

    console.log(`\n Book generation complete. Output: ${OUTPUT_PDF}`);
    return OUTPUT_PDF;
  } catch (error) {
    console.error(' Book generation failed:', error);
    throw error;
  }
}
