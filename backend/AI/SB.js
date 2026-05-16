// AI/MB.js – MIGRATED TO CEREBRAS GPT-OSS
import Cerebras from '@cerebras/cerebras_cloud_sdk';
import { marked } from 'marked';
import hljs from 'highlight.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import async from 'async';
import winston from 'winston';
import fetch from 'node-fetch';
import dotenv from 'dotenv';
import { renderHtmlToPdf } from '../utils/pdfRenderer.js';
import {
  normalizeMathMarkdown,
  buildMarkdownTableOfContents,
  buildTOCPrompt,
  buildChapterPrompt,
  buildConclusionPrompt
} from '../utils/documentQuality.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

if (!process.env.RAILWAY_ENVIRONMENT) {
  dotenv.config({ path: path.join(__dirname, '../.env') });
  console.log('📂 DEV mode: Loaded .env file');
} else {
  console.log('🚀 PROD mode: Using Railway environment variables');
}

class RateLimiter {
  constructor(requestsPerMinute) {
    this.requestsPerMinute = requestsPerMinute;
    this.requests = [];
  }
  async wait() {
    const now = Date.now();
    this.requests = this.requests.filter(t => now - t < 60000);
    while (this.requests.length >= this.requestsPerMinute) {
      const oldest = this.requests[0];
      const waitTime = 60000 - (now - oldest) + 1000;
      await new Promise(resolve => setTimeout(resolve, waitTime));
    }
    this.requests.push(Date.now());
  }
}

const globalRateLimiter = new RateLimiter(15);
const HISTORY_DIR = path.join(__dirname, 'history');
const OUTPUT_DIR = path.join(__dirname, '../pdfs');
const CHAPTER_PREFIX = 'chapter';
const MODEL_NAME = 'gpt-oss-120b';

let cerebras = null;
function ensureCerebras() {
  if (cerebras) return cerebras;
  const key = process.env.CEREBRAS_API_KEY;
  if (!key) {
    throw new Error('CEREBRAS_API_KEY is not set in environment.');
  }
  cerebras = new Cerebras({ apiKey: key });
  return cerebras;
}

const userHistories = new Map();

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(winston.format.timestamp(), winston.format.json()),
  transports: [
    new winston.transports.File({ filename: 'bookgen.log' }),
    new winston.transports.Console({ format: winston.format.simple() })
  ]
});

fs.mkdirSync(HISTORY_DIR, { recursive: true });
fs.mkdirSync(OUTPUT_DIR, { recursive: true });

function cleanUpAIText(text) {
  if (!text) return '';
  let clean = text
    .replace(/^(?:Hi|Hello|Hey|Sure|Here).*?(\n\n|$)/gis, '')
    .replace(/<\/?(header|footer|figure|figcaption)[^>]*>/gi, '')
    .replace(/^\s*Table of Contents\s*$/gim, '')
    .replace(/(\d+)([a-zA-Z]+)/g, '$1 $2')
    .replace(/\b([A-Z])\s+([a-z]{2,})\b/g, (match, p1, p2) => {
      if (match.includes('`') || match.includes('```')) return match;
      return p1 + p2;
    })
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[\u2013\u2014]/g, '-')
    .replace(/\*\s*$/gm, '')
    .trim();
  clean = clean.replace(/\\(\$)/g, '$');
  return clean;
}

// ==================== DIAGRAM LOGIC (UPDATED FOR CAPTIONS) ====================
function repairMermaidSyntax(code) {
  let fixed = code
    .replace(/^mermaid\s*\n/i, '')
    .replace(/\[([^\]]*?\(.*?\)[^\]]*?)\]/g, (match, content) => {
      if (content.startsWith('"') && content.endsWith('"')) return match;
      return `["${content.replace(/"/g, "'")}"]`;
    })
    .replace(/-->;\s*$/gm, '-->')
    .replace(/-->;\s*\n?\s*([A-Z])/g, '--> $1')
    .replace(/\n{2,}/g, '\n')
    .replace(/-->\s*$/gm, '--> EndNode[End]');
  return fixed.trim();
}

