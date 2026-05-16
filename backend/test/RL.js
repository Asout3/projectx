import { Together } from "together-ai";
import { marked } from 'marked';
import hljs from 'highlight.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import async from 'async';
import winston from 'winston';
import dotenv from 'dotenv';
import { renderHtmlToPdf } from '../utils/pdfRenderer.js';
import { normalizeMathMarkdown } from '../utils/documentQuality.js';

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

// AI Client
let together = null;
function ensureTogether() {
  if (together) return together;
  const apiKey = process.env.TOGETHER_API_KEY;
  if (!apiKey) {
    throw new Error('TOGETHER_API_KEY is not set in environment.');
  }
  together = new Together({ apiKey });
  return together;
}

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
      "You are Hailu, a thoughtful and intelligent researcher who explains complex topics in a clear, honest, and human way. Your job is to write high-quality research content that sounds natural, informative, and grounded in real facts. You always speak with clarity and structure, using examples, analogies, and step-by-step explanations when needed. Avoid generic or vague content. Focus on depth, real-world relevance, and clear logic. If a detail is speculative or fictional, clearly label it as such. Always stay on-topic. \n\n" + tocMessage.content,

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
    const response = await ensureTogether().chat.completions.create({
      messages,
      model: "meta-llama/Llama-3.3-70B-Instruct-Turbo-Free",
      top_p: 0.9,                 // balance of creativity and clarity
      temperature: 0.6,           // keeps things focused but still human
      presence_penalty: 0.3,      // allows gentle repetition where helpful
      frequency_penalty: 0.3,     // avoids word echo
      max_tokens: 3000            // allows long, complete chapter-style answers
    });

    let reply = response.choices[0].message.content
      .replace(/<think>[\s\S]*?<\/think>/gi, '')
      .replace(/^I'm DeepSeek-R1.*?help you\.\s*/i, '')
      .trim();

    // ✅ Flexible topic validation (word-based match)
    const topicWords = bookTopic.toLowerCase().split(/\s+/);
    const isRelevant = topicWords.some(word => reply.toLowerCase().includes(word));

    if (!isRelevant) {
      logger.warn(`🛑 Irrelevant output detected for [${userId}] on topic "${bookTopic}": ${reply.slice(0, 80)}...`);
      throw new Error(`Output does not appear relevant to topic: "${bookTopic}"`);
    }

    history.push({ role: 'user', content: prompt });
    history.push({ role: 'assistant', content: reply });
    userHistories.set(userId, history);
    saveConversationHistory(userId, history);

    logger.info(`✅ Valid AI response saved for [${userId}] on topic "${bookTopic}"`);
    return reply;

  } catch (error) {
    logger.error(`❌ AI request failed for [${userId}] on topic "${bookTopic}": ${error.message}`);
    throw error;
  }
}


// === Chapter ===
async function generateChapter(prompt, chapterNum, userId, bookTopic) {
  const history = userHistories.get(userId) || [];
  const tocMessage = history.find(
    (msg) => msg.role === 'assistant' && msg.content.toLowerCase().includes('chapter 1')
  );

  const toc = history.find(
    (msg) => msg.role === 'assistant' && msg.content.toLowerCase().includes('table of contents')
  );

  const modifiedPrompt = toc
    ? `${prompt}\n\nRefer to this Table of Contents:\n\n${toc.content}`
    : prompt;

  const chapterText = await askAI(modifiedPrompt, userId, bookTopic);
  const filename = path.join(OUTPUT_DIR, `${CHAPTER_PREFIX}-${userId}-${chapterNum}.txt`);
  saveToFile(filename, chapterText);
  return filename;
}


