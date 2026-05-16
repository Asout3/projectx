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
dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ==================== CORE SETUP ====================
class RateLimiter {
  constructor(requestsPerMinute) {
    this.limit = requestsPerMinute;
    this.users = new Map();
  }
  async wait(userId) {
    const now = Date.now();
    if (!this.users.has(userId)) this.users.set(userId, []);
    
    const userRequests = this.users.get(userId);
    const recent = userRequests.filter(t => now - t < 60000);
    this.users.set(userId, recent);
    
    while (recent.length >= this.limit) {
      const oldest = recent[0];
      const waitTime = 60000 - (now - oldest) + 1000;
      await new Promise(resolve => setTimeout(resolve, waitTime));
    }
    recent.push(now);
    this.users.set(userId, recent);
  }
}

const userRateLimiter = new RateLimiter(30);
const HISTORY_DIR = path.join(__dirname, 'history');
const OUTPUT_DIR = path.join(__dirname, '../pdfs');
const CHAPTER_PREFIX = 'chapter';
const MODEL_NAME = 'gpt-oss-120b';

let cerebras = null;
function ensureCerebras() {
  if (cerebras) return cerebras;
  const key = process.env.CEREBRAS_API_KEY;
  if (!key) {
    throw new Error('CEREBRAS_API_KEY is not set.');
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

// ==================== TEXT PROCESSING ====================
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
    .replace(/\\([[\]{}()])/g, '$1')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[\u2013\u2014]/g, '-')
    .replace(/\*\s*$/gm, '')
    .trim();
  clean = clean.replace(/\\(\$)/g, '$');
  return clean;
}

function formatMath(content) {
  return normalizeMathMarkdown(content);
}

// ==================== MARKED SETUP ====================
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

// ==================== DIAGRAM LOGIC ====================
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