async function formatDiagrams(content) { // Updated for captions and per-chapter numbering
  const figures = [];
  const diagramCounts = {};
  const diagramRegex = /```mermaid\n([\s\S]*?)```\s*(?:\n\s*\*Figure caption:\s*(.+?)(?=\n\n|\n#|\n$))?/gs;

  // Find all chapter positions
  const chapterMatches = [...content.matchAll(/# Chapter (\d+):/g)];
  const chapterPositions = chapterMatches.map(m => ({ num: parseInt(m[1]), pos: m.index }));

  const matches = [...content.matchAll(diagramRegex)];

  if (matches.length > 0) {
    logger.info(`🔍 Found ${matches.length} mermaid code blocks. Rendering...`);
  }

  for (let match of matches) {
    const fullMatch = match[0];
    const rawCode = match[1].trim();
    const caption = match[2] ? match[2].trim() : 'Illustration of the concept';
    const code = repairMermaidSyntax(rawCode);

    // Determine current chapter
    let currentChapter = 0;
    for (let i = chapterPositions.length - 1; i >= 0; i--) {
      if (chapterPositions[i].pos < match.index) {
        currentChapter = chapterPositions[i].num;
        break;
      }
    }
    if (currentChapter === 0) {
      // If no chapter found (e.g., in TOC or conclusion), use the last chapter or a default
      currentChapter = chapterPositions.length > 0 ? chapterPositions[chapterPositions.length - 1].num : 1;
    }

    if (!diagramCounts[currentChapter]) diagramCounts[currentChapter] = 0;
    diagramCounts[currentChapter]++;
    const figNum = `${currentChapter}.${diagramCounts[currentChapter]}`;

    try {
      const response = await fetch('https://kroki.io/mermaid/svg ', {
        method: 'POST',
        headers: {
          'Content-Type': 'text/plain',
          'Accept': 'image/svg+xml'
        },
        body: code
      });

      if (!response.ok) {
        if (response.status === 400) {
          logger.warn(`Invalid Mermaid Syntax Detected:\n${code}`);
        }
        throw new Error(`Kroki error: ${response.status}`);
      }

      const svg = await response.text();
      const base64 = `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;

      figures.push({ base64, figNum, caption });
      content = content.replace(fullMatch, `__FIGURE__${figures.length - 1}__`);
      logger.info(`✅ Diagram rendered successfully with caption: "${caption}"`);

    } catch (error) {
      logger.error(`❌ Failed to render diagram: ${error.message}`);
      // Silent failure: remove diagram and caption completely
      content = content.replace(fullMatch, '');
    }
  }

  return { content, figures };
}

function formatMath(content) {
  return normalizeMathMarkdown(content);
}

marked.setOptions({
  headerIds: false,
  breaks: true,
  gfm: true,
  highlight: function(code, lang) {
    if (lang && hljs.getLanguage(lang)) {
      return hljs.highlight(code, { language: lang }).value;
    }
    return code;
  }
});

function getHistoryFile(userId) {
  return path.join(HISTORY_DIR, `history-${userId}.json`);
}

function loadConversationHistory(userId) {
  try {
    return JSON.parse(fs.readFileSync(getHistoryFile(userId), 'utf8'));
  } catch {
    return [];
  }
}

function saveConversationHistory(userId, history) {
  fs.writeFileSync(getHistoryFile(userId), JSON.stringify(history, null, 2));
}

function saveToFile(filename, content) {
  fs.writeFileSync(filename, content);
  logger.info(`Saved: ${filename}`);
}

function deleteFile(filePath) {
  try { fs.unlinkSync(filePath); } catch { logger.warn(`Delete failed: ${filePath}`); }
}

function parseTOC(tocContent) {
  const lines = tocContent.split('\n').map(l => l.trimEnd()).filter(l => l.trim());
  const chapters = [];
  let current = null;
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];
    if (!line) continue;
    if (line.length === 1 && /^[A-Z]$/.test(line) && i + 1 < lines.length) {
      const nextLine = lines[i + 1];
      if (nextLine && nextLine.length > 5 && !nextLine.match(/^[\s]*[-•*·\d]/) && !nextLine.startsWith(' ')) {
        line = line + nextLine;
        i++;
      }
    }
    const chapMatch = line.match(/^Chapter\s+\d+:\s*(.+)$/i) || line.match(/^(?:\d+[\.\):]|\d+\s+|[-\*•])\s*(.+)$/i);
   
    if (chapMatch && !line.startsWith(' -') && !line.match(/^[\s]*[-•*·]/)) {
      let title = chapMatch[1].trim().replace(/[:–—*]\s*$/, '').replace(/^\d+\.\s*/, '');
      if (title && title.length > 10 && !/^(introduction|chapter|basics|overview|conclusion)$/i.test(title)) {
        if (current) chapters.push(current);
        current = { title, subtopics: [] };
      }
    } else if (current && line.match(/^[\s]*[-•*·]\s+(.+)$/)) {
      const sub = line.match(/^[\s]*[-•*·]\s+(.+)$/)[1].trim();
      if (sub.length > 5 && !/^(subtopic|section|part)/i.test(sub)) {
        current.subtopics.push(sub);
      }
    }
  }
  if (current) chapters.push(current);
  return chapters.filter(c => c.subtopics.length >= 3).slice(0, 5);
}

function generateFallbackTOC(bookTopic) {
  const cleanTopic = bookTopic.replace(/\bin\s+.*$/i, '').trim();
  const base = [
    "Introduction to Core Concepts", "Essential Principles", "Understanding Key Systems",
    "Practical Applications", "Advanced Topics and Trends"
  ];
  const suffix = (cleanTopic.length > 2 && cleanTopic.length < 20 && !cleanTopic.includes(' ')) ? ` in ${cleanTopic}` : '';
 
  const chapters = base.map((t, i) => ({
    title: `${t}${suffix}`,
    subtopics: [
      "Understanding the core concept",
      "Practical applications",
      "Common challenges and how to address them",
      "Key examples and takeaways"
    ]
  }));
  return { raw: '', parsed: chapters };
}

async function askAI(prompt, userId, bookTopic, options = {}) {
  await globalRateLimiter.wait();
  
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const result = await ensureCerebras().chat.completions.create({
        model: MODEL_NAME,
        messages: [{ role: "user", content: prompt }],
        max_tokens: options.genOptions?.maxOutputTokens || 4000,
        temperature: options.genOptions?.temperature || 0.7,
      });
      
      let reply = result.choices[0].message.content || '';
      
      reply = (reply || '').toString().trim();
      if (!reply || reply.length < 50) {
        if (attempt < 2) await new Promise(r => setTimeout(r, 2000 * (attempt + 1)));
        continue;
      }
     
      if (options.saveToHistory) {
        const hist = userHistories.get(userId) || [];
        hist.push({ role: 'user', content: prompt });
        hist.push({ role: 'assistant', content: reply });
        userHistories.set(userId, hist);
        saveConversationHistory(userId, hist);
      }
      return reply;
    } catch (e) {
      if (attempt === 2) throw e;
      await new Promise(r => setTimeout(r, 3000 * (attempt + 1)));
    }
  }
}

async function generateTOC(bookTopic, userId) {
  const prompt = buildTOCPrompt(bookTopic, 5, 'professional');

  for (let attempts = 0; attempts < 5; attempts++) {
    try {
      const rawTOC = await askAI(prompt, userId, bookTopic, {
        saveToHistory: true,
        genOptions: { maxOutputTokens: 1800, temperature: 0.25, topP: 0.8 }
      });
      const cleaned = cleanUpAIText(rawTOC);
      const parsed = parseTOC(cleaned);

      if (parsed.length === 5 && parsed.every(chapter => chapter.subtopics.length >= 3)) {
        logger.info(`TOC succeeded on attempt ${attempts + 1}`);
        return { raw: cleaned, parsed };
      }

      logger.warn(`TOC invalid on attempt ${attempts + 1}: got ${parsed.length} chapters`);
    } catch (e) {
      logger.error(`TOC error on attempt ${attempts + 1}: ${e.message}`);
    }
  }

  logger.warn(`TOC failed after 5 attempts; using curated fallback for "${bookTopic}"`);
  return generateFallbackTOC(bookTopic);
}

async function generateChapter(bookTopic, chapterNumber, chapterInfo, userId, chapterInfos) {
  const prompt = buildChapterPrompt({
    bookTopic,
    chapterNumber,
    chapterInfo,
    chapterInfos,
    targetWords: 900,
    resourceCount: 3,
    includeExercises: false
  });

  return cleanUpAIText(await askAI(prompt, userId, bookTopic, {
    minLength: 2200,
    genOptions: { maxOutputTokens: 4500, temperature: 0.35, topP: 0.85 }
  }));
}

async function generateConclusion(bookTopic, chapterInfos, userId) {
  const prompt = buildConclusionPrompt(bookTopic, chapterInfos, 650);

  return cleanUpAIText(await askAI(prompt, userId, bookTopic, {
    minLength: 1200,
    genOptions: { maxOutputTokens: 2200, temperature: 0.35, topP: 0.85 }
  }));
}

// ==================== PDF GENERATION (MODIFIED FOR FIGURES WITH CAPTIONS) ====================
function buildEnhancedHTML(content, bookTitle, figures = []) {
  const cleaned = cleanUpAIText(content);
  const formattedContent = formatMath(cleaned);
 
  // Restore figures with captions
  const finalContent = formattedContent.replace(/__FIGURE__(\d+)__/g, (_, i) => {
    const fig = figures[parseInt(i)];
    if (!fig) return '';
    return `<figure style="text-align: center; margin: 2em 0;">
      <img src="${fig.base64}" alt="${fig.caption}" style="max-width: 85%; height: auto; border: 1px solid #e5e7eb; border-radius: 8px; box-shadow: 0 4px 6px rgba(0,0,0,0.05);">
      <figcaption style="margin-top: 0.5em; font-style: italic; color: #6b7280; font-size: 0.9em;">Figure ${fig.figNum}: ${fig.caption}</figcaption>
    </figure>`;
  });
 
  const titleMatch = cleaned.match(/^#\s+(.+)$/m);
  let displayTitle = titleMatch ? titleMatch[1] : bookTitle;
  displayTitle = displayTitle
    .replace(/^Chapter\s+\d+:\s*/i, '')
    .replace(/^\d+\.\s*/, '')
    .trim();
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${displayTitle} - Bookgen.ai</title>
 
  <link rel="preconnect" href="https://fonts.googleapis.com ">
  <link rel="preconnect" href="https://fonts.gstatic.com " crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Merriweather:wght@300 ;400;700&family=Inter:wght@400;600;700&display=swap" rel="stylesheet">
 
  <script>
    window.MathJax = {
      tex: { inlineMath: [['$', '$'], ['\\\\(', '\\\\)']], displayMath: [['$$', '$$']] },
      svg: { fontCache: 'global' }
    };
  </script>
  <script type="text/javascript" id="MathJax-script" async src="https://cdn.jsdelivr.net/npm/mathjax@3/es5/tex-mml-chtml.js "></script>
  <script src="https://cdn.jsdelivr.net/npm/prismjs@1.29.0/prism.min.js "></script>
  <script src="https://cdn.jsdelivr.net/npm/prismjs@1.29.0/components/prism-javascript.min.js "></script>
  <script src="https://cdn.jsdelivr.net/npm/prismjs@1.29.0/components/prism-python.min.js "></script>
  <link href="https://cdn.jsdelivr.net/npm/prismjs@1.29.0/themes/prism-tomorrow.min.css " rel="stylesheet">
 
  <style>
    @page { margin: 90px 70px 80px 70px; size: A4; }
    .cover-page { page: cover; }
    @page cover { margin: 0; @top-center { content: none; } @bottom-center { content: none; } }
    body { font-family: 'Merriweather', Georgia, serif; font-size: 14px; line-height: 1.8; color: #1f2937; background: white; margin: 0; padding: 0; text-align: justify; hyphens: auto; }
    .cover-page { display: flex; flex-direction: column; justify-content: center; align-items: center; height: 100vh; page-break-after: always; text-align: center; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; margin: -90px -70px -80px -70px; padding: 70px; }
    .cover-title { font-family: 'Inter', sans-serif; font-size: 48px; font-weight: 700; margin-bottom: 0.3em; line-height: 1.2; text-shadow: 2px 2px 4px rgba(0,0,0,0.1); }
    .cover-subtitle { font-family: 'Inter', sans-serif; font-size: 24px; font-weight: 300; margin-bottom: 2em; opacity: 0.9; }
    .cover-meta { position: absolute; bottom: 60px; font-size: 14px; font-weight: 300; opacity: 0.8; }
    .cover-disclaimer { margin-top: 30px; font-size: 12px; color: #fecaca; font-style: italic; }
    h1, h2, h3, h4 { font-family: 'Inter', sans-serif; font-weight: 600; color: #1f2937; margin-top: 2.5em; margin-bottom: 0.8em; position: relative; }
    h1 { font-size: 28px; border-bottom: 3px solid #667eea; padding-bottom: 15px; margin-top: 0; page-break-before: always; }
    h1::after { content: ""; display: block; width: 80px; height: 3px; background: #764ba2; margin-top: 15px; }
    h2 { font-size: 22px; border-bottom: 2px solid #e5e7eb; padding-bottom: 8px; color: #4b5563; }
    h3 { font-size: 18px; color: #6b7280; }
    .chapter-content > h1 + p::first-letter { float: left; font-size: 4em; line-height: 1; margin: 0.1em 0.1em 0 0; font-weight: 700; color: #667eea; font-family: 'Inter', sans-serif; }

    .chapter-content > h1:first-child { page-break-before: auto; text-align: center; border-bottom: 3px solid #667eea; margin-bottom: 1.5em; }
    .chapter-content > h1:first-child + p strong { font-family: 'Inter', sans-serif; color: #374151; font-size: 1.05em; }
    .chapter-content ul { margin: 0.5em 0 1.5em 1.5em; }
    figure { page-break-inside: avoid; }
    code { background: #f3f4f6; padding: 3px 8px; border: 1px solid #e5e7eb; font-family: 'Fira Code', 'Courier New', monospace; font-size: 13px; border-radius: 4px; color: #1e40af; }
    pre { background: #1f2937; padding: 20px; overflow-x: auto; border: 1px solid #4b5563; border-radius: 8px; line-height: 1.5; margin: 1.5em 0; white-space: pre-wrap; word-wrap: break-word; box-shadow: 0 4px 6px rgba(0, 0, 0, 0.05); }
    pre code { background: none; border: none; padding: 0; color: #e5e7eb; }
    blockquote { border-left: 4px solid #667eea; margin: 2em 0; padding: 1em 1.5em; background: linear-gradient(to right, #f3f4f6 0%, #ffffff 100%); font-style: italic; border-radius: 0 8px 8px 0; position: relative; }
    blockquote::before { content: "“"; position: absolute; top: -20px; left: 10px; font-size: 80px; color: #d1d5db; font-family: 'Inter', sans-serif; line-height: 1; }
    .example { background: linear-gradient(to right, #eff6ff 0%, #ffffff 100%); border-left: 4px solid #3b82f6; padding: 20px; margin: 2em 0; border-radius: 0 8px 8px 0; font-style: italic; position: relative; }
    .example::before { content: "💡 Example"; display: block; font-weight: 600; color: #1d4ed8; margin-bottom: 10px; font-style: normal; }
    table { width: 100%; border-collapse: collapse; margin: 2em 0; box-shadow: 0 1px 3px rgba(0, 0, 0, 0.1); }
    th { background: #374151; color: white; padding: 12px; text-align: left; font-family: 'Inter', sans-serif; font-weight: 600; }
    td { padding: 12px; border-bottom: 1px solid #e5e7eb; }
    tr:nth-child(even) { background: #f9fafb; }
    .MathJax_Display { margin: 2em 0 !important; padding: 1em 0; overflow-x: auto; }
    .disclaimer-footer { margin-top: 4em; padding-top: 2em; border-top: 2px solid #e5e7eb; font-size: 12px; color: #6b7280; font-style: italic; text-align: center; }
  </style>
</head>
<body>
  <div class="cover-page">
    <div class="cover-content">
      <h1 class="cover-title">Bookgen.AI</h1>
      <h2 class="cover-subtitle">A Guide book</h2>
      <div class="cover-disclaimer">⚠️ Caution: AI-generated content may contain errors</div>
    </div>
    <div class="cover-meta">Generated by Bookgen.ai<br>${new Date().toLocaleDateString()}</div>
  </div>
  <div class="chapter-content">${marked.parse(finalContent)}</div>
  <div class="disclaimer-footer">This book was generated by AI for educational purposes. Please verify all information independently.</div>
  <script>document.addEventListener('DOMContentLoaded', () => { Prism.highlightAll(); });</script>
</body>
</html>`;
}

async function generatePDF(content, outputPath, bookTitle) {
  try {
    logger.info('🎨 Rendering diagrams (if any)...');
    const { content: processedContent, figures } = await formatDiagrams(content);
    const enhancedHtml = buildEnhancedHTML(processedContent, bookTitle, figures);

    await renderHtmlToPdf(enhancedHtml, outputPath, {
      margin: { top: '90px', bottom: '80px', left: '70px', right: '70px' },
      headerTemplate: `<div style="font-size:10px;text-align:center;width:100%;color:#6b7280;">${bookTitle || 'Generated by bookgen.ai'}</div>`,
      footerTemplate: '<div style="font-size:10px;text-align:center;width:100%;color:#6b7280;">Page <span class="pageNumber"></span></div>'
    });

    logger.info(`✅ PDF generated locally: ${outputPath}`);
    return outputPath;
  } catch (error) {
    logger.error(`❌ PDF generation failed: ${error.message}`);
    throw error;
  }
}

export async function generateBookS(rawTopic, userId) {
  const bookTopic = rawTopic.replace(/^(generate|create|write)( me)? (a book )?(about )?/i, '').trim();
  const safeUserId = `${userId}-${bookTopic.replace(/\s+/g, '_').toLowerCase().slice(0, 50)}`;
  logger.info(`=== Starting: "${bookTopic}" for ${safeUserId} ===`);
  try {
    userHistories.delete(safeUserId);
    const { raw: tocRaw, parsed: chapterInfos } = await generateTOC(bookTopic, safeUserId);
   
    const formattedTOC = buildMarkdownTableOfContents(chapterInfos);
   
    const tocFile = path.join(OUTPUT_DIR, `${CHAPTER_PREFIX}-${safeUserId}-toc.txt`);
    saveToFile(tocFile, formattedTOC);
    const files = [tocFile];
    logger.info('Step 2/3: Generating chapters...');
    for (let i = 0; i < chapterInfos.length; i++) {
      if (global.cancelFlags?.[safeUserId]) {
        delete global.cancelFlags[safeUserId];
        throw new Error('Generation cancelled');
      }
      const chNum = i + 1;
      const info = chapterInfos[i];
      logger.info(` ${chNum}. ${info.title}`);
     
      const chapter = await generateChapter(bookTopic, chNum, info, safeUserId, chapterInfos);
      const txt = `\n<div class="chapter-break"></div>\n\n# Chapter ${chNum}: ${info.title}\n\n${chapter}\n\n---\n`;
     
      const f = path.join(OUTPUT_DIR, `${CHAPTER_PREFIX}-${safeUserId}-${chNum}.txt`);
      saveToFile(f, txt);
      files.push(f);
    }
    logger.info('Step 3/3: Generating conclusion...');
    const conclusion = await generateConclusion(bookTopic, chapterInfos, safeUserId);
    const conclFile = path.join(OUTPUT_DIR, `${CHAPTER_PREFIX}-${safeUserId}-conclusion.txt`);
    saveToFile(conclFile, `\n<div class="chapter-break"></div>\n\n# Conclusion\n\n${conclusion}\n`);
    files.push(conclFile);
    logger.info('Combining content and generating PDF...');
    const combined = files.map(f => fs.readFileSync(f, 'utf8')).join('\n');
    const safeName = bookTopic.slice(0, 30).replace(/\s+/g, '_');
    const pdfPath = path.join(OUTPUT_DIR, `book_${safeUserId}_${safeName}.pdf`);
   
    await generatePDF(combined, pdfPath, bookTopic);
    files.forEach(deleteFile);
    userHistories.delete(safeUserId);
   
    logger.info(`=== SUCCESS: ${pdfPath} ===`);
    return pdfPath;
  } catch (e) {
    logger.error(`❌ Failed: ${e.message}`);
    throw e;
  }
}

const bookQueue = async.queue(async (task, callback) => {
  try {
    const result = await generateBookS(task.bookTopic, task.userId);
    callback(null, result);
  } catch (error) {
    callback(error);
  }
}, 1);

export function queueBookGeneration(bookTopic, userId) {
  return new Promise((resolve, reject) => {
    bookQueue.push({ bookTopic, userId }, (error, result) => {
      if (error) reject(error);
      else resolve(result);
    });
  });
}