// === Formatter ===
function formatMath(content) {
  return normalizeMathMarkdown(content);
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
  const cleaned = cleanUpAIText(formatMath(String(content)));
  const html = `
  <html>
    <head>
      <meta charset="utf-8">
      <title>Research Paper</title>
      <script>
        window.MathJax = {
          tex: { inlineMath: [['$', '$'], ['\\(', '\\)']], displayMath: [['$$', '$$'], ['\\[', '\\]']] },
          svg: { fontCache: 'global' }
        };
      </script>
      <script type="text/javascript" id="MathJax-script" async src="https://cdn.jsdelivr.net/npm/mathjax@3/es5/tex-mml-chtml.js"></script>
      <script src="https://cdn.jsdelivr.net/npm/prismjs@1.29.0/prism.min.js"></script>
      <script src="https://cdn.jsdelivr.net/npm/prismjs@1.29.0/components/prism-javascript.min.js"></script>
      <script src="https://cdn.jsdelivr.net/npm/prismjs@1.29.0/components/prism-python.min.js"></script>
      <link href="https://cdn.jsdelivr.net/npm/prismjs@1.29.0/themes/prism.min.css" rel="stylesheet">
      <style>
        @page { margin: 80px 60px; size: A4; }
        body { font-family: Georgia, 'Times New Roman', serif; font-size: 14px; line-height: 1.7; color: #222; margin: 0; padding: 0; text-align: justify; }
        h1, h2, h3 { margin-top: 2em; margin-bottom: 0.7em; color: #1f2937; }
        h1 { font-size: 26px; border-bottom: 2px solid #d1d5db; padding-bottom: 8px; page-break-before: always; }
        h2 { font-size: 21px; }
        h3 { font-size: 17px; }
        p { margin: 0 0 1em 0; }
        pre { background: #f8fafc; padding: 16px; border-radius: 8px; border: 1px solid #e5e7eb; overflow-x: auto; white-space: pre-wrap; word-wrap: break-word; }
        code { background: #f3f4f6; padding: 2px 6px; border-radius: 4px; }
        pre code { background: transparent; padding: 0; }
        table { border-collapse: collapse; width: 100%; margin: 1.5em 0; page-break-inside: avoid; }
        th, td { border: 1px solid #d1d5db; padding: 8px; text-align: left; }
        th { background: #f3f4f6; }
        blockquote { border-left: 4px solid #64748b; margin: 1.5em 0; padding: 0.8em 1.2em; background: #f8fafc; }
      </style>
    </head>
    <body>
      ${marked.parse(cleaned)}
    </body>
  </html>`;

  await renderHtmlToPdf(html, outputPath, {
    margin: { top: '80px', bottom: '80px', left: '60px', right: '60px' },
    headerTemplate: '<div style="font-size:10px;text-align:center;width:100%;color:#6b7280;">Generated by Bookgen.ai</div>',
    footerTemplate: '<div style="font-size:10px;text-align:center;width:100%;color:#6b7280;">Page <span class="pageNumber"></span> of <span class="totalPages"></span></div>'
  });
}