async function formatDiagrams(content) {
  const figures = [];
  const diagramCounts = {};
  const diagramRegex = /```mermaid\n([\s\S]*?)```\s*(?:\n\s*\*Figure caption:\s*(.+?)(?=\n\n|\n#|\n$))?/gs;
  const chapterMatches = [...content.matchAll(/# Chapter (\d+):/g)];
  const chapterPositions = chapterMatches.map(m => ({ num: parseInt(m[1]), pos: m.index }));
  const matches = [...content.matchAll(diagramRegex)];
  
  if (matches.length > 0) {
    logger.info(`Found ${matches.length} mermaid code blocks. Rendering...`);
  }
  
  for (let match of matches) {
    const fullMatch = match[0];
    const rawCode = match[1].trim();
    const caption = match[2] ? match[2].trim() : 'Illustration of the concept';
    const code = repairMermaidSyntax(rawCode);
    
    let currentChapter = 0;
    for (let i = chapterPositions.length - 1; i >= 0; i--) {
      if (chapterPositions[i].pos < match.index) {
        currentChapter = chapterPositions[i].num;
        break;
      }
    }
    if (currentChapter === 0) {
      currentChapter = chapterPositions.length > 0 ? chapterPositions[chapterPositions.length - 1].num : 1;
    }
    
    if (!diagramCounts[currentChapter]) diagramCounts[currentChapter] = 0;
    diagramCounts[currentChapter]++;
    const figNum = `${currentChapter}.${diagramCounts[currentChapter]}`;
    
    try {
      const response = await fetch('https://kroki.io/mermaid/svg', {
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
      logger.info(`Diagram rendered successfully: "${caption}"`);
    } catch (error) {
      logger.error(`Failed to render diagram: ${error.message}`);
      content = content.replace(fullMatch, '');
    }
  }
  return { content, figures };
}

// ==================== TOC PARSER ====================
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
    
    const chapterMatch = line.match(/^Chapter\s+\d+:\s*(.+)$/i);
    const simpleMatch = line.match(/^(?:\d+[\.\):]|\d+\s+|[-\*•])\s*(.+)$/i);
    const chapMatch = chapterMatch || simpleMatch;
    
    if (chapMatch && !line.startsWith(' -') && !line.match(/^[\s]*[-•*·]/)) {
      let title = chapMatch[1].trim();
      title = title.replace(/[:–—*]\s*$/, '').trim();
      title = title.replace(/^\d+\.\s*/, '');
      
      if (title && title.length > 10 && !/^(introduction|chapter|basics|overview|conclusion)$/i.test(title)) {
        if (current) chapters.push(current);
        current = { title, subtopics: [] };
      }
    } else if (current && line.match(/^[\s]*[-•*·]\s+(.+)$/)) {
      const sub = line.match(/^[\s]*[-•*·]\s+(.+)$/)[1].trim();
      if (sub && sub.length > 5 && !/^(subtopic|section|part)/i.test(sub)) {
        current.subtopics.push(sub);
      }
    }
  }
  if (current) chapters.push(current);
  
  const valid = chapters.filter(c => c.subtopics.length >= 4);
  logger.debug(`Parsed ${valid.length} valid chapters out of ${chapters.length} total`);
  
  return valid.slice(0, 12);
}

function generateFallbackTOC(bookTopic) {
  const cleanTopic = bookTopic.replace(/\bin\s+.*$/i, '').trim();
  
  const base = [
    "Introduction and Foundations",
    "Core Principles",
    "Key Concepts and Mechanisms",
    "Building Blocks and Components",
    "Intermediate Techniques",
    "Practical Implementation",
    "Real-World Applications",
    "Advanced Topics",
    "Optimization and Best Practices",
    "Case Studies",
    "Common Challenges and Solutions",
    "Future Directions"
  ];
  
  const suffix = cleanTopic.length < 20 && !cleanTopic.includes(' ') ? ` in ${cleanTopic}` : '';
  
  const chapters = base.map((t, i) => ({
    title: `${t}${suffix}`,
    subtopics: [
      "Fundamental definitions and overview",
      "Historical context and motivation",
      "Step-by-step breakdown",
      "Practical examples",
      "Common pitfalls",
      "Exercises and applications"
    ]
  }));
  
  const raw = chapters.map(c =>
    `${c.title}\n${c.subtopics.map(s => `   - ${s}`).join('\n')}`
  ).join('\n\n');
  
  return { raw, parsed: chapters };
}

// ==================== AI INTERACTION ====================
async function askAI(prompt, userId, bookTopic, options = {}) {
  await userRateLimiter.wait(userId);
  const maxRetries = 3;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const result = await ensureCerebras().chat.completions.create({
        model: MODEL_NAME,
        messages: [{ role: "user", content: prompt }],
        max_tokens: options.genOptions?.maxOutputTokens || 8000,
        temperature: options.genOptions?.temperature || 0.4,
        stream: false
      });
      
      let reply = result.choices[0].message.content || '';
      
      if (!reply || reply.length < 100) {
        logger.warn(`Empty reply on attempt ${attempt + 1}, retrying...`);
        if (attempt < maxRetries - 1) await new Promise(r => setTimeout(r, 2000 * (attempt + 1)));
        continue;
      }
      if (options.minLength && reply.length < options.minLength) {
        throw new Error(`Response too short: ${reply.length} < ${options.minLength}`);
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
      logger.error(`AI call error (attempt ${attempt + 1}): ${e.message}`);
      if (attempt === maxRetries - 1) throw e;
      await new Promise(r => setTimeout(r, 3000 * (attempt + 1)));
    }
  }
}

// ==================== CONTENT GENERATION ====================
async function generateTOC(bookTopic, userId) {
  const prompt = buildTOCPrompt(bookTopic, 12, 'comprehensive');

  for (let attempts = 0; attempts < 5; attempts++) {
    try {
      const rawTOC = await askAI(prompt, userId, bookTopic, {
        saveToHistory: true,
        genOptions: { maxOutputTokens: 1800, temperature: 0.25, topP: 0.8 }
      });
      const cleaned = cleanUpAIText(rawTOC);
      const parsed = parseTOC(cleaned);

      if (parsed.length === 12 && parsed.every(chapter => chapter.subtopics.length >= 3)) {
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
    targetWords: 2800,
    resourceCount: 5,
    includeExercises: true
  });

  return cleanUpAIText(await askAI(prompt, userId, bookTopic, {
    minLength: 7000,
    genOptions: { maxOutputTokens: 8000, temperature: 0.35, topP: 0.85 }
  }));
}

async function generateConclusion(bookTopic, chapterInfos, userId) {
  const prompt = buildConclusionPrompt(bookTopic, chapterInfos, 1200);

  return cleanUpAIText(await askAI(prompt, userId, bookTopic, {
    minLength: 3000,
    genOptions: { maxOutputTokens: 4000, temperature: 0.35, topP: 0.85 }
  }));
}

// ==================== PDF GENERATION ====================
function buildEnhancedHTML(content, bookTitle, figures = []) {
  const cleaned = cleanUpAIText(content);
  const formattedContent = formatMath(cleaned);
  
  const finalContent = formattedContent.replace(/__FIGURE__(\d+)__/g, (_, i) => {
    const fig = figures[parseInt(i)];
    if (!fig) return '';
    return `<figure style="text-align: center; margin: 3em 0; page-break-inside: avoid;">
      <img src="${fig.base64}" alt="${fig.caption}" style="max-width: 90%; height: auto; border: 1px solid #e2e8f0; border-radius: 12px; box-shadow: 0 8px 25px rgba(0,0,0,0.1);">
      <figcaption style="margin-top: 0.8em; font-style: italic; color: #64748b; font-size: 0.95em;">Figure ${fig.figNum}: ${fig.caption}</figcaption>
    </figure>`;
  });

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${bookTitle} - Generated by Bookgen.AI</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Merriweather:wght@300;400;700;900&family=Inter:wght@400;600;700;800&display=swap" rel="stylesheet">
  <script>
    window.MathJax = {
      tex: { inlineMath: [['$', '$'], ['\\\\(', '\\\\)']], displayMath: [['$$', '$$']] },
      svg: { fontCache: 'global' }
    };
  </script>
  <script type="text/javascript" id="MathJax-script" async src="https://cdn.jsdelivr.net/npm/mathjax@3/es5/tex-mml-chtml.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/prismjs@1.29.0/prism.min.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/prismjs@1.29.0/components/prism-javascript.min.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/prismjs@1.29.0/components/prism-python.min.js"></script>
  <link href="https://cdn.jsdelivr.net/npm/prismjs@1.29.0/themes/prism-tomorrow.min.css" rel="stylesheet">
  <style>
    @page { margin: 100px 80px 90px 80px; size: A4; }
    @page :first { margin-top: 0; }
    body { font-family: 'Merriweather', Georgia, serif; font-size: 15px; line-height: 1.85; color: #1e293b; background: #fff; margin: 0; padding: 0; text-align: justify; hyphens: auto; }
    
    .cover-page { page-break-after: always; display: flex; flex-direction: column; justify-content: center; align-items: center; height: 100vh; text-align: center; background: linear-gradient(135deg, #4158d0 0%, #c850c0 46%, #ffcc70 100%); color: white; margin: 0; padding: 0; }
    .cover-title { font-family: 'Inter', sans-serif; font-size: 56px; font-weight: 900; margin: 0 0 0.4em 0; line-height: 1.1; text-shadow: 3px 3px 8px rgba(0,0,0,0.3); }
    .cover-subtitle { font-family: 'Inter', sans-serif; font-size: 28px; font-weight: 400; opacity: 0.95; margin-bottom: 3em; }
    .cover-meta { position: absolute; bottom: 80px; font-size: 16px; opacity: 0.9; }
    .cover-disclaimer { margin-top: 40px; font-size: 14px; opacity: 0.8; font-style: italic; }

    h1, h2, h3, h4 { font-family: 'Inter', sans-serif; font-weight: 700; color: #1e293b; margin: 2.8em 0 1em 0; }
    h1 { font-size: 36px; page-break-before: always; border-bottom: 4px solid #4158d0; padding-bottom: 20px; }
    h1::after { content: ""; display: block; width: 100px; height: 4px; background: #c850c0; margin-top: 20px; border-radius: 2px; }
    h2 { font-size: 28px; border-bottom: 2px solid #e2e8f0; padding-bottom: 12px; }
    h3 { font-size: 22px; color: #475569; }

    .chapter-content > h1 + p::first-letter { float: left; font-size: 5em; line-height: 0.9; margin: 0.05em 0.15em 0 0; font-weight: 900; color: #4158d0; font-family: 'Inter', sans-serif; }


    .chapter-content > h1:first-child { page-break-before: auto; text-align: center; border-bottom: 3px solid #667eea; margin-bottom: 1.5em; }
    .chapter-content > h1:first-child + p strong { font-family: 'Inter', sans-serif; color: #374151; font-size: 1.05em; }
    .chapter-content ul { margin: 0.5em 0 1.5em 1.5em; }
    figure { page-break-inside: avoid; }
    code { background: #f1f5f9; padding: 4px 9px; border-radius: 6px; font-family: 'Fira Code', monospace; font-size: 14px; color: #1e40af; }
    pre { background: #0f172a; padding: 24px; border-radius: 12px; overflow-x: auto; margin: 2em 0; box-shadow: 0 10px 30px rgba(0,0,0,0.15); }
    pre code { background: none; padding: 0; color: #e2e8f0; }

    blockquote { border-left: 5px solid #4158d0; background: #f8fafc; padding: 20px 30px; margin: 2.5em 0; border-radius: 0 12px 12px 0; font-style: italic; box-shadow: 0 4px 15px rgba(0,0,0,0.05); }
    
    table { width: 100%; border-collapse: separate; border-spacing: 0; margin: 2.5em 0; border-radius: 12px; overflow: hidden; box-shadow: 0 8px 25px rgba(0,0,0,0.1); }
    th { background: #1e293b; color: white; padding: 16px; text-align: left; font-weight: 700; }
    td { padding: 14px 16px; border-bottom: 1px solid #e2e8f0; }
    tr:nth-child(even) { background: #f8fafc; }

    .disclaimer-footer { margin-top: 6em; padding-top: 2em; border-top: 2px solid #e2e8f0; font-size: 13px; color: #64748b; text-align: center; font-style: italic; }
    
    /* Exercise styling */
    h3:contains("Practice Exercises"), h3:contains("Mini-Project") { margin-top: 3em; color: #7c3aed; }
    ul, ol { padding-left: 1.8em; }
    li { margin: 0.8em 0; }
  </style>
</head>
<body>
  <div class="cover-page">
    <div>
      <h1 class="cover-title">${bookTitle}</h1>
      <h2 class="cover-subtitle">A Comprehensive Educational Guide</h2>
      <div class="cover-disclaimer">AI-Generated Content • Verify Information Independently</div>
    </div>
    <div class="cover-meta">Generated by Bookgen.AI • ${new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}</div>
  </div>

  <div class="chapter-content">${marked.parse(finalContent)}</div>
  
  <div class="disclaimer-footer">
    This book was generated by AI for educational purposes. Please verify all technical information and citations independently.
  </div>
  
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

// ==================== HELPER FUNCTIONS ====================
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
  try {
    fs.unlinkSync(filePath);
  } catch {
    logger.warn(`Delete failed: ${filePath}`);
  }
}

// ==================== MAIN GENERATOR ====================
export async function generateBookMedd(rawTopic, userId) {
  const bookTopic = rawTopic.replace(/^(generate|create|write)( me)? (a book )?(about )?/i, '').trim();
  const safeUserId = `${userId}-${bookTopic.replace(/\s+/g, '_').toLowerCase().slice(0, 50)}`;
  logger.info(`=== Starting book: "${bookTopic}" for ${safeUserId} ===`);
  
  try {
    userHistories.delete(safeUserId);
    
    const { raw: tocRaw, parsed: chapterInfos } = await generateTOC(bookTopic, safeUserId);
    
    // Format TOC
    const formattedTOC = buildMarkdownTableOfContents(chapterInfos);
    
    const tocFile = path.join(OUTPUT_DIR, `${CHAPTER_PREFIX}-${safeUserId}-toc.txt`);
    saveToFile(tocFile, formattedTOC);
    const files = [tocFile];
    
    // Generate chapters in parallel (max 3 concurrent to respect rate limits)
    logger.info('Generating chapters (parallel, max 3 concurrent)...');
    const chapters = await async.mapLimit(chapterInfos.entries(), 3, async ([i, info]) => {
      if (global.cancelFlags?.[safeUserId]) {
        throw new Error('Generation cancelled');
      }
      const chNum = i + 1;
      logger.info(`Generating Chapter ${chNum}: ${info.title}`);
      
      const chapter = await generateChapter(bookTopic, chNum, info, safeUserId, chapterInfos);
      const txt = `\n\n# Chapter ${chNum}: ${info.title}\n\n${chapter}\n\n---\n`;
      const f = path.join(OUTPUT_DIR, `${CHAPTER_PREFIX}-${safeUserId}-${chNum}.txt`);
      saveToFile(f, txt);
      files.push(f);
      return f;
    });
    
    // Generate conclusion
    logger.info('Generating conclusion...');
    const conclusion = await generateConclusion(bookTopic, chapterInfos, safeUserId);
    const conclFile = path.join(OUTPUT_DIR, `${CHAPTER_PREFIX}-${safeUserId}-conclusion.txt`);
    saveToFile(conclFile, `\n\n# Conclusion\n\n${conclusion}\n`);
    files.push(conclFile);
    
    // Combine and generate PDF
    logger.info('Combining content and generating PDF...');
    const combined = files.map(f => fs.readFileSync(f, 'utf8')).join('\n');
    const safeName = bookTopic.slice(0, 40).replace(/[^\w]/g, '_');
    const pdfPath = path.join(OUTPUT_DIR, `book_${safeUserId}_${safeName}.pdf`);
    
    await generatePDF(combined, pdfPath, bookTopic);
    
    // Cleanup
    files.forEach(deleteFile);
    userHistories.delete(safeUserId);
    
    logger.info(`=== SUCCESS: ${pdfPath} ===`);
    return pdfPath;
  } catch (e) {
    logger.error(`Generation failed: ${e.message}`);
    throw e;
  }
}

// ==================== QUEUE SYSTEM ====================
const bookQueue = async.queue(async (task, callback) => {
  try {
    const result = await generateBookMedd(task.bookTopic, task.userId);
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