// === Prompt Generator ===
function generatePrompts(bookTopic) {
  return [
    // Title & Abstract
`As Hailu, write a research paper title and abstract about "${bookTopic}". 
- Start with a strong, clear, and catchy title that sounds professional.
- Then, write a 200-word abstract using markdown headers: "# Title" and "# Abstract".
- The abstract should briefly cover:
   - What the paper is about
   - Why this topic matters
   - How the research was done
   - What was found or argued
   - Why the reader should care
- Use clear, confident language that sounds like a real person explaining it to someone smart but new to the topic.
Stop after the abstract.`,
    
    
    // Introduction
`As Hailu, write a strong and clear introduction for a research paper on "${bookTopic}" (around 600 words).
- Use markdown headers: "## Background", "## Purpose", and "## Importance".
- In the **Background**, explain the topic and recent context.
- In the **Purpose**, describe what this paper will explore or prove.
- In **Importance**, explain why it matters globally or socially.
- Use real-world examples, vivid scenarios, or short analogies to make your points memorable.
- Your tone should be professional, clear, and grounded—not robotic or generic.
Stop after the introduction.`,
    
    // Methodology
`As Hailu, write the methodology section of a research paper on "${bookTopic}" using markdown headers.
- Use: "## Data Collection", "## Analysis", and (if needed) "## Tools Used".
- Clearly explain **how information was gathered** — use realistic sources like interviews, surveys, reports, news content, etc. If fictional examples are used, say so clearly.
- Then explain **how it was analyzed** — e.g., text analysis, comparison methods, social media scraping, or expert review.
- Keep the language simple but informative, like a smart person explaining to a curious student.
Stop after the methodology.`,

    // Findings
`As Hailu, write the findings section for a research paper on "${bookTopic}".
- Use markdown headers like "## Key Observations", "## Notable Examples", or "## Data Highlights".
- Present what was discovered—either from analysis, data, or observed behavior.
- Use tables, bullet points, or charts (written out) if helpful.
- Keep the tone neutral and factual—don’t interpret results yet.
- Avoid repeating the introduction or methodology.
Stop after the findings.`,

    // Discussion
`As Hailu, write the discussion section for the research paper on "${bookTopic}".
- Use markdown headers: "## Interpretation", "## Implications", and "## Limitations".
- In **Interpretation**, explain what the findings mean and what patterns or truths they suggest.
- In **Implications**, explain what this means for society, politics, or individuals.
- In **Limitations**, admit what wasn't perfect or still needs to be explored.
- Avoid summarizing the whole paper again—this is for thinking deeper, not repeating.
Stop after the discussion.`,
    
    // Conclusion
`As Hailu, write a clear and inspiring conclusion (around 300 words) for a research paper on "${bookTopic}".
- Use the markdown header "## Conclusion".
- Summarize the key takeaways simply and clearly.
- End with a thought about what should happen next: more research, education, action, or caution.
- Your tone should feel hopeful, grounded, and slightly personal—as if you're speaking to a curious young reader.
Stop after the conclusion.`,

    // References
`As Hailu, write the references section for a research paper on "${bookTopic}".
- Use the markdown header "## References".
- List at least 5 relevant and reliable resources.
- For each, include:
   - Title
   - Link (if available)
   - A 1–2 sentence explanation of what it offers and why it’s useful.
- Only use simple, beginner-friendly sources: articles, websites, and readable research—not technical PDFs or deep academic journals.
Stop after the references.`
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
//generateResearchPaperLongg
export async function generateResearchPaperLongg(bookTopic, userId) {
  const safeUserId = `${userId}-${bookTopic.replace(/\s+/g, '_').toLowerCase()}`; // Unique ID per user and topic
  logger.info(`Starting book generation for user: ${safeUserId}, topic: ${bookTopic}`);

  try {
    global.cancelFlags = global.cancelFlags || {}; // ✅ Make sure global flag object exists

    // Initialize fresh history for this user and topic
    userHistories.set(safeUserId, [{
      role: "system",
      content:
        "Your name is Hailu. You are a kind, brilliant researcher and teacher explaining to a curious person with no background knowledge. Your goal is to create the best, most well-structured research paper possible. Use simple, clear words. Break down complex ideas step-by-step, and include relatable examples."
    }]);

    const prompts = generatePrompts(bookTopic);
    const chapterFiles = [];

    for (const [index, prompt] of prompts.entries()) {
      // ✅ Check for cancellation before each chapter
      if (global.cancelFlags?.[userId]) {
        delete global.cancelFlags[userId];
        logger.warn(`❌ Book generation cancelled for user: ${userId}`);
        throw new Error('Generation cancelled');
      }

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















 // `As Hailu, you are going to follow this instruction that I will give you. Write a 600-word introduction for a research paper on "${bookTopic}". Explain what it is, why it's important, and what the paper will explore. Use markdown with sections like "## Background", "## Purpose", and "## Importance". Use a simple tone, clear structure, and give an example or story if needed. After you finish the introduction, stop responding.`,

 //    // Methodology
 //    `As Hailu, write the methodology section of a research paper about "${bookTopic}". Use markdown headers like "## Data Collection" and "## Analysis". Explain in simple terms how the data or information was gathered and how it was analyzed. Keep the tone friendly and clear. Use examples or imaginary steps if needed to make it understandable. Do not talk about results or other sections. Stop responding after the methodology.`,

 //    // Findings
 //    `As Hailu, write the findings section for a research paper about "${bookTopic}". Share what was discovered, observed, or noticed. Use markdown headings to organize the content clearly. Use simple examples or even a small fictional table or diagram to help explain the findings. Focus only on the results, not the interpretation. Keep the tone clear, simple, and helpful. Stop after the findings.`,

 //    // Discussion
 //    `As Hailu, write the discussion section of a research paper about "${bookTopic}". Explain what the findings mean and why they matter. Use markdown headings like "## Interpretation", "## Implications", and "## Limitations". Help the reader think more deeply about the topic, using a simple tone and clear logic. Avoid restating the full findings or talking about unrelated things. Stop after the discussion.`,

 //    // Conclusion
 //    `As Hailu, write the conclusion of a research paper about "${bookTopic}". Summarize the key points in around 300 words. Explain why this topic matters and what should happen next (like more research or learning). Use markdown header "## Conclusion". Make it inspiring and easy to understand, as if you were guiding a teenager. Stop after the conclusion.`,

 //    // References
 //    `As Hailu, write the references section for a research paper on "${bookTopic}". Use markdown header "## References". List atleast 5 reliable resources. For each resource, give a title, link (if possible), and a short 1–2 sentence explanation of why it’s helpful. Do not use complex sources or academic journals—keep it simple and useful for a beginner. Stop after the references.`
 //  ];
