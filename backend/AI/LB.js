// AI/MB.js – FINAL FIXED VERSION: 5 Chapters, Subtopics Enforced + MATH FIXES
import { GoogleGenerativeAI } from '@google/generative-ai';
import { marked } from 'marked';
import hljs from 'highlight.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import async from 'async';
import winston from 'winston';
import fetch from 'node-fetch';
import FormData from 'form-data';
import dotenv from 'dotenv';

dotenv.config();


const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ==================== CORE SETUP ====================
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
const MODEL_NAME = 'gemini-2.5-flash-lite'; // Updated model name if needed
const NUTRIENT_API_KEY = process.env.NUTRIENT_API_KEY;

let genAI = null;
function ensureGenAI() {
  if (genAI) return genAI;
  const key = process.env.GEMINI_API_KEY;
  if (!key) {
    throw new Error('GEMINI_API_KEY is not set in environment. Configure it in your deployment or .env file.');
  }
  genAI = new GoogleGenerativeAI(key);
  return genAI;
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

  // 🔥 MATH FIX: Remove backslashes before dollar signs (\$ -> $)
  clean = clean.replace(/\\(\$)/g, '$');
  return clean;
}

function formatMath(content) {
  const tables = [];
  const codeBlocks = [];

  // Protect tables
  content = content.replace(/(\|.+\|[\s]*\n\|[-:\s|]+\|[\s]*\n(?:\|.*\|[\s]*\n?)*)/g, (tbl) => {
    tables.push(tbl);
    return `__TABLE__${tables.length - 1}__`;
  });

  // Protect fenced code
  content = content.replace(/```[\w]*\n([\s\S]*?)```/g, (match, code) => {
    codeBlocks.push(match);
    return `__CODE__${codeBlocks.length - 1}__`;
  });

  // Protect inline code
  content = content.replace(/`([^`]+)`/g, (match) => {
    codeBlocks.push(match);
    return `__CODE__${codeBlocks.length - 1}__`;
  });

  // 🔥 MATH FIX: Simplify math logic
  content = content.replace(/^\\\[(.+)\\\]$/gm, '$$$1$$'); // Convert \[ \] to $$ $$
  
  // Clean up common AI artifacts
  content = content.replace(/\\wedge/g, '^'); 
  content = content.replace(/\{\\\^\}/g, '^');

  // Restore protected blocks
  content = content.replace(/__TABLE__(\d+)__/g, (_, i) => tables[i]);
  content = content.replace(/__CODE__(\d+)__/g, (_, i) => codeBlocks[i]);

  return content;
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
    
    if (chapMatch && !line.startsWith('  -') && !line.match(/^[\s]*[-•*·]/)) {
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

  const valid = chapters.filter(c => c.subtopics.length >= 3);
  logger.debug(`✅ Parsed ${valid.length} valid chapters out of ${chapters.length} total`);
  
  // <--- CHANGED: Changed from 10 to 5 to force limit
  return valid.slice(0, 15); 
}

function generateFallbackTOC(bookTopic) {
  const cleanTopic = bookTopic.replace(/\bin\s+.*$/i, '').trim();
  
  // <--- CHANGED: Reduced fallback to 5 chapters
 const base = [
  "Foundational Framework: Core Concepts, Terminology, and Theoretical Underpinnings",
  "Methodological Mastery: Essential Principles, Standards, and Workflow Design",
  "System Architecture: Component Analysis, Data Flows, and Interaction Models",
  "Practical Implementation: Hands-On Techniques, Tools, and Development Workflows",
  "Advanced Paradigms: Complex Topics, Research Frontiers, and Emerging Trends",
  "Industry Validation: Comprehensive Case Studies and Real-World Application Analysis",
  "Strategic Deployment: Phased Implementation, Change Management, and Adoption Strategies",
  "Performance Optimization: Benchmarking, Tuning, and Efficiency Maximization",
  "Reliability Engineering: Troubleshooting, Debugging, and Failure Recovery",
  "Innovation Landscape: Future Directions, Disruptive Technologies, and Market Evolution",
  "Ecosystem Architecture: Integration Patterns, API Design, and Interoperability Standards",
  "Quality Assurance Framework: Testing Strategies, Validation Protocols, and CI/CD",
  "Security Engineering: Threat Modeling, Risk Assessment, and Defense-in-Depth",
  "Scalability and Resilience: Distributed Design, Load Balancing, and Fault Tolerance",
  "Transformational Change: Next-Gen Research, Emerging Paradigms, and Strategic Vision"
];
  
  const isTechName = cleanTopic.length > 2 && cleanTopic.length < 20 && !cleanTopic.includes(' ');
  const suffix = isTechName ? ` in ${cleanTopic}` : '';
  
  const chapters = base.map((t, i) => ({
    title: `${t}${suffix}`,
    subtopics: [
      "Understanding the core concept",
      "Practical applications",
      "Common challenges and how to address them"
    ]
  }));
  
  const raw = chapters.map(c =>
    `${c.title}\n${c.subtopics.map(s => `    - ${s}`).join('\n')}`
  ).join('\n');
  
  return { raw, parsed: chapters };
}

// ==================== AI INTERACTION ====================
async function askAI(prompt, userId, bookTopic, options = {}) {
  await globalRateLimiter.wait();

  const genCfg = options.genOptions || { maxOutputTokens: 4000, temperature: 0.7, topP: 0.9 };
  const model = ensureGenAI().getGenerativeModel({ model: MODEL_NAME, generationConfig: genCfg });

  const maxRetries = 3;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const result = await model.generateContent(prompt);
      
      let reply = '';
      if (result.response && typeof result.response.text === 'function') {
        reply = await result.response.text();
      } else if (result.candidates?.[0]?.content?.parts?.[0]?.text) {
        reply = result.candidates[0].content.parts[0].text;
      } else if (result.output && Array.isArray(result.output)) {
        reply = result.output.map(o => (o?.content || o?.text || '')).join('\n');
      } else if (result.text) {
        reply = result.text;
      }
      
      reply = (reply || '').toString().trim();

      if (!reply || reply.length < 50) {
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
  // <--- CHANGED: Requested EXACTLY 5 chapters in prompt
  const prompt = `Create a detailed table of contents for a book about "${bookTopic}".
REQUIREMENTS (FOLLOW EXACTLY):
- Output EXACTLY 15 chapters
- Use the format: "Chapter X: Title" on its own line
- Follow each chapter title with 3-5 subtopics, each on its own line, indented with 3 spaces and a dash: "   - Subtopic"
- NO extra text, NO explanations, NO markdown
- Make titles descriptive and unique
- Example format:
Chapter 1: Getting Started
   - Core Concepts
   - Practical Steps
   - Common Mistakes
[... continues to Chapter 15]`;

  let attempts = 0;
  let lastRaw = '';

  while (attempts < 5) {
    const genOptions = { maxOutputTokens: 1000, temperature: 0.3, topP: 0.8 };
    try {
      const rawTOC = await askAI(prompt, userId, bookTopic, { saveToHistory: true, genOptions });
      lastRaw = rawTOC;
      
      logger.debug(`Raw TOC (attempt ${attempts + 1}):\n${rawTOC.substring(0, 500)}...`);
      
      const cleaned = cleanUpAIText(rawTOC);
      const parsed = parseTOC(cleaned);

      // <--- CHANGED: Validation check for 5 chapters
      if (parsed.length === 15 && parsed.every(c => c.subtopics.length >= 3)) {
        logger.info(`✅ TOC succeeded on attempt ${attempts + 1}`);
        return { raw: cleaned, parsed };
      }
      
      logger.warn(`❌ TOC invalid – attempt ${attempts + 1}: Got ${parsed.length} chapters`);
    } catch (e) {
      logger.error(`❌ TOC AI error – attempt ${attempts + 1}: ${e.message}`);
    }
    attempts++;
  }

  logger.warn(`⚠️ TOC failed after 5 attempts – using fallback for "${bookTopic}"`);
  return generateFallbackTOC(bookTopic);
}

async function generateChapter(bookTopic, chapterNumber, chapterInfo, userId) {
  // <--- CHANGED: Extract subtopics into a list string
  const subtopicList = chapterInfo.subtopics.map(s => `- ${s}`).join('\n');

  // 🔥 MATH FIX: Explicit Math Formatting Rules in Prompt
  const prompt = `Write Chapter ${chapterNumber}: "${chapterInfo.title}" for a book about "${bookTopic}".

CRITICAL FORMATTING RULES:
- Start with EXACTLY ONE heading: "## ${chapterInfo.title}"
- Do NOT repeat the title as a second heading
- Use ### for ALL subsections
- ALL tables MUST use strict GitHub Markdown table syntax
- NO trailing asterisks (*) on any lines
- NO HTML tags like <header> or <footer>
- 600+ words total

**MATH FORMATTING RULES (CRITICAL):**
- Use LaTeX for ALL mathematical expressions.
- Wrap **inline math** in single dollar signs, e.g., $E = mc^2$.
- Wrap **block math** (centered equations) in double dollar signs, e.g., $$x = \\frac{-b \\pm \\sqrt{b^2 - 4ac}}{2a}$$
- **DO NOT** escape the dollar signs (write $, not \\$).
- **DO NOT** escape LaTeX backslashes (write \\frac, not \\\\frac).
- Use standard LaTeX notation (e.g., x^2 for power, \\int for integral).

MANDATORY CONTENT STRUCTURE:
1) Introduction: A brief overview of the chapter.
2) KEY SECTIONS: You MUST create a specific subsection (### Heading) for EACH of the following subtopics:
${subtopicList}

3) Practical Application/Exercise: A real-world example or exercise.
4) Further Reading: 2-3 references.

Output ONLY the chapter content.`;

  return cleanUpAIText(await askAI(prompt, userId, bookTopic, {
    minLength: 1800,
    genOptions: { maxOutputTokens: 3500, temperature: 0.4 }
  }));
}

async function generateConclusion(bookTopic, chapterInfos, userId) {
  const titles = chapterInfos.map(c => c.title).join(', ');
  const prompt = `Write a professional conclusion for a book about "${bookTopic}".
Summarize these key topics: ${titles}
Include 3-5 authoritative resources with descriptions.

Use natural language and focus on summarizing the core concepts.
300-350 words, formal tone.

Output ONLY the conclusion content.`;

  return cleanUpAIText(await askAI(prompt, userId, bookTopic, {
    minLength: 1200,
    genOptions: { maxOutputTokens: 2000, temperature: 0.4 }
  }));
}

// ==================== PDF GENERATION ====================
function buildEnhancedHTML(content, bookTitle) {
  const cleaned = cleanUpAIText(content);
  const formattedContent = formatMath(cleaned);
  
  // Extract clean title for cover
  const titleMatch = cleaned.match(/^#\s+(.+)$/m);
  let displayTitle = titleMatch ? titleMatch[1] : bookTitle;
  displayTitle = displayTitle
    .replace(/^Chapter\s+\d+:\s*/i, '')
    .replace(/^\d+\.\s*/, '')
    .trim();

  // 🔥 MATH FIX: Updated MathJax config script + CLEAN URLS
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
      svg: { fontCache: 'none', scale: 0.95 }
    };
  </script>
  <script type="text/javascript" id="MathJax-script" async src="https://cdn.jsdelivr.net/npm/mathjax@3/es5/tex-mml-chtml.js "></script>
  <script src="https://cdn.jsdelivr.net/npm/prismjs@1.29.0/prism.min.js "></script>
  <script src="https://cdn.jsdelivr.net/npm/prismjs@1.29.0/components/prism-javascript.min.js "></script>
  <script src="https://cdn.jsdelivr.net/npm/prismjs@1.29.0/components/prism-python.min.js "></script>
  <script src="https://cdn.jsdelivr.net/npm/prismjs@1.29.0/components/prism-java.min.js "></script>
  <script src="https://cdn.jsdelivr.net/npm/prismjs@1.29.0/components/prism-cpp.min.js "></script>
  <script src="https://cdn.jsdelivr.net/npm/prismjs@1.29.0/components/prism-scala.min.js "></script>
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
  <div class="chapter-content">${marked.parse(formattedContent)}</div>
  <div class="disclaimer-footer">This book was generated by AI for educational purposes. Please verify all information independently.</div>
  <script>document.addEventListener('DOMContentLoaded', () => { Prism.highlightAll(); });</script>
</body>
</html>`;
}

async function generatePDF(content, outputPath, bookTitle) {
  try {
    const enhancedHtml = buildEnhancedHTML(content, bookTitle);
    
    const form = new FormData();
    const instructions = {
      parts: [{ html: "index.html" }],
      output: {
        format: "pdf",
        pdf: {
          margin: { top: "90px", bottom: "80px", left: "70px", right: "70px" },
          header: {
            content: '<div style="font-size: 10px; text-align: center; width: 100%; color: #6b7280;">Generated by bookgen.ai</div>',
            spacing: "5mm"
          },
          footer: {
            content: '<div style="font-size: 10px; text-align: center; width: 100%; color: #6b7280;">Page {pageNumber}</div>',
            spacing: "5mm"
          },
          waitDelay: 3000,
          printBackground: true,
          preferCSSPageSize: true
        }
      }
    };
    
    form.append('instructions', JSON.stringify(instructions));
    form.append('index.html', Buffer.from(enhancedHtml), {
      filename: 'index.html',
      contentType: 'text/html'
    });

    const response = await fetch('https://api.nutrient.io/build ', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${NUTRIENT_API_KEY}` },
      body: form
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Nutrient API error: ${response.status} - ${errorText}`);
    }

    const pdfBuffer = await response.buffer();
    fs.writeFileSync(outputPath, pdfBuffer);
    logger.info(`✅ PDF generated: ${outputPath}`);
    return outputPath;
  } catch (error) {
    logger.error(`❌ PDF generation failed: ${error.message}`);
    throw error;
  }
}

// ==================== MAIN GENERATOR ====================
export async function generateBookL(rawTopic, userId) {
  const bookTopic = rawTopic.replace(/^(generate|create|write)( me)? (a book )?(about )?/i, '').trim();
  const safeUserId = `${userId}-${bookTopic.replace(/\s+/g, '_').toLowerCase().slice(0, 50)}`;
  logger.info(`=== Starting: "${bookTopic}" for ${safeUserId} ===`);

  try {
    userHistories.delete(safeUserId);
    const { raw: tocRaw, parsed: chapterInfos } = await generateTOC(bookTopic, safeUserId);
    
    // Format TOC for PDF
    const formattedTOC = chapterInfos.map((ch, i) => {
      const num = i + 1;
      return `${num}. ${ch.title}\n${ch.subtopics.map(s => `   - ${s}`).join('\n')}`;
    }).join('\n\n');
    
    const tocFile = path.join(OUTPUT_DIR, `${CHAPTER_PREFIX}-${safeUserId}-toc.txt`);
    saveToFile(tocFile, `# Table of Contents\n\n${formattedTOC}\n\n---\n`);
    const files = [tocFile];

    // Generate chapters
    logger.info('Step 2/3: Generating chapters...');
    for (let i = 0; i < chapterInfos.length; i++) {
      if (global.cancelFlags?.[safeUserId]) {
        delete global.cancelFlags[safeUserId];
        throw new Error('Generation cancelled');
      }

      const chNum = i + 1;
      const info = chapterInfos[i];
      logger.info(` ${chNum}. ${info.title}`);
      
      const chapter = await generateChapter(bookTopic, chNum, info, safeUserId);
      const txt = `\n<div class="chapter-break"></div>\n\n# Chapter ${chNum}: ${info.title}\n\n${chapter}\n\n---\n`;
      
      const f = path.join(OUTPUT_DIR, `${CHAPTER_PREFIX}-${safeUserId}-${chNum}.txt`);
      saveToFile(f, txt);
      files.push(f);
    }

    // Generate conclusion
    logger.info('Step 3/3: Generating conclusion...');
    const conclusion = await generateConclusion(bookTopic, chapterInfos, safeUserId);
    const conclFile = path.join(OUTPUT_DIR, `${CHAPTER_PREFIX}-${safeUserId}-conclusion.txt`);
    saveToFile(conclFile, `\n<div class="chapter-break"></div>\n\n# Conclusion\n\n${conclusion}\n`);
    files.push(conclFile);

    // Combine and generate PDF
    logger.info('Combining content and generating PDF...');
    const combined = files.map(f => fs.readFileSync(f, 'utf8')).join('\n');
    const safeName = bookTopic.slice(0, 30).replace(/\s+/g, '_');
    const pdfPath = path.join(OUTPUT_DIR, `book_${safeUserId}_${safeName}.pdf`);
    
    await generatePDF(combined, pdfPath, bookTopic);

    // Cleanup
    files.forEach(deleteFile);
    userHistories.delete(safeUserId);
    
    logger.info(`=== SUCCESS: ${pdfPath} ===`);
    return pdfPath;
  } catch (e) {
    logger.error(`❌ Failed: ${e.message}`);
    throw e;
  }
}

// ==================== QUEUE SYSTEM ====================
const bookQueue = async.queue(async (task, callback) => {
  try {
    const result = await generateBookL(task.bookTopic, task.userId);
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




















// // AI/MB.js – FINAL FIXED VERSION: 5 Chapters, Subtopics Enforced
// import { GoogleGenerativeAI } from '@google/generative-ai';
// import { marked } from 'marked';
// import hljs from 'highlight.js';
// import fs from 'fs';
// import path from 'path';
// import { fileURLToPath } from 'url';
// import async from 'async';
// import winston from 'winston';
// import fetch from 'node-fetch';
// import FormData from 'form-data';
// import dotenv from 'dotenv';

// dotenv.config();


// const __filename = fileURLToPath(import.meta.url);
// const __dirname = path.dirname(__filename);

// // ==================== CORE SETUP ====================
// class RateLimiter {
//   constructor(requestsPerMinute) {
//     this.requestsPerMinute = requestsPerMinute;
//     this.requests = [];
//   }
//   async wait() {
//     const now = Date.now();
//     this.requests = this.requests.filter(t => now - t < 60000);
//     while (this.requests.length >= this.requestsPerMinute) {
//       const oldest = this.requests[0];
//       const waitTime = 60000 - (now - oldest) + 1000;
//       await new Promise(resolve => setTimeout(resolve, waitTime));
//     }
//     this.requests.push(Date.now());
//   }
// }

// const globalRateLimiter = new RateLimiter(15);
// const HISTORY_DIR = path.join(__dirname, 'history');
// const OUTPUT_DIR = path.join(__dirname, '../pdfs');
// const CHAPTER_PREFIX = 'chapter';
// const MODEL_NAME = 'gemini-2.5-flash-lite'; // Updated model name if needed
// const NUTRIENT_API_KEY = process.env.NUTRIENT_API_KEY;

// let genAI = null;
// function ensureGenAI() {
//   if (genAI) return genAI;
//   const key = process.env.GEMINI_API_KEY;
//   if (!key) {
//     throw new Error('GEMINI_API_KEY is not set in environment. Configure it in your deployment or .env file.');
//   }
//   genAI = new GoogleGenerativeAI(key);
//   return genAI;
// }
// const userHistories = new Map();

// const logger = winston.createLogger({
//   level: 'info',
//   format: winston.format.combine(winston.format.timestamp(), winston.format.json()),
//   transports: [
//     new winston.transports.File({ filename: 'bookgen.log' }),
//     new winston.transports.Console({ format: winston.format.simple() })
//   ]
// });

// fs.mkdirSync(HISTORY_DIR, { recursive: true });
// fs.mkdirSync(OUTPUT_DIR, { recursive: true });

// // ==================== TEXT PROCESSING ====================
// function cleanUpAIText(text) {
//   if (!text) return '';
//   return text
//     .replace(/^(?:Hi|Hello|Hey|Sure|Here).*?(\n\n|$)/gis, '')
//     .replace(/<\/?(header|footer|figure|figcaption)[^>]*>/gi, '')
//     .replace(/^\s*Table of Contents\s*$/gim, '')
//     .replace(/(\d+)([a-zA-Z]+)/g, '$1 $2')
//     .replace(/\b([A-Z])\s+([a-z]{2,})\b/g, (match, p1, p2) => {
//       if (match.includes('`') || match.includes('```')) return match;
//       return p1 + p2;
//     })
//     .replace(/\\([[\]{}()])/g, '$1')
//     .replace(/\n{3,}/g, '\n\n')
//     .replace(/[\u2013\u2014]/g, '-')
//     .replace(/\*\s*$/gm, '')
//     .trim();
// }

// function formatMath(content) {
//   const tables = [];
//   const codeBlocks = [];

//   // Protect tables (GitHub-style)
//   content = content.replace(/(\|.+\|[\s]*\n\|[-:\s|]+\|[\s]*\n(?:\|.*\|[\s]*\n?)*)/g, (tbl) => {
//     tables.push(tbl);
//     return `__TABLE__${tables.length - 1}__`;
//   });

//   // Protect fenced code
//   content = content.replace(/```[\w]*\n([\s\S]*?)```/g, (match, code) => {
//     codeBlocks.push(match);
//     return `__CODE__${codeBlocks.length - 1}__`;
//   });

//   // Protect inline code
//   content = content.replace(/`([^`]+)`/g, (match) => {
//     codeBlocks.push(match);
//     return `__CODE__${codeBlocks.length - 1}__`;
//   });

//   // ======== FIX MATH ========
//   content = content.replace(/\b(\d+)\s*\/\s*(\d+)\b/g, '\\(\\\\frac{$1}{$2}\\\\)');
//   content = content.replace(/\b([a-zA-Z0-9]+)\s*\^\s*([a-zA-Z0-9]+)\b/g, '\\($1^{$2}\\)');
//   content = content.replace(/\b(\d+)e(\d+)\b/gi, '\\($1 \\times 10^{$2}\\)');

//   // Restore tables
//   content = content.replace(/__TABLE__(\d+)__/g, (_, i) => tables[i]);
//   // Restore code blocks
//   content = content.replace(/__CODE__(\d+)__/g, (_, i) => codeBlocks[i]);

//   return content;
// }

// // ==================== MARKED SETUP ====================
// marked.setOptions({
//   headerIds: false,
//   breaks: true,
//   gfm: true,
//   highlight: function(code, lang) {
//     if (lang && hljs.getLanguage(lang)) {
//       return hljs.highlight(code, { language: lang }).value;
//     }
//     return code;
//   }
// });

// // ==================== HELPER FUNCTIONS ====================
// function getHistoryFile(userId) {
//   return path.join(HISTORY_DIR, `history-${userId}.json`);
// }

// function loadConversationHistory(userId) {
//   try {
//     return JSON.parse(fs.readFileSync(getHistoryFile(userId), 'utf8'));
//   } catch {
//     return [];
//   }
// }

// function saveConversationHistory(userId, history) {
//   fs.writeFileSync(getHistoryFile(userId), JSON.stringify(history, null, 2));
// }

// function saveToFile(filename, content) {
//   fs.writeFileSync(filename, content);
//   logger.info(`Saved: ${filename}`);
// }

// function deleteFile(filePath) {
//   try {
//     fs.unlinkSync(filePath);
//   } catch {
//     logger.warn(`Delete failed: ${filePath}`);
//   }
// }

// // ==================== TOC PARSER ====================
// function parseTOC(tocContent) {
//   const lines = tocContent.split('\n').map(l => l.trimEnd()).filter(l => l.trim());
//   const chapters = [];
//   let current = null;

//   for (let i = 0; i < lines.length; i++) {
//     let line = lines[i];
    
//     if (!line) continue;

//     if (line.length === 1 && /^[A-Z]$/.test(line) && i + 1 < lines.length) {
//       const nextLine = lines[i + 1];
//       if (nextLine && nextLine.length > 5 && !nextLine.match(/^[\s]*[-•*·\d]/) && !nextLine.startsWith(' ')) {
//         line = line + nextLine;
//         i++;
//       }
//     }

//     const chapterMatch = line.match(/^Chapter\s+\d+:\s*(.+)$/i);
//     const simpleMatch = line.match(/^(?:\d+[\.\):]|\d+\s+|[-\*•])\s*(.+)$/i);
//     const chapMatch = chapterMatch || simpleMatch;
    
//     if (chapMatch && !line.startsWith('  -') && !line.match(/^[\s]*[-•*·]/)) {
//       let title = chapMatch[1].trim();
//       title = title.replace(/[:–—*]\s*$/, '').trim();
//       title = title.replace(/^\d+\.\s*/, '');
      
//       if (title && title.length > 10 && !/^(introduction|chapter|basics|overview|conclusion)$/i.test(title)) {
//         if (current) chapters.push(current);
//         current = { title, subtopics: [] };
//       }
//     } else if (current && line.match(/^[\s]*[-•*·]\s+(.+)$/)) {
//       const sub = line.match(/^[\s]*[-•*·]\s+(.+)$/)[1].trim();
//       if (sub && sub.length > 5 && !/^(subtopic|section|part)/i.test(sub)) {
//         current.subtopics.push(sub);
//       }
//     }
//   }
//   if (current) chapters.push(current);

//   const valid = chapters.filter(c => c.subtopics.length >= 3);
//   logger.debug(`✅ Parsed ${valid.length} valid chapters out of ${chapters.length} total`);
  
//   // <--- CHANGED: Changed from 10 to 5 to force limit
//   return valid.slice(0, 15); 
// }

// function generateFallbackTOC(bookTopic) {
//   const cleanTopic = bookTopic.replace(/\bin\s+.*$/i, '').trim();
  
//   // <--- CHANGED: Reduced fallback to 5 chapters
//  const base = [
//   "Foundational Framework: Core Concepts, Terminology, and Theoretical Underpinnings",
//   "Methodological Mastery: Essential Principles, Standards, and Workflow Design",
//   "System Architecture: Component Analysis, Data Flows, and Interaction Models",
//   "Practical Implementation: Hands-On Techniques, Tools, and Development Workflows",
//   "Advanced Paradigms: Complex Topics, Research Frontiers, and Emerging Trends",
//   "Industry Validation: Comprehensive Case Studies and Real-World Application Analysis",
//   "Strategic Deployment: Phased Implementation, Change Management, and Adoption Strategies",
//   "Performance Optimization: Benchmarking, Tuning, and Efficiency Maximization",
//   "Reliability Engineering: Troubleshooting, Debugging, and Failure Recovery",
//   "Innovation Landscape: Future Directions, Disruptive Technologies, and Market Evolution",
//   "Ecosystem Architecture: Integration Patterns, API Design, and Interoperability Standards",
//   "Quality Assurance Framework: Testing Strategies, Validation Protocols, and CI/CD",
//   "Security Engineering: Threat Modeling, Risk Assessment, and Defense-in-Depth",
//   "Scalability and Resilience: Distributed Design, Load Balancing, and Fault Tolerance",
//   "Transformational Change: Next-Gen Research, Emerging Paradigms, and Strategic Vision"
// ];
  
//   const isTechName = cleanTopic.length > 2 && cleanTopic.length < 20 && !cleanTopic.includes(' ');
//   const suffix = isTechName ? ` in ${cleanTopic}` : '';
  
//   const chapters = base.map((t, i) => ({
//     title: `${t}${suffix}`,
//     subtopics: [
//       "Understanding the core concept",
//       "Practical applications",
//       "Common challenges and how to address them"
//     ]
//   }));
  
//   const raw = chapters.map(c =>
//     `${c.title}\n${c.subtopics.map(s => `    - ${s}`).join('\n')}`
//   ).join('\n');
  
//   return { raw, parsed: chapters };
// }

// // ==================== AI INTERACTION ====================
// async function askAI(prompt, userId, bookTopic, options = {}) {
//   await globalRateLimiter.wait();

//   const genCfg = options.genOptions || { maxOutputTokens: 4000, temperature: 0.7, topP: 0.9 };
//   const model = ensureGenAI().getGenerativeModel({ model: MODEL_NAME, generationConfig: genCfg });

//   const maxRetries = 3;
//   for (let attempt = 0; attempt < maxRetries; attempt++) {
//     try {
//       const result = await model.generateContent(prompt);
      
//       let reply = '';
//       if (result.response && typeof result.response.text === 'function') {
//         reply = await result.response.text();
//       } else if (result.candidates?.[0]?.content?.parts?.[0]?.text) {
//         reply = result.candidates[0].content.parts[0].text;
//       } else if (result.output && Array.isArray(result.output)) {
//         reply = result.output.map(o => (o?.content || o?.text || '')).join('\n');
//       } else if (result.text) {
//         reply = result.text;
//       }
      
//       reply = (reply || '').toString().trim();

//       if (!reply || reply.length < 50) {
//         logger.warn(`Empty reply on attempt ${attempt + 1}, retrying...`);
//         if (attempt < maxRetries - 1) await new Promise(r => setTimeout(r, 2000 * (attempt + 1)));
//         continue;
//       }

//       if (options.minLength && reply.length < options.minLength) {
//         throw new Error(`Response too short: ${reply.length} < ${options.minLength}`);
//       }

//       if (options.saveToHistory) {
//         const hist = userHistories.get(userId) || [];
//         hist.push({ role: 'user', content: prompt });
//         hist.push({ role: 'assistant', content: reply });
//         userHistories.set(userId, hist);
//         saveConversationHistory(userId, hist);
//       }
//       return reply;
//     } catch (e) {
//       logger.error(`AI call error (attempt ${attempt + 1}): ${e.message}`);
//       if (attempt === maxRetries - 1) throw e;
//       await new Promise(r => setTimeout(r, 3000 * (attempt + 1)));
//     }
//   }
// }

// // ==================== CONTENT GENERATION ====================
// async function generateTOC(bookTopic, userId) {
//   // <--- CHANGED: Requested EXACTLY 5 chapters in prompt
//   const prompt = `Create a detailed table of contents for a book about "${bookTopic}".
// REQUIREMENTS (FOLLOW EXACTLY):
// - Output EXACTLY 15 chapters
// - Use the format: "Chapter X: Title" on its own line
// - Follow each chapter title with 3-5 subtopics, each on its own line, indented with 3 spaces and a dash: "   - Subtopic"
// - NO extra text, NO explanations, NO markdown
// - Make titles descriptive and unique
// - Example format:
// Chapter 1: Getting Started
//    - Core Concepts
//    - Practical Steps
//    - Common Mistakes
// [... continues to Chapter 15]`;

//   let attempts = 0;
//   let lastRaw = '';

//   while (attempts < 5) {
//     const genOptions = { maxOutputTokens: 1000, temperature: 0.3, topP: 0.8 };
//     try {
//       const rawTOC = await askAI(prompt, userId, bookTopic, { saveToHistory: true, genOptions });
//       lastRaw = rawTOC;
      
//       logger.debug(`Raw TOC (attempt ${attempts + 1}):\n${rawTOC.substring(0, 500)}...`);
      
//       const cleaned = cleanUpAIText(rawTOC);
//       const parsed = parseTOC(cleaned);

//       // <--- CHANGED: Validation check for 5 chapters
//       if (parsed.length === 15 && parsed.every(c => c.subtopics.length >= 3)) {
//         logger.info(`✅ TOC succeeded on attempt ${attempts + 1}`);
//         return { raw: cleaned, parsed };
//       }
      
//       logger.warn(`❌ TOC invalid – attempt ${attempts + 1}: Got ${parsed.length} chapters`);
//     } catch (e) {
//       logger.error(`❌ TOC AI error – attempt ${attempts + 1}: ${e.message}`);
//     }
//     attempts++;
//   }

//   logger.warn(`⚠️ TOC failed after 5 attempts – using fallback for "${bookTopic}"`);
//   return generateFallbackTOC(bookTopic);
// }

// async function generateChapter(bookTopic, chapterNumber, chapterInfo, userId) {
//   // <--- CHANGED: Extract subtopics into a list string
//   const subtopicList = chapterInfo.subtopics.map(s => `- ${s}`).join('\n');

//   // <--- CHANGED: Updated prompt to enforce specific subtopics
//   const prompt = `Write Chapter ${chapterNumber}: "${chapterInfo.title}" for a book about "${bookTopic}".

// CRITICAL FORMATTING RULES:
// - Start with EXACTLY ONE heading: "## ${chapterInfo.title}"
// - Do NOT repeat the title as a second heading
// - Use ### for ALL subsections
// - ALL tables MUST use strict GitHub Markdown table syntax
// - NO trailing asterisks (*) on any lines
// - NO HTML tags like <header> or <footer>
// - 600+ words total

// MANDATORY CONTENT STRUCTURE:
// 1) Introduction: A brief overview of the chapter.
// 2) KEY SECTIONS: You MUST create a specific subsection (### Heading) for EACH of the following subtopics:
// ${subtopicList}

// 3) Practical Application/Exercise: A real-world example or exercise.
// 4) Further Reading: 2-3 references.

// INSTRUCTIONS:
// - For each subtopic listed above, explain it in detail.
// - Use code examples ONLY if the topic is technical (programming/data).
// - If writing code, use fenced code blocks like \`\`\`python or \`\`\`javascript.
// - Use tables when comparing items.
// - Ensure the flow is natural between subtopics.

// Output ONLY the chapter content.`;

//   return cleanUpAIText(await askAI(prompt, userId, bookTopic, {
//     minLength: 1800,
//     genOptions: { maxOutputTokens: 3500, temperature: 0.4 }
//   }));
// }

// async function generateConclusion(bookTopic, chapterInfos, userId) {
//   const titles = chapterInfos.map(c => c.title).join(', ');
//   const prompt = `Write a professional conclusion for a book about "${bookTopic}".
// Summarize these key topics: ${titles}
// Include 3-5 authoritative resources with descriptions.

// Use natural language and focus on summarizing the core concepts.
// 300-350 words, formal tone.

// Output ONLY the conclusion content.`;

//   return cleanUpAIText(await askAI(prompt, userId, bookTopic, {
//     minLength: 1200,
//     genOptions: { maxOutputTokens: 2000, temperature: 0.4 }
//   }));
// }

// // ==================== PDF GENERATION ====================
// function buildEnhancedHTML(content, bookTitle) {
//   const cleaned = cleanUpAIText(content);
//   const formattedContent = formatMath(cleaned);
  
//   // Extract clean title for cover
//   const titleMatch = cleaned.match(/^#\s+(.+)$/m);
//   let displayTitle = titleMatch ? titleMatch[1] : bookTitle;
//   displayTitle = displayTitle
//     .replace(/^Chapter\s+\d+:\s*/i, '')
//     .replace(/^\d+\.\s*/, '')
//     .trim();

//   return `<!DOCTYPE html>
// <html lang="en">
// <head>
//   <meta charset="utf-8">
//   <meta name="viewport" content="width=device-width, initial-scale=1.0">
//   <title>${displayTitle} - Bookgen.ai</title>
//   <link rel="preconnect" href="[https://fonts.googleapis.com](https://fonts.googleapis.com)">
//   <link rel="preconnect" href="[https://fonts.gstatic.com](https://fonts.gstatic.com)" crossorigin>
//   <link href="[https://fonts.googleapis.com/css2?family=Merriweather:wght@300;400;700&family=Inter:wght@400;600;700&display=swap](https://fonts.googleapis.com/css2?family=Merriweather:wght@300;400;700&family=Inter:wght@400;600;700&display=swap)" rel="stylesheet">
//   <script>
//     window.MathJax = {
//       tex: { inlineMath: [['\\\\(', '\\\\)']], displayMath: [['$$', '$$']] },
//       svg: { fontCache: 'none', scale: 0.95 }
//     };
//   </script>
//   <script type="text/javascript" id="MathJax-script" async src="[https://cdn.jsdelivr.net/npm/mathjax@3/es5/tex-mml-chtml.js](https://cdn.jsdelivr.net/npm/mathjax@3/es5/tex-mml-chtml.js)"></script>
//   <script src="[https://cdn.jsdelivr.net/npm/prismjs@1.29.0/prism.min.js](https://cdn.jsdelivr.net/npm/prismjs@1.29.0/prism.min.js)"></script>
//   <script src="[https://cdn.jsdelivr.net/npm/prismjs@1.29.0/components/prism-javascript.min.js](https://cdn.jsdelivr.net/npm/prismjs@1.29.0/components/prism-javascript.min.js)"></script>
//   <script src="[https://cdn.jsdelivr.net/npm/prismjs@1.29.0/components/prism-python.min.js](https://cdn.jsdelivr.net/npm/prismjs@1.29.0/components/prism-python.min.js)"></script>
//   <script src="[https://cdn.jsdelivr.net/npm/prismjs@1.29.0/components/prism-java.min.js](https://cdn.jsdelivr.net/npm/prismjs@1.29.0/components/prism-java.min.js)"></script>
//   <script src="[https://cdn.jsdelivr.net/npm/prismjs@1.29.0/components/prism-cpp.min.js](https://cdn.jsdelivr.net/npm/prismjs@1.29.0/components/prism-cpp.min.js)"></script>
//   <script src="[https://cdn.jsdelivr.net/npm/prismjs@1.29.0/components/prism-scala.min.js](https://cdn.jsdelivr.net/npm/prismjs@1.29.0/components/prism-scala.min.js)"></script>
//   <link href="[https://cdn.jsdelivr.net/npm/prismjs@1.29.0/themes/prism-tomorrow.min.css](https://cdn.jsdelivr.net/npm/prismjs@1.29.0/themes/prism-tomorrow.min.css)" rel="stylesheet">
//   <style>
//     @page { margin: 90px 70px 80px 70px; size: A4; }
//     .cover-page { page: cover; }
//     @page cover { margin: 0; @top-center { content: none; } @bottom-center { content: none; } }
//     body { font-family: 'Merriweather', Georgia, serif; font-size: 14px; line-height: 1.8; color: #1f2937; background: white; margin: 0; padding: 0; text-align: justify; hyphens: auto; }
//     .cover-page { display: flex; flex-direction: column; justify-content: center; align-items: center; height: 100vh; page-break-after: always; text-align: center; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; margin: -90px -70px -80px -70px; padding: 70px; }
//     .cover-title { font-family: 'Inter', sans-serif; font-size: 48px; font-weight: 700; margin-bottom: 0.3em; line-height: 1.2; text-shadow: 2px 2px 4px rgba(0,0,0,0.1); }
//     .cover-subtitle { font-family: 'Inter', sans-serif; font-size: 24px; font-weight: 300; margin-bottom: 2em; opacity: 0.9; }
//     .cover-meta { position: absolute; bottom: 60px; font-size: 14px; font-weight: 300; opacity: 0.8; }
//     .cover-disclaimer { margin-top: 30px; font-size: 12px; color: #fecaca; font-style: italic; }
//     h1, h2, h3, h4 { font-family: 'Inter', sans-serif; font-weight: 600; color: #1f2937; margin-top: 2.5em; margin-bottom: 0.8em; position: relative; }
//     h1 { font-size: 28px; border-bottom: 3px solid #667eea; padding-bottom: 15px; margin-top: 0; page-break-before: always; }
//     h1::after { content: ""; display: block; width: 80px; height: 3px; background: #764ba2; margin-top: 15px; }
//     h2 { font-size: 22px; border-bottom: 2px solid #e5e7eb; padding-bottom: 8px; color: #4b5563; }
//     h3 { font-size: 18px; color: #6b7280; }
//     .chapter-content > h1 + p::first-letter { float: left; font-size: 4em; line-height: 1; margin: 0.1em 0.1em 0 0; font-weight: 700; color: #667eea; font-family: 'Inter', sans-serif; }
//     code { background: #f3f4f6; padding: 3px 8px; border: 1px solid #e5e7eb; font-family: 'Fira Code', 'Courier New', monospace; font-size: 13px; border-radius: 4px; color: #1e40af; }
//     pre { background: #1f2937; padding: 20px; overflow-x: auto; border: 1px solid #4b5563; border-radius: 8px; line-height: 1.5; margin: 1.5em 0; white-space: pre-wrap; word-wrap: break-word; box-shadow: 0 4px 6px rgba(0, 0, 0, 0.05); }
//     pre code { background: none; border: none; padding: 0; color: #e5e7eb; }
//     blockquote { border-left: 4px solid #667eea; margin: 2em 0; padding: 1em 1.5em; background: linear-gradient(to right, #f3f4f6 0%, #ffffff 100%); font-style: italic; border-radius: 0 8px 8px 0; position: relative; }
//     blockquote::before { content: "“"; position: absolute; top: -20px; left: 10px; font-size: 80px; color: #d1d5db; font-family: 'Inter', sans-serif; line-height: 1; }
//     .example { background: linear-gradient(to right, #eff6ff 0%, #ffffff 100%); border-left: 4px solid #3b82f6; padding: 20px; margin: 2em 0; border-radius: 0 8px 8px 0; font-style: italic; position: relative; }
//     .example::before { content: "💡 Example"; display: block; font-weight: 600; color: #1d4ed8; margin-bottom: 10px; font-style: normal; }
//     table { width: 100%; border-collapse: collapse; margin: 2em 0; box-shadow: 0 1px 3px rgba(0, 0, 0, 0.1); }
//     th { background: #374151; color: white; padding: 12px; text-align: left; font-family: 'Inter', sans-serif; font-weight: 600; }
//     td { padding: 12px; border-bottom: 1px solid #e5e7eb; }
//     tr:nth-child(even) { background: #f9fafb; }
//     .MathJax_Display { margin: 2em 0 !important; padding: 1em 0; overflow-x: auto; }
//     .disclaimer-footer { margin-top: 4em; padding-top: 2em; border-top: 2px solid #e5e7eb; font-size: 12px; color: #6b7280; font-style: italic; text-align: center; }
//   </style>
// </head>
// <body>
//   <div class="cover-page">
//     <div class="cover-content">
//       <h1 class="cover-title">Bookgen.AI</h1>
//       <h2 class="cover-subtitle">A Guide book</h2>
//       <div class="cover-disclaimer">⚠️ Caution: AI-generated content may contain errors</div>
//     </div>
//     <div class="cover-meta">Generated by Bookgen.ai<br>${new Date().toLocaleDateString()}</div>
//   </div>
//   <div class="chapter-content">${marked.parse(formattedContent)}</div>
//   <div class="disclaimer-footer">This book was generated by AI for educational purposes. Please verify all information independently.</div>
//   <script>document.addEventListener('DOMContentLoaded', () => { Prism.highlightAll(); });</script>
// </body>
// </html>`;
// }

// async function generatePDF(content, outputPath, bookTitle) {
//   try {
//     const enhancedHtml = buildEnhancedHTML(content, bookTitle);
    
//     const form = new FormData();
//     const instructions = {
//       parts: [{ html: "index.html" }],
//       output: {
//         format: "pdf",
//         pdf: {
//           margin: { top: "90px", bottom: "80px", left: "70px", right: "70px" },
//           header: {
//             content: '<div style="font-size: 10px; text-align: center; width: 100%; color: #6b7280;">Generated by bookgen.ai</div>',
//             spacing: "5mm"
//           },
//           footer: {
//             content: '<div style="font-size: 10px; text-align: center; width: 100%; color: #6b7280;">Page {pageNumber}</div>',
//             spacing: "5mm"
//           },
//           waitDelay: 3000,
//           printBackground: true,
//           preferCSSPageSize: true
//         }
//       }
//     };
    
//     form.append('instructions', JSON.stringify(instructions));
//     form.append('index.html', Buffer.from(enhancedHtml), {
//       filename: 'index.html',
//       contentType: 'text/html'
//     });

//     //const response = await fetch('[https://api.nutrient.io/build](https://api.nutrient.io/build)', {
//     const response = await fetch('https://api.nutrient.io/build', {
//       method: 'POST',
//       headers: { 'Authorization': `Bearer ${NUTRIENT_API_KEY}` },
//       body: form
//     });

//     if (!response.ok) {
//       const errorText = await response.text();
//       throw new Error(`Nutrient API error: ${response.status} - ${errorText}`);
//     }

//     const pdfBuffer = await response.buffer();
//     fs.writeFileSync(outputPath, pdfBuffer);
//     logger.info(`✅ PDF generated: ${outputPath}`);
//     return outputPath;
//   } catch (error) {
//     logger.error(`❌ PDF generation failed: ${error.message}`);
//     throw error;
//   }
// }

// // ==================== MAIN GENERATOR ====================
// export async function generateBookL(rawTopic, userId) {
//   const bookTopic = rawTopic.replace(/^(generate|create|write)( me)? (a book )?(about )?/i, '').trim();
//   const safeUserId = `${userId}-${bookTopic.replace(/\s+/g, '_').toLowerCase().slice(0, 50)}`;
//   logger.info(`=== Starting: "${bookTopic}" for ${safeUserId} ===`);

//   try {
//     userHistories.delete(safeUserId);
//     const { raw: tocRaw, parsed: chapterInfos } = await generateTOC(bookTopic, safeUserId);
    
//     // Format TOC for PDF
//     const formattedTOC = chapterInfos.map((ch, i) => {
//       const num = i + 1;
//       return `${num}. ${ch.title}\n${ch.subtopics.map(s => `   - ${s}`).join('\n')}`;
//     }).join('\n\n');
    
//     const tocFile = path.join(OUTPUT_DIR, `${CHAPTER_PREFIX}-${safeUserId}-toc.txt`);
//     saveToFile(tocFile, `# Table of Contents\n\n${formattedTOC}\n\n---\n`);
//     const files = [tocFile];

//     // Generate chapters
//     logger.info('Step 2/3: Generating chapters...');
//     for (let i = 0; i < chapterInfos.length; i++) {
//       if (global.cancelFlags?.[safeUserId]) {
//         delete global.cancelFlags[safeUserId];
//         throw new Error('Generation cancelled');
//       }

//       const chNum = i + 1;
//       const info = chapterInfos[i];
//       logger.info(` ${chNum}. ${info.title}`);
      
//       const chapter = await generateChapter(bookTopic, chNum, info, safeUserId);
//       const txt = `\n<div class="chapter-break"></div>\n\n# Chapter ${chNum}: ${info.title}\n\n${chapter}\n\n---\n`;
      
//       const f = path.join(OUTPUT_DIR, `${CHAPTER_PREFIX}-${safeUserId}-${chNum}.txt`);
//       saveToFile(f, txt);
//       files.push(f);
//     }

//     // Generate conclusion
//     logger.info('Step 3/3: Generating conclusion...');
//     const conclusion = await generateConclusion(bookTopic, chapterInfos, safeUserId);
//     const conclFile = path.join(OUTPUT_DIR, `${CHAPTER_PREFIX}-${safeUserId}-conclusion.txt`);
//     saveToFile(conclFile, `\n<div class="chapter-break"></div>\n\n# Conclusion\n\n${conclusion}\n`);
//     files.push(conclFile);

//     // Combine and generate PDF
//     logger.info('Combining content and generating PDF...');
//     const combined = files.map(f => fs.readFileSync(f, 'utf8')).join('\n');
//     const safeName = bookTopic.slice(0, 30).replace(/\s+/g, '_');
//     const pdfPath = path.join(OUTPUT_DIR, `book_${safeUserId}_${safeName}.pdf`);
    
//     await generatePDF(combined, pdfPath, bookTopic);

//     // Cleanup
//     files.forEach(deleteFile);
//     userHistories.delete(safeUserId);
    
//     logger.info(`=== SUCCESS: ${pdfPath} ===`);
//     return pdfPath;
//   } catch (e) {
//     logger.error(`❌ Failed: ${e.message}`);
//     throw e;
//   }
// }

// // ==================== QUEUE SYSTEM ====================
// const bookQueue = async.queue(async (task, callback) => {
//   try {
//     const result = await generateBookL(task.bookTopic, task.userId);
//     callback(null, result);
//   } catch (error) {
//     callback(error);
//   }
// }, 1);

// export function queueBookGeneration(bookTopic, userId) {
//   return new Promise((resolve, reject) => {
//     bookQueue.push({ bookTopic, userId }, (error, result) => {
//       if (error) reject(error);
//       else resolve(result);
//     });
//   });
// }

// generateBookL



























// import { Together } from "together-ai";
// import { marked } from 'marked';
// import hljs from 'highlight.js';
// import PDFDocument from 'pdfkit';
// import fs from 'fs';
// import path, { dirname } from 'path';
// import { fileURLToPath } from 'url';
// import async from 'async';
// import winston from 'winston';
// import pkg from 'pdfkit-table';
// const { addTable } = pkg;
// import katex from 'katex';
// import pkg2pdf from 'svg2pdf.js';
// const { SVGtoPDF } = pkg2pdf;


// // Load environment variables
// //dotenv.config();

// const __filename = fileURLToPath(import.meta.url);
// const __dirname = dirname(__filename);

// // Constants
// const HISTORY_DIR = path.join(__dirname, 'history');
// const CHAPTER_PREFIX = 'chapter';
// const OUTPUT_DIR = path.join(__dirname, '../pdfs');
// const COMBINED_FILE = 'combined-chapters.txt';

// // Logger Setup
// const logger = winston.createLogger({
//   level: 'info',
//   format: winston.format.combine(
//     winston.format.timestamp(),
//     winston.format.json()
//   ),
//   transports: [
//     new winston.transports.File({ filename: 'bookgen.log' }),
//     new winston.transports.Console()
//   ]
// });

// // Ensure directories exist
// if (!fs.existsSync(HISTORY_DIR)) fs.mkdirSync(HISTORY_DIR);
// if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR);

// // Init
// const together = new Together({
//   apiKey: '18a96a823e402ef5dfedc1e372bf50fc8e6357bb25a0eff0bea25a07f51a1087', // Fallback for local testing
// });

// // Markdown & Code Highlighting
// marked.setOptions({
//   highlight: (code, lang) => {
//     const validLang = hljs.getLanguage(lang) ? lang : 'plaintext';
//     return hljs.highlight(code, { language: validLang }).value;
//   }
// });

// // Per-user conversation history
// const userHistories = new Map();

// // === Utilities ===
// function getHistoryFile(userId) {
//   return path.join(HISTORY_DIR, `history-${userId}.json`);
// }

// function loadConversationHistory(userId) {
//   const historyFile = getHistoryFile(userId);
//   try {
//     return JSON.parse(fs.readFileSync(historyFile, 'utf8'));
//   } catch {
//     logger.info(`No history found for user ${userId}. Starting fresh.`);
//     return [];
//   }
// }

// function saveConversationHistory(userId, history) {
//   const trimmed = trimHistory(history);
//   fs.writeFileSync(getHistoryFile(userId), JSON.stringify(trimmed, null, 2));
//   logger.info(`Saved history for user ${userId}`);
// }

// function trimHistory(messages) {
//   const tocMessage = messages.find(
//     (msg) => msg.role === "assistant" && msg.content.toLowerCase().includes("table of contents")
//   );
//   return tocMessage ? [{
//     role: "system",
//     content:
//       "Your name is Hailu. You are a kind, smart teacher explaining to a curious kid so you got to explain every single detail and also don't make them know they are a little curous kid. Use simple, clear words, break down complex ideas step-by-step, and include human-like examples. Always start with a table of contents, then write chapters. Focus only on the requested topic, ignore unrelated contexts. Table of Contents:\n\n" +
//       tocMessage.content,
//   }] : [];
// }

// function saveToFile(filename, content) {
//   fs.writeFileSync(filename, content);
//   logger.info(`Saved: ${filename}`);
// }

// function deleteFile(filePath) {
//   try {
//     fs.unlinkSync(filePath);
//     logger.info(`Deleted: ${filePath}`);
//   } catch (err) {
//     logger.error(`Error deleting ${filePath}: ${err.message}`);
//   }
// }

// function combineChapters(files) {
//   let combined = '';
//   for (const file of files) {
//     combined += fs.readFileSync(file, 'utf8') + '\n\n';
//   }
//   fs.writeFileSync(path.join(OUTPUT_DIR, COMBINED_FILE), combined);
//   return combined;
// }

// // === AI ===
// async function askAI(prompt, userId, bookTopic) {
//   const history = userHistories.get(userId) || [];
//   const trimmedHistory = trimHistory(history);
//   const messages = [...trimmedHistory, { role: 'user', content: prompt }];

//   try {
//     const response = await together.chat.completions.create({
//       messages,
//       model: "deepseek-ai/DeepSeek-R1-Distill-Llama-70B-free",
//       top_p: 0.9,
//       temperature: 0.6,
//       presence_penalty: 0.3,
//       frequency_penalty: 0.3,
//       max_tokens: 3000
//     });

//     let reply = response.choices[0].message.content
//       .replace(/<think>[\s\S]*?<\/think>/gi, '')
//       .replace(/^I'm DeepSeek-R1.*?help you\.\s*/i, '')
//       .trim();

//     const topicWords = bookTopic.toLowerCase().split(/\s+/);
//     const isRelevant = topicWords.some(word => reply.toLowerCase().includes(word));

//     if (!isRelevant) {
//       logger.warn(`🛑 Irrelevant output detected for [${userId}] on topic "${bookTopic}": ${reply.slice(0, 80)}...`);
//       throw new Error(`Output does not appear relevant to topic: "${bookTopic}"`);
//     }

//     history.push({ role: 'user', content: prompt });
//     history.push({ role: 'assistant', content: reply });
//     userHistories.set(userId, history);
//     saveConversationHistory(userId, history);

//     logger.info(`✅ Valid AI response saved for [${userId}] on topic "${bookTopic}"`);
//     return reply;

//   } catch (error) {
//     logger.error(`❌ AI request failed for [${userId}] on topic "${bookTopic}": ${error.message}`);
//     throw error;
//   }
// }

// // === Chapter ===
// async function generateChapter(prompt, chapterNum, userId, bookTopic) {
//   const history = userHistories.get(userId) || [];
//   const toc = history.find(
//     (msg) => msg.role === 'assistant' && msg.content.toLowerCase().includes('table of contents')
//   );

//   const modifiedPrompt = toc
//     ? `${prompt}\n\nRefer to this Table of Contents:\n\n${toc.content}`
//     : prompt;

//   const chapterText = await askAI(modifiedPrompt, userId, bookTopic);
//   const filename = path.join(OUTPUT_DIR, `${CHAPTER_PREFIX}-${userId}-${chapterNum}.txt`);
//   saveToFile(filename, chapterText);
//   return filename;
// }

// // === Formatter ===
// function cleanUpAIText(text) {
//   return text
//     .replace(/^(?:[-=_~\s]{5,})$/gm, "")
//     .replace(/\n{3,}/g, "\n\n")
//     .replace(/\n\s*$/g, "")
//     .replace(/[\u2013\u2014]/g, "-")
//     .trim();
// }

// // === Math Rendering Helper ===
// function renderMathToPDF(doc, mathStr, yOffset = 15) {
//   try {
//     const svg = katex.renderToString(mathStr.trim(), { output: 'mathml' });
//     const svgElement = new DOMParser().parseFromString(svg, "image/svg+xml");
//     const x = (doc.page.width - 200) / 2; // Center math blocks
//     SVGtoPDF(doc, svgElement.documentElement, x, doc.y + yOffset);
//     return true;
//   } catch (error) {
//     logger.error(`Math rendering failed: ${error.message}`);
//     doc.text(`[Math Error: ${mathStr.slice(0, 20)}...]`);
//     return false;
//   }
// }

// // // === PDF Generation  (full replacement, no pdfkit-table) ===
// // async function generatePDF(content, outputPath) {
// //   return new Promise(async (resolve, reject) => {
// //     try {
// //       const PDFDocument = (await import('pdfkit')).default;
// //       const doc = new PDFDocument({
// //         autoFirstPage: false,
// //         bufferPages: true,
// //         margin: 50,
// //         size: 'A4'
// //       });
// //       const stream = fs.createWriteStream(outputPath);
// //       doc.pipe(stream);

// //       doc.addPage();              // guarantee page → width readable
// //       const USABLE_W = doc.page.width - 2 * 50;

// //       const pages = [];
// //       doc.on('pageAdded', () => pages.push(doc.page));

// //       /* ----------  TABLE DRAWER (plain PDFKit)  ---------- */
// //       function drawTable(headers, rows) {
// //         const colCount = headers.length;
// //         if (!colCount) return;

// //         // measure each column
// //         const widths = Array(colCount).fill(0);
// //         doc.font('Helvetica-Bold');
// //         headers.forEach((h, i) => widths[i] = Math.max(widths[i], doc.widthOfString(h)));
// //         doc.font('Helvetica');
// //         rows.flat().forEach((c, i) => widths[i % colCount] = Math.max(widths[i % colCount], doc.widthOfString(c)));

// //         const totalW = widths.reduce((a, b) => a + b, 0);
// //         const scale  = Math.min(1, USABLE_W / totalW);
// //         const cellW  = widths.map(w => w * scale);

// //         const startY = doc.y + 5;
// //         let y = startY;

// //         // header row
// //         doc.font('Helvetica-Bold').fontSize(10);
// //         let x = 60;
// //         headers.forEach((h, i) => {
// //           doc.text(h, x, y, { width: cellW[i] - 4, align: 'left' });
// //           x += cellW[i];
// //         });
// //         y += doc.heightOfString(headers[0], { width: cellW[0] }) + 6;

// //         // data rows
// //         doc.font('Helvetica').fontSize(10);
// //         rows.forEach(row => {
// //           x = 60;
// //           row.forEach((cell, i) => {
// //             doc.text(cell, x, y, { width: cellW[i] - 4, align: 'left' });
// //             x += cellW[i];
// //           });
// //           y += Math.max(...row.map((c, i) => doc.heightOfString(c, { width: cellW[i] }))) + 5;
// //         });

// //         // grid lines
// //         doc.save().lineWidth(0.5).strokeColor('#cccccc');
// //         let lineX = 60;
// //         for (let i = 0; i <= colCount; i++) {
// //           doc.moveTo(lineX, startY - 2).lineTo(lineX, y + 2).stroke();
// //           lineX += cellW[i] || 0;
// //         }
// //         doc.moveTo(60, startY - 2).lineTo(60 + cellW.reduce((a, b) => a + b, 0), startY - 2).stroke(); // top
// //         doc.moveTo(60, y + 2).lineTo(60 + cellW.reduce((a, b) => a + b, 0), y + 2).stroke();           // bottom
// //         doc.restore();

// //         doc.y = y + 10;   // cursor below table
// //       }

// //       /* ----------  other helpers  ---------- */
// //       function parseInline(text) {              // bold / italic / inline-code
// //         const reg = /(\*\*|__)(.*?)\1|(\*|_)(.*?)\3|(`)([^`]+)\5/g;
// //         let last = 0, m;
// //         doc.save();
// //         while ((m = reg.exec(text)) !== null) {
// //           const before = text.slice(last, m.index);
// //           if (before) doc.text(before, { continued: true });
// //           if (m[2]) { // bold
// //             doc.font('Helvetica-Bold').text(m[2], { continued: true });
// //             doc.font('Helvetica');
// //           } else if (m[4]) { // italic
// //             doc.font('Helvetica-Oblique').text(m[4], { continued: true });
// //             doc.font('Helvetica');
// //           } else if (m[6]) { // inline code
// //             doc.fontSize(9).font('Courier').text(m[6], { continued: true })
// //                .fontSize(12).font('Helvetica');
// //           }
// //           last = m.index + m[0].length;
// //         }
// //         const rest = text.slice(last);
// //         if (rest) doc.text(rest, { continued: false });
// //         doc.restore();
// //       }

// //       function codeBlock(code, lang) {
// //         lang = hljs.getLanguage(lang) ? lang : 'plaintext';
// //         const html = hljs.highlight(code, { language: lang }).value;
// //         doc.save().font('Courier').fontSize(9).fillColor('#2d3748');
// //         html.split(/\n/).forEach(ln => {
// //           const txt = ln.replace(/<[^>]+>/g, '');
// //           doc.text(txt, 60, doc.y, { width: USABLE_W - 20 });
// //         });
// //         doc.fillColor('black').restore();
// //       }

// //       function mathLine(tex, display) {
// //         try {
// //           const html = katex.renderToString(tex, { throwOnError: false, displayMode: display });
// //           doc.save().font('Courier').fontSize(9).fillColor('#2b6cb0')
// //              .text(display ? ` ${tex} ` : tex, 55, doc.y,
// //                    { width: USABLE_W - 10, align: display ? 'center' : 'left' })
// //              .fillColor('black').restore();
// //         } catch { doc.text(`[Math: ${tex}]`); }
// //       }

// //       /* ----------  tokeniser  ---------- */
// //       const lines = content.split('\n');
// //       let inCode = false, codeLang = '', codeBuf = [];
// //       let inTable = false, tbl = [];

// //       doc.font('Helvetica');

// //       for (let raw of lines) {
// //         const ln = raw.trimEnd();

// //         // code fence
// //         if (ln.startsWith('```')) {
// //           if (inCode) {
// //             codeBlock(codeBuf.join('\n'), codeLang);
// //             codeBuf = []; inCode = false; doc.moveDown();
// //           } else {
// //             inCode = true; codeLang = ln.slice(3);
// //           }
// //           continue;
// //         }
// //         if (inCode) { codeBuf.push(raw); continue; }

// //         // table
// //         if (ln.includes('|')) { tbl.push(ln); inTable = true; continue; }
// //         if (inTable && !ln.includes('|')) {
// //           const hdr = tbl[0], rows = tbl.slice(2);
// //           const headers = hdr.split('|').slice(1, -1).map(c => c.trim());
// //           const data  = rows.map(r => r.split('|').slice(1, -1).map(c => c.trim()));
// //           drawTable(headers, data);
// //           tbl = []; inTable = false; doc.moveDown();
// //         }

// //         // headings
// //         if (ln.startsWith('# ')) {
// //           doc.addPage().fontSize(24).font('Helvetica-Bold')
// //              .text(ln.replace('# ', ''), 50, 70, { align: 'center' })
// //              .moveDown(1.5);
// //           continue;
// //         }
// //         if (ln.startsWith('## ')) {
// //           doc.fontSize(18).font('Helvetica-Bold')
// //              .text(ln.replace('## ', ''), { underline: true })
// //              .moveDown(0.8);
// //           continue;
// //         }
// //         if (ln.startsWith('### ')) {
// //           doc.fontSize(14).font('Helvetica-BoldOblique')
// //              .text(ln.replace('### ', ''))
// //              .moveDown(0.6);
// //           continue;
// //         }
// //         if (!ln) { doc.moveDown(0.7); continue; }

// //         // math block
// //         if (ln.startsWith('$$') && ln.endsWith('$$')) {
// //           mathLine(ln.slice(2, -2), true); continue;
// //         }

// //         // normal paragraph
// //         parseInline(ln);
// //         doc.moveDown(0.4);
// //       }
// //       if (inTable) { // doc ended in table
// //         const headers = tbl[0].split('|').slice(1, -1).map(c => c.trim());
// //         const data  = tbl.slice(2).map(r => r.split('|').slice(1, -1).map(c => c.trim()));
// //         drawTable(headers, data);
// //       }

// //       // header / footer
// //       const total = pages.length;
// //       pages.forEach((p, i) => {
// //         doc.switchToPage(i);
// //         doc.fontSize(9).fillColor('#888')
// //            .text('Generated by BookGen.AI', 50, 30, { lineBreak: false })
// //            .text(`Page ${i + 1} of ${total}`, 50, doc.page.height - 40,
// //                  { align: 'center', width: USABLE_W })
// //            .fillColor('black');
// //       });

// //       doc.end();
// //       stream.on('finish', () => resolve(outputPath));
// //     } catch (e) { reject(e); }
// //   });
// // }

// // async function generatePDF(content, outputPath) {
// //   return new Promise((resolve, reject) => {
// //     try {
// //       const doc = new PDFDocument({
// //         size: 'A4',
// //         margin: 60,
// //         bufferPages: true,
// //         autoFirstPage: false
// //       });
// //       const stream = fs.createWriteStream(outputPath);
// //       doc.pipe(stream);
// //       doc.addPage();

// //       const USABLE_W = doc.page.width - 120;
// //       const pages = [];

// //       doc.on('pageAdded', () => pages.push(doc.page));

// //       // === Styles ===
// //       const FONT_MAIN = 'Helvetica';
// //       const FONT_BOLD = 'Helvetica-Bold';
// //       const FONT_ITALIC = 'Helvetica-Oblique';
// //       const FONT_MONO = 'Courier';
// //       const BASE_FONT_SIZE = 13;
// //       const LINE_SPACING = 1.6;
// //       const COLOR_TEXT = '#1a1a1a';
// //       const COLOR_LINK = '#007acc';
// //       const COLOR_HEADING = '#2c3e50';

// //       // === Markdown helpers ===
// //       function renderInline(text) {
// //         const regex = /(\*\*|__)(.*?)\1|(\*|_)(.*?)\3|(`)([^`]+)\5/g;
// //         let last = 0;
// //         let match;
// //         doc.save();
// //         while ((match = regex.exec(text)) !== null) {
// //           const before = text.slice(last, match.index);
// //           if (before) doc.text(before, { continued: true });
// //           if (match[2]) {
// //             doc.font(FONT_BOLD).text(match[2], { continued: true });
// //             doc.font(FONT_MAIN);
// //           } else if (match[4]) {
// //             doc.font(FONT_ITALIC).text(match[4], { continued: true });
// //             doc.font(FONT_MAIN);
// //           } else if (match[6]) {
// //             doc.font(FONT_MONO).fontSize(BASE_FONT_SIZE - 2)
// //                .text(match[6], { continued: true })
// //                .font(FONT_MAIN).fontSize(BASE_FONT_SIZE);
// //           }
// //           last = match.index + match[0].length;
// //         }
// //         const rest = text.slice(last);
// //         if (rest) doc.text(rest, { continued: false });
// //         doc.restore();
// //       }

// //       function addHeading(text, level) {
// //         const sizes = { 1: 24, 2: 20, 3: 16 };
// //         const font = level === 3 ? FONT_BOLD + 'Oblique' : FONT_BOLD;
// //         text = text.replace(/[*_#]+/g, '').trim();
// //         doc.moveDown(level === 1 ? 1.5 : 1)
// //           .font(font)
// //           .fontSize(sizes[level])
// //           .fillColor(COLOR_HEADING)
// //           .text(text, { align: level === 1 ? 'center' : 'left', underline: level === 2 })
// //           .fillColor(COLOR_TEXT)
// //           .moveDown(0.5);
// //       }

// //       function addParagraph(line) {
// //         if (!line.trim()) { doc.moveDown(0.7); return; }
// //         doc.font(FONT_MAIN)
// //           .fontSize(BASE_FONT_SIZE)
// //           .fillColor(COLOR_TEXT);
// //         renderInline(line);
// //         doc.moveDown(0.4);
// //       }

// //       function addList(items, ordered = false) {
// //         doc.font(FONT_MAIN).fontSize(BASE_FONT_SIZE).fillColor(COLOR_TEXT);
// //         items.forEach((item, i) => {
// //           const prefix = ordered ? `${i + 1}. ` : '• ';
// //           doc.text(prefix, { continued: true });
// //           renderInline(item.trim());
// //           doc.moveDown(0.3);
// //         });
// //         doc.moveDown(0.5);
// //       }

// //       function addCodeBlock(code, lang = 'plaintext') {
// //         lang = hljs.getLanguage(lang) ? lang : 'plaintext';
// //         const highlighted = hljs.highlight(code, { language: lang }).value
// //           .replace(/<[^>]+>/g, '');
// //         doc.save()
// //           .font(FONT_MONO)
// //           .fontSize(BASE_FONT_SIZE - 2)
// //           .fillColor('#2d3748')
// //           .rect(60, doc.y, USABLE_W, doc.heightOfString(code, { width: USABLE_W }) + 10)
// //           .fill('#f8f9fa')
// //           .fillColor('#2d3748')
// //           .text(highlighted, 65, doc.y + 5, { width: USABLE_W - 10 })
// //           .fillColor(COLOR_TEXT)
// //           .restore()
// //           .moveDown(1);
// //       }

// //       function addMath(tex, display = false) {
// //         try {
// //           const rendered = katex.renderToString(tex, { throwOnError: false, displayMode: display });
// //           const stripped = rendered.replace(/<[^>]+>/g, '');
// //           doc.save().font(FONT_MONO).fontSize(BASE_FONT_SIZE - 2).fillColor('#2b6cb0')
// //             .text(stripped, { width: USABLE_W, align: display ? 'center' : 'left' })
// //             .restore().moveDown(0.4);
// //         } catch {
// //           doc.text(`[Math: ${tex}]`).moveDown(0.4);
// //         }
// //       }

// //       // === Parse ===
// //       const lines = content.split('\n');
// //       let inCode = false, codeLang = '', codeBuf = [];
// //       let listBuf = [], orderedList = false;

// //       for (const raw of lines) {
// //         const line = raw.trimEnd();

// //         if (line.startsWith('```')) {
// //           if (inCode) {
// //             addCodeBlock(codeBuf.join('\n'), codeLang);
// //             inCode = false; codeBuf = [];
// //           } else {
// //             inCode = true; codeLang = line.slice(3).trim();
// //           }
// //           continue;
// //         }
// //         if (inCode) { codeBuf.push(raw); continue; }

// //         // Lists
// //         if (/^[-*]\s+/.test(line)) {
// //           listBuf.push(line.replace(/^[-*]\s+/, ''));
// //           orderedList = false;
// //           continue;
// //         }
// //         if (/^\d+\.\s+/.test(line)) {
// //           listBuf.push(line.replace(/^\d+\.\s+/, ''));
// //           orderedList = true;
// //           continue;
// //         }
// //         if (listBuf.length && !line.match(/^[-*\d]/)) {
// //           addList(listBuf, orderedList);
// //           listBuf = [];
// //         }

// //         // Headings
// //         if (line.startsWith('# ')) { addHeading(line, 1); continue; }
// //         if (line.startsWith('## ')) { addHeading(line, 2); continue; }
// //         if (line.startsWith('### ')) { addHeading(line, 3); continue; }

// //         // Math
// //         if (line.startsWith('$$') && line.endsWith('$$')) {
// //           addMath(line.slice(2, -2), true); continue;
// //         }

// //         // Normal paragraph
// //         addParagraph(line);
// //       }
// //       if (listBuf.length) addList(listBuf, orderedList);

// //       // === Footer ===
// //       const total = doc.bufferedPageRange().count;
// //       for (let i = 0; i < total; i++) {
// //         doc.switchToPage(i);
// //         const { width, height } = doc.page;
// //         doc.fontSize(9).fillColor('#999');
// //         doc.text('bookgenai.vercel.app', 60, 30, { width: width - 120, align: 'center' });
// //         doc.text(`Page ${i + 1} of ${total}`, 60, height - 50, { width: width - 120, align: 'center' });
// //         doc.fillColor(COLOR_TEXT);
// //       }

// //       doc.end();
// //       stream.on('finish', () => resolve(outputPath));
// //     } catch (err) {
// //       reject(err);
// //     }
// //   });
// // }

// async function generatePDF(content, outputPath) {
//   return new Promise((resolve, reject) => {
//     try {
//       if (!outputPath) throw new Error("outputPath is undefined");

//       const doc = new PDFDocument({
//         size: 'A4',
//         margin: 60,
//         bufferPages: true,
//         autoFirstPage: false
//       });

//       const stream = fs.createWriteStream(outputPath);
//       doc.pipe(stream);
      
//       // === COVER PAGE ===
//       doc.addPage();
//       // Add some top margin (simulating CSS margin-top: 200px)
//       doc.moveDown(15);
      
//       doc.font('Helvetica').fontSize(36).fillColor('#2c3e50')
//          .text('Generated by Bookgen.ai', { align: 'center' })
//          .moveDown(10); // More space
      
//       doc.fontSize(12).fillColor('#ff0000')
//          .text('Caution: AI can make mistake', { align: 'center' });
      
//       // === CONTENT PAGE ===
//       doc.addPage();

//       const PAGE_WIDTH = doc.page.width;
//       const PAGE_HEIGHT = doc.page.height;
//       const MARGIN = 60;
//       const USABLE_W = PAGE_WIDTH - (MARGIN * 2);
      
//       // Styling constants matching your HTML/CSS
//       const FONT_MAIN = 'Helvetica';
//       const FONT_BOLD = 'Helvetica-Bold';
//       const FONT_ITALIC = 'Helvetica-Oblique';
//       const FONT_MONO = 'Courier';
      
//       const BASE_FONT_SIZE = 13.5;
//       const LINE_HEIGHT = 1.7 * BASE_FONT_SIZE;
      
//       const COLOR_TEXT = '#1a1a1a';
//       const COLOR_HEADING = '#2c3e50';
//       const COLOR_LINK = '#007acc';
//       const COLOR_CODE_BG = '#f4f4f4';
//       const COLOR_PRE_BG = '#f8f9fa';
//       const COLOR_BLOCKQUOTE_BORDER = '#007acc';
//       const COLOR_BLOCKQUOTE_BG = '#f8f9fa';
//       const COLOR_EXAMPLE_BG = '#f0f8ff';

//       let inTOC = false;
//       let tocStarted = false;

//       // Inline text renderer with formatting
//       function renderInline(text, options = {}) {
//         if (!text) return;
        
//         const defaultColor = options.color || COLOR_TEXT;
//         const continued = options.continued || false;
        
//         // Regex for: bold, italic, inline code, links
//         const regex = /(\*\*|__)(.*?)\1|(\*|_)(.*?)\3|(`)([^`]+)\5|(\[([^\]]+)\]\(([^)]+)\))/g;
//         let lastIndex = 0;
//         let match;
        
//         doc.save();
        
//         while ((match = regex.exec(text)) !== null) {
//           const before = text.slice(lastIndex, match.index);
//           if (before) {
//             doc.font(FONT_MAIN).fontSize(BASE_FONT_SIZE).fillColor(defaultColor)
//                .text(before, { continued: true, lineGap: LINE_HEIGHT - BASE_FONT_SIZE });
//           }
          
//           if (match[2]) { // Bold
//             doc.font(FONT_BOLD).text(match[2], { continued: true, lineGap: LINE_HEIGHT - BASE_FONT_SIZE });
//           } else if (match[4]) { // Italic
//             doc.font(FONT_ITALIC).text(match[4], { continued: true, lineGap: LINE_HEIGHT - BASE_FONT_SIZE });
//           } else if (match[6]) { // Inline code
//             const code = match[6];
//             const codeWidth = doc.widthOfString(code, { font: FONT_MONO, fontSize: BASE_FONT_SIZE - 1 });
//             const x = doc.x;
//             const y = doc.y;
            
//             // Draw background
//             doc.rect(x, y, codeWidth + 8, BASE_FONT_SIZE + 6)
//                .fill(COLOR_CODE_BG);
            
//             // Draw code text
//             doc.font(FONT_MONO).fontSize(BASE_FONT_SIZE - 1).fillColor(COLOR_TEXT)
//                .text(code, x + 4, y + 3, { continued: true });
            
//             // Restore main font
//             doc.font(FONT_MAIN).fontSize(BASE_FONT_SIZE);
//           } else if (match[7]) { // Link
//             const linkText = match[8];
//             const url = match[9];
            
//             doc.fillColor(COLOR_LINK)
//                .text(linkText, { 
//                  continued: true, 
//                  underline: true,
//                  link: url,
//                  lineGap: LINE_HEIGHT - BASE_FONT_SIZE 
//                });
            
//             // Reset color
//             doc.fillColor(defaultColor);
//           }
          
//           lastIndex = match.index + match[0].length;
//         }
        
//         const after = text.slice(lastIndex);
//         if (after) {
//           doc.font(FONT_MAIN).fontSize(BASE_FONT_SIZE).fillColor(defaultColor)
//              .text(after, { 
//                continued: continued, 
//                lineGap: LINE_HEIGHT - BASE_FONT_SIZE 
//              });
//         }
        
//         doc.restore();
//       }

//       // Headings
//       function addHeading(line, level) {
//         // Detect TOC start
//         if (level === 1 && line.toLowerCase().includes('table of contents')) {
//           inTOC = true;
//           tocStarted = true;
//         } else if (tocStarted && level === 1) {
//           inTOC = false;
//         }
        
//         const sizes = { 1: 24, 2: 20, 3: 16 };
//         const spacing = { 1: 1.2, 2: 0.8, 3: 0.6 };
        
//         const text = line.replace(/^#+\s*/, '');
        
//         // TOC styling - simpler link-like appearance
//         if (inTOC) {
//           doc.font(FONT_MAIN).fontSize(BASE_FONT_SIZE).fillColor(COLOR_LINK)
//              .text(text, { lineGap: LINE_HEIGHT - BASE_FONT_SIZE });
//           doc.moveDown(0.2);
//           return;
//         }
        
//         doc.moveDown(spacing[level])
//            .font(level <= 2 ? FONT_BOLD : FONT_ITALIC)
//            .fontSize(sizes[level])
//            .fillColor(COLOR_HEADING);
        
//         if (level === 1) {
//           doc.text(text, { align: 'center', lineGap: LINE_HEIGHT - sizes[level] });
//         } else {
//           doc.text(text, { lineGap: LINE_HEIGHT - sizes[level] });
//         }
        
//         // Underline for h2
//         if (level === 2) {
//           const y = doc.y;
//           doc.strokeColor('#e0e0e0').lineWidth(1)
//              .moveTo(MARGIN, y + 2).lineTo(PAGE_WIDTH - MARGIN, y + 2).stroke();
//         }
        
//         doc.fillColor(COLOR_TEXT)
//            .moveDown(0.5);
//       }

//       // Paragraphs
//       function addParagraph(line) {
//         if (!line.trim()) { 
//           doc.moveDown(0.7); 
//           return; 
//         }
        
//         renderInline(line);
//         doc.moveDown(0.8);
//       }

//       // Lists
//       function addList(items, ordered = false) {
//         items.forEach((item, i) => {
//           const prefix = ordered ? `${i + 1}. ` : '• ';
//           doc.text(prefix, MARGIN + 20, doc.y, { continued: true });
//           renderInline(item.trim());
//           doc.moveDown(0.5);
//         });
//         doc.moveDown(0.5);
//       }

//       // Code blocks with improved styling
//       function addCodeBlock(code, lang = 'plaintext') {
//         lang = hljs.getLanguage(lang) ? lang : 'plaintext';
//         const highlighted = hljs.highlight(code, { language: lang }).value.replace(/<[^>]+>/g, '');
        
//         const lineHeight = (BASE_FONT_SIZE - 1) * 1.5;
//         const numLines = highlighted.split('\n').length;
//         const boxHeight = (numLines * lineHeight) + 20;
        
//         const yStart = doc.y;
        
//         // Draw background with border (simulating CSS border: 1px solid #e0e0e0)
//         doc.rect(MARGIN, yStart - 5, USABLE_W, boxHeight)
//            .fill(COLOR_PRE_BG)
//            .strokeColor('#e0e0e0').lineWidth(1)
//            .rect(MARGIN, yStart - 5, USABLE_W, boxHeight).stroke();
        
//         // Draw code text
//         doc.font(FONT_MONO).fontSize(BASE_FONT_SIZE - 1).fillColor(COLOR_TEXT)
//            .text(highlighted, MARGIN + 10, yStart + 8, { 
//              width: USABLE_W - 20,
//              lineGap: lineHeight - (BASE_FONT_SIZE - 1)
//            });
        
//         doc.moveDown(1.2);
//       }

//       // Blockquotes
//       function addBlockquote(text) {
//         const yStart = doc.y;
//         const textHeight = doc.heightOfString(text, { width: USABLE_W - 30 });
        
//         // Draw left border
//         doc.strokeColor(COLOR_BLOCKQUOTE_BORDER).lineWidth(4)
//            .moveTo(MARGIN + 10, yStart).lineTo(MARGIN + 10, yStart + textHeight + 15).stroke();
        
//         // Draw background
//         doc.rect(MARGIN + 18, yStart - 5, USABLE_W - 28, textHeight + 15)
//            .fill(COLOR_BLOCKQUOTE_BG);
        
//         // Draw text
//         doc.font(FONT_ITALIC).fontSize(BASE_FONT_SIZE).fillColor(COLOR_TEXT)
//            .text(text, MARGIN + 25, yStart, { width: USABLE_W - 35 });
        
//         doc.moveDown(1);
//       }

//       // Example boxes (detect as blockquote with >! marker)
//       function addExample(text) {
//         const yStart = doc.y;
//         const textHeight = doc.heightOfString(text, { width: USABLE_W - 30 });
        
//         // Draw left border
//         doc.strokeColor('#007acc').lineWidth(3)
//            .moveTo(MARGIN + 10, yStart).lineTo(MARGIN + 10, yStart + textHeight + 15).stroke();
        
//         // Draw background
//         doc.rect(MARGIN + 18, yStart - 5, USABLE_W - 28, textHeight + 15)
//            .fill(COLOR_EXAMPLE_BG);
        
//         // Draw text (italic for examples)
//         doc.font(FONT_ITALIC).fontSize(BASE_FONT_SIZE).fillColor(COLOR_TEXT)
//            .text(text, MARGIN + 25, yStart, { width: USABLE_W - 35 });
        
//         doc.moveDown(1);
//       }

//       // Math blocks
//       function addMath(tex, display = false) {
//         try {
//           const rendered = katex.renderToString(tex, { 
//             throwOnError: false, 
//             displayMode: display 
//           });
          
//           // Strip HTML tags (simple approach)
//           const stripped = rendered.replace(/<[^>]+>/g, ' ')
//                                  .replace(/\s+/g, ' ')
//                                  .trim();
          
//           doc.save()
//             .font(FONT_MONO)
//             .fontSize(BASE_FONT_SIZE - 1)
//             .fillColor('#2b6cb0');
          
//           if (display) {
//             doc.text(stripped, { width: USABLE_W, align: 'center', lineGap: LINE_HEIGHT - BASE_FONT_SIZE });
//           } else {
//             doc.text(stripped, { lineGap: LINE_HEIGHT - BASE_FONT_SIZE });
//           }
          
//           doc.restore()
//              .moveDown(0.8);
//         } catch (error) {
//           logger.error(`Math rendering failed: ${error.message}`);
//           doc.text(`[Math: ${tex.slice(0, 30)}...]`, { lineGap: LINE_HEIGHT - BASE_FONT_SIZE })
//              .moveDown(0.8);
//         }
//       }

//       // Parse content lines
//       const lines = content.split('\n');
//       let inCode = false, codeLang = '', codeBuf = [];
//       let listBuf = [], ordered = false;
//       let blockquoteText = null;
//       let exampleText = null;

//       for (const rawLine of lines) {
//         const line = rawLine.trimEnd();
//         const trimmed = line.trim();

//         // Code blocks
//         if (line.startsWith('```')) {
//           if (inCode) {
//             addCodeBlock(codeBuf.join('\n'), codeLang);
//             inCode = false; codeBuf = []; codeLang = '';
//           } else {
//             inCode = true;
//             codeLang = line.slice(3).trim();
//           }
//           continue;
//         }
//         if (inCode) {
//           codeBuf.push(rawLine);
//           continue;
//         }

//         // Examples (detect >! marker)
//         if (trimmed.startsWith('>!')) {
//           if (exampleText === null) exampleText = trimmed.replace(/^>!\s*/, '') + '\n';
//           else exampleText += trimmed.replace(/^>!\s*/, '') + '\n';
//           continue;
//         } else if (exampleText !== null) {
//           addExample(exampleText.trim());
//           exampleText = null;
//         }

//         // Blockquotes (detect > marker)
//         if (trimmed.startsWith('>') && !trimmed.startsWith('>!')) {
//           if (blockquoteText === null) blockquoteText = trimmed.replace(/^>\s*/, '') + '\n';
//           else blockquoteText += trimmed.replace(/^>\s*/, '') + '\n';
//           continue;
//         } else if (blockquoteText !== null) {
//           addBlockquote(blockquoteText.trim());
//           blockquoteText = null;
//         }

//         // Lists
//         if (/^[-*]\s+/.test(line)) {
//           if (listBuf.length === 0) ordered = false;
//           listBuf.push(line.replace(/^[-*]\s+/, ''));
//           continue;
//         }
//         if (/^\d+\.\s+/.test(line)) {
//           if (listBuf.length === 0) ordered = true;
//           listBuf.push(line.replace(/^\d+\.\s+/, ''));
//           continue;
//         }
//         if (listBuf.length && !/^[-*\d]/.test(line)) {
//           addList(listBuf, ordered);
//           listBuf = []; ordered = false;
//         }

//         // Headings
//         if (line.startsWith('# ')) { addHeading(line, 1); continue; }
//         if (line.startsWith('## ')) { addHeading(line, 2); continue; }
//         if (line.startsWith('### ')) { addHeading(line, 3); continue; }

//         // Math blocks
//         if (trimmed.startsWith('$$') && trimmed.endsWith('$$')) {
//           addMath(trimmed.slice(2, -2), true);
//           continue;
//         }

//         // Horizontal rule
//         if (/^[-=_~]{3,}$/.test(trimmed)) {
//           doc.moveDown(1)
//              .strokeColor('#e0e0e0').lineWidth(1)
//              .moveTo(MARGIN, doc.y).lineTo(PAGE_WIDTH - MARGIN, doc.y).stroke()
//              .moveDown(1);
//           continue;
//         }

//         // Empty lines
//         if (!trimmed) {
//           doc.moveDown(0.5);
//           continue;
//         }

//         // Regular paragraph
//         addParagraph(line);
//       }

//       // Flush remaining buffers
//       if (listBuf.length) addList(listBuf, ordered);
//       if (blockquoteText !== null) addBlockquote(blockquoteText.trim());
//       if (exampleText !== null) addExample(exampleText.trim());

//       // Add page numbers and header/footer
//       const totalPages = doc.bufferedPageRange().count;
//       for (let i = 0; i < totalPages; i++) {
//         doc.switchToPage(i);
        
//         // Header
//         doc.fontSize(10).fillColor('#999')
//            .text('bookgenai.vercel.app', MARGIN, 30, { 
//              width: USABLE_W, 
//              align: 'center' 
//            });
        
//         // Footer
//         doc.text(`Page ${i + 1} of ${totalPages}`, MARGIN, PAGE_HEIGHT - 50, { 
//           width: USABLE_W, 
//           align: 'center' 
//         });
//       }

//       doc.end();
//       stream.on('finish', () => resolve(outputPath));
//       stream.on('error', reject);
      
//     } catch (err) {
//       reject(err);
//     }
//   });
// }

// function generatePrompts(bookTopic) {
//   return [
//    // Table of Contents
//     `As Hailu, you are going to follow this instruction that i will gave you. You must work with them for best out put. First write the title for the book then create a table of contents for a book about "${bookTopic}" for someone with no prior knowledge. The book must have 15 chapters, each covering a unique aspect of ${bookTopic} (e.g., for trading bots: what they are, how they work, strategies, risks, tools). Each chapter must be at least 400 words and written in a fun, simple, friendly tone, like explaining to a curious 16-year-old. Use clear, descriptive chapter titles and include more than 2–3 subtopics per chapter (e.g., "What is a trading bot?" or "How do trading bots make decisions?"). Output only the table of contents as a numbered list with chapter titles and subtopics. Ensure topics are distinct, avoid overlap, and focus strictly on ${bookTopic}. If ${bookTopic} is unclear, suggest relevant subtopics and explain why. Ignore any unrelated topics like space or previous requests. Remeber After you finish what you have been told you are goinig to stop after you finish creating the table of content you are done don't respond any more.`,

//     // Chapter 1
//     `As Hailu,you are going to follow this instruction that i will gave you. You write Chapter 1 of the book about "${bookTopic}", based on the table of contents you created. Focus only on the first chapter's topic and subtopics. Use a fun, simple, friendly tone, like explaining to a curious 16-year-old. Break down complex ideas into clear steps with vivid examples (e.g., for trading bots, compare them to a robot chef following a recipe) and if it seem important use one analogy per subtopic. Include a description of a diagram or table (e.g., "a diagram showing how a trading bot works") to aid understanding. Use clear headings for each subtopic. Write at least 400 words, avoid copyrighted material, ensure accuracy, and focus only on ${bookTopic} chapter one from the table of content. If information is limited, explain in simple terms and note limitations. Do not include the table of contents, other chapters, or unrelated topics like space please only write chapter one after you are done writting chapter one stop responding.`,

//     // Chapter 2
//     `As Hailu,you are going to follow this instruction that i will gave you. Now you write Chapter 2 of the book about "${bookTopic}", based on the table of contents you created. Focus only on the second chapter's topic and subtopics. Use a fun, simple, friendly tone, like explaining to a curious 16-year-old. Break down complex ideas into clear steps with vivid examples (e.g., for trading bots, compare them to a robot chef following a recipe) and if it seem important use one analogy per subtopic. Include a description of a diagram or table (e.g., "a diagram showing how a trading bot works") to aid understanding. Use clear headings for each subtopic. Write at least 400 words, avoid copyrighted material, ensure accuracy, and focus only on ${bookTopic} chapter two from the table of content. If information is limited, explain in simple terms and note limitations. Do not include the table of contents, other chapters, or unrelated topics like space please only write chapter two after you are done writting chapter two stop responding.`,

//     // Chapter 3
//     `As Hailu,you are going to follow this instruction that i will gave you. You write Chapter 3 of the book about "${bookTopic}", based on the table of contents you created. Focus only on the third chapter's topic and subtopics. Use a fun, simple, friendly tone, like explaining to a curious 16-year-old. Break down complex ideas into clear steps with vivid examples (e.g., for trading bots, compare them to a robot chef following a recipe) and if it seem important use one analogy per subtopic. Include a description of a diagram or table (e.g., "a diagram showing how a trading bot works") to aid understanding. Use clear headings for each subtopic. Write at least 400 words, avoid copyrighted material, ensure accuracy, and focus only on ${bookTopic} chapter three from the table of content. If information is limited, explain in simple terms and note limitations. Do not include the table of contents, other chapters, or unrelated topics like space please only write chapter three after you are done writting chapter three stop responding.`,
    
//     // Chapter 4
//     `As Hailu,you are going to follow this instruction that i will gave you. You write Chapter 4 of the book about "${bookTopic}", based on the table of contents you created. Focus only on the fourth chapter's topic and subtopics. Use a fun, simple, friendly tone, like explaining to a curious 16-year-old. Break down complex ideas into clear steps with vivid examples (e.g., for trading bots, compare them to a robot chef following a recipe) and if it seem important use one analogy per subtopic. Include a description of a diagram or table (e.g., "a diagram showing how a trading bot works") to aid understanding. Use clear headings for each subtopic. Write at least 400 words, avoid copyrighted material, ensure accuracy, and focus only on ${bookTopic} chapter four from the table of content. If information is limited, explain in simple terms and note limitations. Do not include the table of contents, other chapters, or unrelated topics like space please only write chapter four after you are done writting chapter four stop responding.`,
    
//     // Chapter 5
//     `As Hailu,you are going to follow this instruction that i will gave you. You write Chapter 5 of the book about "${bookTopic}", based on the table of contents you created. Focus only on the fifith chapter's topic and subtopics. Use a fun, simple, friendly tone, like explaining to a curious 16-year-old. Break down complex ideas into clear steps with vivid examples (e.g., for trading bots, compare them to a robot chef following a recipe) and if it seem important use one analogy per subtopic. Include a description of a diagram or table (e.g., "a diagram showing how a trading bot works") to aid understanding. Use clear headings for each subtopic. Write at least 400 words, avoid copyrighted material, ensure accuracy, and focus only on ${bookTopic} chapter five from the table of content. If information is limited, explain in simple terms and note limitations. Do not include the table of contents, other chapters, or unrelated topics like space please only write chapter five after you are done writting chapter five stop responding.`,
    
//     //Chapter 6
//     `As Hailu,you are going to follow this instruction that i will gave you. You write Chapter 6 of the book about "${bookTopic}", based on the table of contents you created. Focus only on the sixth chapter's topic and subtopics. Use a fun, simple, friendly tone, like explaining to a curious 16-year-old. Break down complex ideas into clear steps with vivid examples (e.g., for trading bots, compare them to a robot chef following a recipe) and if it seem important use one analogy per subtopic. Include a description of a diagram or table (e.g., "a diagram showing how a trading bot works") to aid understanding. Use clear headings for each subtopic. Write at least 400 words, avoid copyrighted material, ensure accuracy, and focus only on ${bookTopic} chapter six from the table of content. If information is limited, explain in simple terms and note limitations. Do not include the table of contents, other chapters, or unrelated topics like space please only write chapter six after you are done writting chapter six stop responding.`,    

//     //Chapter 7
//     `As Hailu,you are going to follow this instruction that i will gave you. You write Chapter 7 of the book about "${bookTopic}", based on the table of contents you created. Focus only on the seventh chapter's topic and subtopics. Use a fun, simple, friendly tone, like explaining to a curious 16-year-old. Break down complex ideas into clear steps with vivid examples (e.g., for trading bots, compare them to a robot chef following a recipe) and if it seem important use one analogy per subtopic. Include a description of a diagram or table (e.g., "a diagram showing how a trading bot works") to aid understanding. Use clear headings for each subtopic. Write at least 400 words, avoid copyrighted material, ensure accuracy, and focus only on ${bookTopic} chapter seven from the table of content. If information is limited, explain in simple terms and note limitations. Do not include the table of contents, other chapters, or unrelated topics like space please only write chapter seven after you are done writting chapter seven stop responding.`,
    
//     //Chapter 8
//     `As Hailu,you are going to follow this instruction that i will gave you. You write Chapter 8 of the book about "${bookTopic}", based on the table of contents you created. Focus only on the eightth chapter's topic and subtopics. Use a fun, simple, friendly tone, like explaining to a curious 16-year-old. Break down complex ideas into clear steps with vivid examples (e.g., for trading bots, compare them to a robot chef following a recipe) and if it seem important use one analogy per subtopic. Include a description of a diagram or table (e.g., "a diagram showing how a trading bot works") to aid understanding. Use clear headings for each subtopic. Write at least 400 words, avoid copyrighted material, ensure accuracy, and focus only on ${bookTopic} chapter eight from the table of content. If information is limited, explain in simple terms and note limitations. Do not include the table of contents, other chapters, or unrelated topics like space please only write chapter eight after you are done writting chapter eight stop responding.`,

//     //Chapter 9
//     `As Hailu,you are going to follow this instruction that i will gave you. You write Chapter 9 of the book about "${bookTopic}", based on the table of contents you created. Focus only on the nineth chapter's topic and subtopics. Use a fun, simple, friendly tone, like explaining to a curious 16-year-old. Break down complex ideas into clear steps with vivid examples (e.g., for trading bots, compare them to a robot chef following a recipe) and if it seem important use one analogy per subtopic. Include a description of a diagram or table (e.g., "a diagram showing how a trading bot works") to aid understanding. Use clear headings for each subtopic. Write at least 400 words, avoid copyrighted material, ensure accuracy, and focus only on ${bookTopic} chapter nine from the table of content. If information is limited, explain in simple terms and note limitations. Do not include the table of contents, other chapters, or unrelated topics like space please only write chapter nine after you are done writting chapter nine stop responding.`,
    
//     //Chapter 10
//     `As Hailu,you are going to follow this instruction that i will gave you. You write Chapter 10 of the book about "${bookTopic}", based on the table of contents you created. Focus only on the tenth chapter's topic and subtopics. Use a fun, simple, friendly tone, like explaining to a curious 16-year-old. Break down complex ideas into clear steps with vivid examples (e.g., for trading bots, compare them to a robot chef following a recipe) and if it seem important use one analogy per subtopic. Include a description of a diagram or table (e.g., "a diagram showing how a trading bot works") to aid understanding. Use clear headings for each subtopic. Write at least 400 words, avoid copyrighted material, ensure accuracy, and focus only on ${bookTopic} chapter ten from the table of content. If information is limited, explain in simple terms and note limitations. Do not include the table of contents, other chapters, or unrelated topics like space please only write chapter ten after you are done writting chapter ten stop responding.`,
    
//     //Chapter 11
//     `As Hailu,you are going to follow this instruction that i will gave you. You write Chapter 11 of the book about "${bookTopic}", based on the table of contents you created. Focus only on the eleventh chapter's topic and subtopics. Use a fun, simple, friendly tone, like explaining to a curious 16-year-old. Break down complex ideas into clear steps with vivid examples (e.g., for trading bots, compare them to a robot chef following a recipe) and if it seem important use one analogy per subtopic. Include a description of a diagram or table (e.g., "a diagram showing how a trading bot works") to aid understanding. Use clear headings for each subtopic. Write at least 400 words, avoid copyrighted material, ensure accuracy, and focus only on ${bookTopic} chapter eleven from the table of content. If information is limited, explain in simple terms and note limitations. Do not include the table of contents, other chapters, or unrelated topics like space please only write chapter eleven after you are done writting chapter eleven stop responding.`,

//     //Chapter 12
//     `As Hailu,you are going to follow this instruction that i will gave you. You write Chapter 12 of the book about "${bookTopic}", based on the table of contents you created. Focus only on the twelve chapter's topic and subtopics. Use a fun, simple, friendly tone, like explaining to a curious 16-year-old. Break down complex ideas into clear steps with vivid examples (e.g., for trading bots, compare them to a robot chef following a recipe) and if it seem important use one analogy per subtopic. Include a description of a diagram or table (e.g., "a diagram showing how a trading bot works") to aid understanding. Use clear headings for each subtopic. Write at least 400 words, avoid copyrighted material, ensure accuracy, and focus only on ${bookTopic} chapter twelve from the table of content. If information is limited, explain in simple terms and note limitations. Do not include the table of contents, other chapters, or unrelated topics like space please only write chapter twelve after you are done writting chapter twelve stop responding.`,

//     //Chapter 13
//     `As Hailu,you are going to follow this instruction that i will gave you. You write Chapter 13 of the book about "${bookTopic}", based on the table of contents you created. Focus only on the thirteen chapter's topic and subtopics. Use a fun, simple, friendly tone, like explaining to a curious 16-year-old. Break down complex ideas into clear steps with vivid examples (e.g., for trading bots, compare them to a robot chef following a recipe) and if it seem important use one analogy per subtopic. Include a description of a diagram or table (e.g., "a diagram showing how a trading bot works") to aid understanding. Use clear headings for each subtopic. Write at least 400 words, avoid copyrighted material, ensure accuracy, and focus only on ${bookTopic} chapter thirteen from the table of content. If information is limited, explain in simple terms and note limitations. Do not include the table of contents, other chapters, or unrelated topics like space please only write chapter thirteen after you are done writting chapter thirteen stop responding.`,

//     //Chapter 14
//     `As Hailu,you are going to follow this instruction that i will gave you. You write Chapter 14 of the book about "${bookTopic}", based on the table of contents you created. Focus only on the fourteen chapter's topic and subtopics. Use a fun, simple, friendly tone, like explaining to a curious 16-year-old. Break down complex ideas into clear steps with vivid examples (e.g., for trading bots, compare them to a robot chef following a recipe) and if it seem important use one analogy per subtopic. Include a description of a diagram or table (e.g., "a diagram showing how a trading bot works") to aid understanding. Use clear headings for each subtopic. Write at least 400 words, avoid copyrighted material, ensure accuracy, and focus only on ${bookTopic} chapter fourteen from the table of content. If information is limited, explain in simple terms and note limitations. Do not include the table of contents, other chapters, or unrelated topics like space please only write chapter fourteen after you are done writting chapter fourteen stop responding.`,

//     //Chapter 15
//     `As Hailu,you are going to follow this instruction that i will gave you. You write Chapter 15 of the book about "${bookTopic}", based on the table of contents you created. Focus only on the fifteen chapter's topic and subtopics. Use a fun, simple, friendly tone, like explaining to a curious 16-year-old. Break down complex ideas into clear steps with vivid examples (e.g., for trading bots, compare them to a robot chef following a recipe) and if it seem important use one analogy per subtopic. Include a description of a diagram or table (e.g., "a diagram showing how a trading bot works") to aid understanding. Use clear headings for each subtopic. Write at least 400 words, avoid copyrighted material, ensure accuracy, and focus only on ${bookTopic} chapter fifteen from the table of content. If information is limited, explain in simple terms and note limitations. Do not include the table of contents, other chapters, or unrelated topics like space please only write chapter fifteen after you are done writting chapter fifteen stop responding.`,

//     // Conclusion and References
//     `As Hailu, write the conclusion and references for the book about "${bookTopic}", based on the table of contents and chapters you created. Use a fun, simple, friendly tone, like explaining to a curious 19-year-old. In the conclusion (200–300 words), summarize the key ideas from all 5 chapters and inspire the reader to learn more about ${bookTopic}. In the references section, provide 3–5 reliable, beginner-friendly resources (e.g., for trading bots: Investopedia, Python libraries, or educational videos) with a 1–2 sentence description each. Use clear headings ("Conclusion" and "References"). Avoid copyrighted material, ensure resources are accessible and appropriate for beginners, and focus only on ${bookTopic}. If resources are limited, suggest general learning platforms and explain why. Do not include the table of contents, chapter content, or unrelated topics like space.`
//   ];
// }

// // === Task Queue ===
// const bookQueue = async.queue(async (task, callback) => {
//   try {
//     const { bookTopic, userId } = task;
//     await generateBookL(bookTopic, userId);
//     callback();
//   } catch (error) {
//     callback(error);
//   }
// }, 1); 

// // === Master Function ===
// export async function generateBookL(bookTopic, userId) {
//   const safeUserId = `${userId}-${bookTopic.replace(/\s+/g, '_').toLowerCase()}`;
//   logger.info(`Starting book generation for user: ${safeUserId}, topic: ${bookTopic}`);

//   try {
//     global.cancelFlags = global.cancelFlags || {};

//     userHistories.set(safeUserId, [{
//       role: "system",
//       content:
//         "Your name is Hailu. You are a kind, smart teacher explaining to a curious kid..."
//     }]);

//     const prompts = generatePrompts(bookTopic);
//     const chapterFiles = [];

//     for (let i = 0; i < prompts.length; i++) {
//       if (global.cancelFlags[safeUserId]) break;
//       const file = await generateChapter(prompts[i], i + 1, safeUserId, bookTopic);
//       chapterFiles.push(file);
//     }

//     const combinedContent = combineChapters(chapterFiles);
//     const pdfPath = path.join(OUTPUT_DIR, `${safeUserId}.pdf`);
//     await generatePDF(combinedContent, pdfPath);

//     logger.info(`Book generation completed: ${pdfPath}`);
//     return pdfPath;

//   } catch (error) {
//     logger.error(`Book generation failed for [${safeUserId}]: ${error.message}`);
//     throw error;
//   }
// }

















































// // import { Together } from "together-ai";
// // import { marked } from 'marked';
// // import hljs from 'highlight.js';
// // import puppeteer from 'puppeteer-core';
// // import chromium from '@sparticuz/chromium';
// // import fs from 'fs';
// // import path from 'path';
// // import { fileURLToPath } from 'url';
// // import { dirname } from 'path';
// // import async from 'async';
// // import winston from 'winston';

// // // Load environment variables
// // //dotenv.config();

// // const __filename = fileURLToPath(import.meta.url);
// // const __dirname = dirname(__filename);

// // // Constants
// // const HISTORY_DIR = path.join(__dirname, 'history');
// // const CHAPTER_PREFIX = 'chapter';
// // const OUTPUT_DIR = path.join(__dirname, '../pdfs');
// // const COMBINED_FILE = 'combined-chapters.txt';

// // // Logger Setup
// // const logger = winston.createLogger({
// //   level: 'info',
// //   format: winston.format.combine(
// //     winston.format.timestamp(),
// //     winston.format.json()
// //   ),
// //   transports: [
// //     new winston.transports.File({ filename: 'bookgen.log' }),
// //     new winston.transports.Console()
// //   ]
// // });

// // // Ensure directories exist
// // if (!fs.existsSync(HISTORY_DIR)) fs.mkdirSync(HISTORY_DIR);
// // if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR);

// // // Init
// // const together = new Together({
// //   apiKey: '18a96a823e402ef5dfedc1e372bf50fc8e6357bb25a0eff0bea25a07f51a1087', // Fallback for local testing
// // });

// // // Markdown & Code Highlighting
// // marked.setOptions({
// //   highlight: (code, lang) => {
// //     const validLang = hljs.getLanguage(lang) ? lang : 'plaintext';
// //     return hljs.highlight(code, { language: validLang }).value;
// //   }
// // });

// // // Per-user conversation history
// // const userHistories = new Map();

// // // === Utilities ===
// // function getHistoryFile(userId) {
// //   return path.join(HISTORY_DIR, `history-${userId}.json`);
// // }

// // function loadConversationHistory(userId) {
// //   const historyFile = getHistoryFile(userId);
// //   try {
// //     return JSON.parse(fs.readFileSync(historyFile, 'utf8'));
// //   } catch {
// //     logger.info(`No history found for user ${userId}. Starting fresh.`);
// //     return [];
// //   }
// // }

// // function saveConversationHistory(userId, history) {
// //   const trimmed = trimHistory(history);
// //   fs.writeFileSync(getHistoryFile(userId), JSON.stringify(trimmed, null, 2));
// //   logger.info(`Saved history for user ${userId}`);
// // }

// // function trimHistory(messages) {
// //   const tocMessage = messages.find(
// //     (msg) => msg.role === "assistant" && msg.content.toLowerCase().includes("table of contents")
// //   );
// //   return tocMessage ? [{
// //     role: "system",
// //     content:
// //       "Your name is Hailu. You are a kind, smart teacher explaining to a curious kid so you got to explain every single detail and also don't make them know they are a little curous kid. Use simple, clear words, break down complex ideas step-by-step, and include human-like examples. Always start with a table of contents, then write chapters. Focus only on the requested topic, ignore unrelated contexts. Table of Contents:\n\n" +
// //       tocMessage.content,
// //   }] : [];
// // }

// // function saveToFile(filename, content) {
// //   fs.writeFileSync(filename, content);
// //   logger.info(`Saved: ${filename}`);
// // }

// // function deleteFile(filePath) {
// //   try {
// //     fs.unlinkSync(filePath);
// //     logger.info(`Deleted: ${filePath}`);
// //   } catch (err) {
// //     logger.error(`Error deleting ${filePath}: ${err.message}`);
// //   }
// // }

// // function combineChapters(files) {
// //   let combined = '';
// //   for (const file of files) {
// //     combined += fs.readFileSync(file, 'utf8') + '\n\n';
// //   }
// //   fs.writeFileSync(path.join(OUTPUT_DIR, COMBINED_FILE), combined);
// //   return combined;
// // }

// // // === AI ===
// // async function askAI(prompt, userId, bookTopic) {
// //   const history = userHistories.get(userId) || [];
// //   const trimmedHistory = trimHistory(history);
// //   const messages = [...trimmedHistory, { role: 'user', content: prompt }];

// //   try {
// //     const response = await together.chat.completions.create({
// //       messages,
// //       model: "deepseek-ai/DeepSeek-R1-Distill-Llama-70B-free",
// //       top_p: 0.9,                 // balance of creativity and clarity
// //       temperature: 0.6,           // keeps things focused but still human
// //       presence_penalty: 0.3,      // allows gentle repetition where helpful
// //       frequency_penalty: 0.3,     // avoids word echo
// //       max_tokens: 3000            // allows long, complete chapter-style answers
// //     });

// //     let reply = response.choices[0].message.content
// //       .replace(/<think>[\s\S]*?<\/think>/gi, '')
// //       .replace(/^I'm DeepSeek-R1.*?help you\.\s*/i, '')
// //       .trim();

// //     // ✅ Flexible topic validation (word-based match)
// //     const topicWords = bookTopic.toLowerCase().split(/\s+/);
// //     const isRelevant = topicWords.some(word => reply.toLowerCase().includes(word));

// //     if (!isRelevant) {
// //       logger.warn(`🛑 Irrelevant output detected for [${userId}] on topic "${bookTopic}": ${reply.slice(0, 80)}...`);
// //       throw new Error(`Output does not appear relevant to topic: "${bookTopic}"`);
// //     }

// //     history.push({ role: 'user', content: prompt });
// //     history.push({ role: 'assistant', content: reply });
// //     userHistories.set(userId, history);
// //     saveConversationHistory(userId, history);

// //     logger.info(`✅ Valid AI response saved for [${userId}] on topic "${bookTopic}"`);
// //     return reply;

// //   } catch (error) {
// //     logger.error(`❌ AI request failed for [${userId}] on topic "${bookTopic}": ${error.message}`);
// //     throw error;
// //   }
// // }


// // // === Chapter ===
// // async function generateChapter(prompt, chapterNum, userId, bookTopic) {
// //   const history = userHistories.get(userId) || [];
// //   const tocMessage = history.find(
// //     (msg) => msg.role === 'assistant' && msg.content.toLowerCase().includes('chapter 1')
// //   );

// //   const toc = history.find(
// //     (msg) => msg.role === 'assistant' && msg.content.toLowerCase().includes('table of contents')
// //   );

// //   const modifiedPrompt = toc
// //     ? `${prompt}\n\nRefer to this Table of Contents:\n\n${toc.content}`
// //     : prompt;

// //   const chapterText = await askAI(modifiedPrompt, userId, bookTopic);
// //   const filename = path.join(OUTPUT_DIR, `${CHAPTER_PREFIX}-${userId}-${chapterNum}.txt`);
// //   saveToFile(filename, chapterText);
// //   return filename;
// // }


// // // === Formatter ===
// // function formatMath(content) {
// //   const links = [];
// //   content = content.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, text, url) => {
// //     links.push(`<a href="${url}" target="_blank">${text}</a>`);
// //     return `__LINK__${links.length - 1}__`;
// //   });

// //   content = content
// //     .replace(/\[\s*(.*?)\s*\]/gs, (_, math) => `\\(${math}\\)`)
// //     .replace(/\(\s*(.*?)\s*\)/gs, (_, math) => `\\(${math}\\)`)

// //     .replace(
// //       /([a-zA-Z0-9]+)\s*\^\s*([a-zA-Z0-9]+)/g,
// //       (_, base, exp) => `\\(${base}^{${exp}}\\)`,
// //     )

// //     .replace(
// //       /(?<!\\)(?<!\w)(\d+)\s*\/\s*(\d+)(?!\w)/g,
// //       (_, num, den) => `\\(\\frac{${num}}{${den}}\\)`,
// //     );

// //   content = content.replace(/__LINK__(\d+)__/g, (_, i) => links[i]);
// //   return content;
// // }

// // function cleanUpAIText(text) {
// //   return text
// //     .replace(/^(?:[-=_~\s]{5,})$/gm, "")
// //     .replace(/\n{3,}/g, "\n\n")
// //     .replace(/\n\s*$/g, "")
// //     .replace(/[\u2013\u2014]/g, "-")
// //     .trim();
// // }

// // async function generatePDF(content, outputPath) {
// //   const cleaned = cleanUpAIText(content);

// //   const html = `
// //   <html>
// //     <head>
// //       <meta charset="utf-8">
// //       <title>Document</title>
// //       <script type="text/javascript" id="MathJax-script" async
// //         src="https://cdn.jsdelivr.net/npm/mathjax@3/es5/tex-mml-chtml.js">
// //       </script>
// //       <script src="https://cdn.jsdelivr.net/npm/prismjs@1.29.0/prism.min.js"></script>
// //       <script src="https://cdn.jsdelivr.net/npm/prismjs@1.29.0/components/prism-javascript.min.js"></script>
// //       <බ

// //       <script src="https://cdn.jsdelivr.net/npm/prismjs@1.29.0/components/prism-python.min.js"></script>
// //       <script src="https://cdn.jsdelivr.net/npm/prismjs@1.29.0/components/prism-java.min.js"></script>
// //       <script src="https://cdn.jsdelivr.net/npm/prismjs@1.29.0/components/prism-cpp.min.js"></script>
// //       <link href="https://cdn.jsdelivr.net/npm/prismjs@1.29.0/themes/prism.min.css" rel="stylesheet">
// //       <style>
// //         @page { margin: 80px 60px; }
// //         body { font-family: 'Inter', 'Segoe UI', 'Helvetica Neue', sans-serif; font-size: 13.5px; line-height: 1.7; color: #1a1a1a; background: white; margin: 0; padding: 0; text-align: justify; }
// //         .cover { text-align: center; margin-top: 200px; }
// //         .cover h1 { font-size: 36px; font-weight: 700; margin-bottom: 0.2em; }
// //         .cover h2 { font-size: 20px; font-weight: 400; color: #555; }
// //         .page-break { page-break-before: always; }
// //         h1, h2, h3 { font-weight: 600; color: #2c3e50; margin-top: 2em; margin-bottom: 0.4em; }
// //         h1 { font-size: 24px; border-bottom: 2px solid #e0e0e0; padding-bottom: 5px; }
// //         h2 { font-size: 20px; border-bottom: 1px solid #e0e0e0; padding-bottom: 3px; }
// //         h3 { font-size: 16px; }
// //         p { margin: 0 0 1em 0; }
// //         a { color: #007acc; text-decoration: underline; }
// //         code, pre { font-family: 'Fira Code', monospace; border-radius: 6px; font-size: 13px; }
// //         code { background: #f4f4f4; padding: 3px 8px; border: 1px solid #e0e0e0; }
// //         pre { background: #f8f9fa; padding: 20px; overflow-x: auto; border: 1px solid #e0e0e0; line-height: 1.5; margin: 1.2em 0; white-space: pre-wrap; word-wrap: break-word; overflow-x: hidden; }
// //         pre code { background: none; border: none; padding: 0; }
// //         blockquote { border-left: 4px solid #007acc; margin: 1.5em 0; padding: 0.5em 0 0.5em 1.5em; background: #f8f9fa; color: #2c3e50; font-style: italic; border-radius: 4px; }
// //         hr { border: none; border-top: 1px solid #e0e0e0; margin: 2em 0; }
// //         .footer { font-size: 10px; text-align: center; width: 100%; color: #999; }
// //         .example { background: #f8f9fa; border-left: 4px solid #007acc; padding: 15px 20px; margin: 1.5em 0; border-radius: 4px; font-style: italic; }
// //         .toc { page-break-after: always; margin: 2em 0; padding: 1em; background: #f8f9fa; border-radius: 6px; }
// //         .toc h2 { font-size: 20px; border-bottom: 1px solid #e0e0e0; margin-bottom: 1em; }
// //         .toc ul { list-style: none; padding: 0; }
// //         .toc li { margin: 0.5em 0; }
// //         .toc a { text-decoration: none; color: #007acc; }
// //         .toc a:hover { text-decoration: underline; }
// //       </style>
// //     </head>
// //     <body>
// //       <div class="cover">
// //         <h1 style="font-family: sans-serif; margin-top: 100px; font-size: 14px; color: #777;">Generated by Bookgen.ai</h1>
// //         <p style="font-family: sans-serif; margin-top: 100px; font-size: 12px; color: #f00;">Caution: AI can make mistake </p>
// //       </div>
// //       <div class="page-break"></div>
// //       ${marked.parse(cleaned)}
// //       <script>
// //         document.addEventListener('DOMContentLoaded', () => {
// //           Prism.highlightAll();
// //         });
// //       </script>
// //     </body>
// //   </html>
// //   `;

// //   try {
// //     const browser = await puppeteer.launch({
// //       executablePath: await chromium.executablePath(),
// //       headless: chromium.headless,
// //       args: chromium.args,
// //     });
// //     const page = await browser.newPage();
// //     await page.setContent(html, { waitUntil: "networkidle0" });
// //     await page.pdf({
// //       path: outputPath,
// //       format: "A4",
// //       printBackground: true,
// //       displayHeaderFooter: true,
// //       footerTemplate: `
// //         <div class="footer" style="font-family: 'Inter', sans-serif; font-size: 10px; color: #999; text-align: center; width: 100%;">
// //           Page <span class="pageNumber"></span> of <span class="totalPages"></span>
// //         </div>
// //       `,
// //       headerTemplate: `<div style="font-size: 10px; text-align: center; width: 100%; color: #999;">
// //         bookgenai.vercel.app
// //       </div>`,
// //       margin: { top: "80px", bottom: "80px", left: "60px", right: "60px" },
// //     });
// //     await browser.close();
// //     logger.info(`Generated PDF: ${outputPath}`);
// //   } catch (error) {
// //     logger.error(`PDF generation failed: ${error.message}`);
// //     throw error;
// //   }
// // }

// // // === Prompt Generator ===
// // function generatePrompts(bookTopic) {
// //   return [
// //     // Table of Contents
// //     `As Hailu, you are going to follow this instruction that i will gave you. You must work with them for best out put. First write the title for the book then create a table of contents for a book about "${bookTopic}" for someone with no prior knowledge. The book must have 15 chapters, each covering a unique aspect of ${bookTopic} (e.g., for trading bots: what they are, how they work, strategies, risks, tools). Each chapter must be at least 400 words and written in a fun, simple, friendly tone, like explaining to a curious 16-year-old. Use clear, descriptive chapter titles and include more than 2–3 subtopics per chapter (e.g., "What is a trading bot?" or "How do trading bots make decisions?"). Output only the table of contents as a numbered list with chapter titles and subtopics. Ensure topics are distinct, avoid overlap, and focus strictly on ${bookTopic}. If ${bookTopic} is unclear, suggest relevant subtopics and explain why. Ignore any unrelated topics like space or previous requests. Remeber After you finish what you have been told you are goinig to stop after you finish creating the table of content you are done don't respond any more.`,

// //     // Chapter 1
// //     `As Hailu,you are going to follow this instruction that i will gave you. You write Chapter 1 of the book about "${bookTopic}", based on the table of contents you created. Focus only on the first chapter's topic and subtopics. Use a fun, simple, friendly tone, like explaining to a curious 16-year-old. Break down complex ideas into clear steps with vivid examples (e.g., for trading bots, compare them to a robot chef following a recipe) and if it seem important use one analogy per subtopic. Include a description of a diagram or table (e.g., "a diagram showing how a trading bot works") to aid understanding. Use clear headings for each subtopic. Write at least 400 words, avoid copyrighted material, ensure accuracy, and focus only on ${bookTopic} chapter one from the table of content. If information is limited, explain in simple terms and note limitations. Do not include the table of contents, other chapters, or unrelated topics like space please only write chapter one after you are done writting chapter one stop responding.`,

// //     // Chapter 2
// //     `As Hailu,you are going to follow this instruction that i will gave you. Now you write Chapter 2 of the book about "${bookTopic}", based on the table of contents you created. Focus only on the second chapter's topic and subtopics. Use a fun, simple, friendly tone, like explaining to a curious 16-year-old. Break down complex ideas into clear steps with vivid examples (e.g., for trading bots, compare them to a robot chef following a recipe) and if it seem important use one analogy per subtopic. Include a description of a diagram or table (e.g., "a diagram showing how a trading bot works") to aid understanding. Use clear headings for each subtopic. Write at least 400 words, avoid copyrighted material, ensure accuracy, and focus only on ${bookTopic} chapter two from the table of content. If information is limited, explain in simple terms and note limitations. Do not include the table of contents, other chapters, or unrelated topics like space please only write chapter two after you are done writting chapter two stop responding.`,

// //     // Chapter 3
// //     `As Hailu,you are going to follow this instruction that i will gave you. You write Chapter 3 of the book about "${bookTopic}", based on the table of contents you created. Focus only on the third chapter's topic and subtopics. Use a fun, simple, friendly tone, like explaining to a curious 16-year-old. Break down complex ideas into clear steps with vivid examples (e.g., for trading bots, compare them to a robot chef following a recipe) and if it seem important use one analogy per subtopic. Include a description of a diagram or table (e.g., "a diagram showing how a trading bot works") to aid understanding. Use clear headings for each subtopic. Write at least 400 words, avoid copyrighted material, ensure accuracy, and focus only on ${bookTopic} chapter three from the table of content. If information is limited, explain in simple terms and note limitations. Do not include the table of contents, other chapters, or unrelated topics like space please only write chapter three after you are done writting chapter three stop responding.`,
    
// //     // Chapter 4
// //     `As Hailu,you are going to follow this instruction that i will gave you. You write Chapter 4 of the book about "${bookTopic}", based on the table of contents you created. Focus only on the fourth chapter's topic and subtopics. Use a fun, simple, friendly tone, like explaining to a curious 16-year-old. Break down complex ideas into clear steps with vivid examples (e.g., for trading bots, compare them to a robot chef following a recipe) and if it seem important use one analogy per subtopic. Include a description of a diagram or table (e.g., "a diagram showing how a trading bot works") to aid understanding. Use clear headings for each subtopic. Write at least 400 words, avoid copyrighted material, ensure accuracy, and focus only on ${bookTopic} chapter four from the table of content. If information is limited, explain in simple terms and note limitations. Do not include the table of contents, other chapters, or unrelated topics like space please only write chapter four after you are done writting chapter four stop responding.`,
    
// //     // Chapter 5
// //     `As Hailu,you are going to follow this instruction that i will gave you. You write Chapter 5 of the book about "${bookTopic}", based on the table of contents you created. Focus only on the fifith chapter's topic and subtopics. Use a fun, simple, friendly tone, like explaining to a curious 16-year-old. Break down complex ideas into clear steps with vivid examples (e.g., for trading bots, compare them to a robot chef following a recipe) and if it seem important use one analogy per subtopic. Include a description of a diagram or table (e.g., "a diagram showing how a trading bot works") to aid understanding. Use clear headings for each subtopic. Write at least 400 words, avoid copyrighted material, ensure accuracy, and focus only on ${bookTopic} chapter five from the table of content. If information is limited, explain in simple terms and note limitations. Do not include the table of contents, other chapters, or unrelated topics like space please only write chapter five after you are done writting chapter five stop responding.`,
    
// //     //Chapter 6
// //     `As Hailu,you are going to follow this instruction that i will gave you. You write Chapter 6 of the book about "${bookTopic}", based on the table of contents you created. Focus only on the sixth chapter's topic and subtopics. Use a fun, simple, friendly tone, like explaining to a curious 16-year-old. Break down complex ideas into clear steps with vivid examples (e.g., for trading bots, compare them to a robot chef following a recipe) and if it seem important use one analogy per subtopic. Include a description of a diagram or table (e.g., "a diagram showing how a trading bot works") to aid understanding. Use clear headings for each subtopic. Write at least 400 words, avoid copyrighted material, ensure accuracy, and focus only on ${bookTopic} chapter six from the table of content. If information is limited, explain in simple terms and note limitations. Do not include the table of contents, other chapters, or unrelated topics like space please only write chapter six after you are done writting chapter six stop responding.`,    

// //     //Chapter 7
// //     `As Hailu,you are going to follow this instruction that i will gave you. You write Chapter 7 of the book about "${bookTopic}", based on the table of contents you created. Focus only on the seventh chapter's topic and subtopics. Use a fun, simple, friendly tone, like explaining to a curious 16-year-old. Break down complex ideas into clear steps with vivid examples (e.g., for trading bots, compare them to a robot chef following a recipe) and if it seem important use one analogy per subtopic. Include a description of a diagram or table (e.g., "a diagram showing how a trading bot works") to aid understanding. Use clear headings for each subtopic. Write at least 400 words, avoid copyrighted material, ensure accuracy, and focus only on ${bookTopic} chapter seven from the table of content. If information is limited, explain in simple terms and note limitations. Do not include the table of contents, other chapters, or unrelated topics like space please only write chapter seven after you are done writting chapter seven stop responding.`,
    
// //     //Chapter 8
// //     `As Hailu,you are going to follow this instruction that i will gave you. You write Chapter 8 of the book about "${bookTopic}", based on the table of contents you created. Focus only on the eightth chapter's topic and subtopics. Use a fun, simple, friendly tone, like explaining to a curious 16-year-old. Break down complex ideas into clear steps with vivid examples (e.g., for trading bots, compare them to a robot chef following a recipe) and if it seem important use one analogy per subtopic. Include a description of a diagram or table (e.g., "a diagram showing how a trading bot works") to aid understanding. Use clear headings for each subtopic. Write at least 400 words, avoid copyrighted material, ensure accuracy, and focus only on ${bookTopic} chapter eight from the table of content. If information is limited, explain in simple terms and note limitations. Do not include the table of contents, other chapters, or unrelated topics like space please only write chapter eight after you are done writting chapter eight stop responding.`,

// //     //Chapter 9
// //     `As Hailu,you are going to follow this instruction that i will gave you. You write Chapter 9 of the book about "${bookTopic}", based on the table of contents you created. Focus only on the nineth chapter's topic and subtopics. Use a fun, simple, friendly tone, like explaining to a curious 16-year-old. Break down complex ideas into clear steps with vivid examples (e.g., for trading bots, compare them to a robot chef following a recipe) and if it seem important use one analogy per subtopic. Include a description of a diagram or table (e.g., "a diagram showing how a trading bot works") to aid understanding. Use clear headings for each subtopic. Write at least 400 words, avoid copyrighted material, ensure accuracy, and focus only on ${bookTopic} chapter nine from the table of content. If information is limited, explain in simple terms and note limitations. Do not include the table of contents, other chapters, or unrelated topics like space please only write chapter nine after you are done writting chapter nine stop responding.`,
    
// //     //Chapter 10
// //     `As Hailu,you are going to follow this instruction that i will gave you. You write Chapter 10 of the book about "${bookTopic}", based on the table of contents you created. Focus only on the tenth chapter's topic and subtopics. Use a fun, simple, friendly tone, like explaining to a curious 16-year-old. Break down complex ideas into clear steps with vivid examples (e.g., for trading bots, compare them to a robot chef following a recipe) and if it seem important use one analogy per subtopic. Include a description of a diagram or table (e.g., "a diagram showing how a trading bot works") to aid understanding. Use clear headings for each subtopic. Write at least 400 words, avoid copyrighted material, ensure accuracy, and focus only on ${bookTopic} chapter ten from the table of content. If information is limited, explain in simple terms and note limitations. Do not include the table of contents, other chapters, or unrelated topics like space please only write chapter ten after you are done writting chapter ten stop responding.`,
    
// //     //Chapter 11
// //     `As Hailu,you are going to follow this instruction that i will gave you. You write Chapter 11 of the book about "${bookTopic}", based on the table of contents you created. Focus only on the eleventh chapter's topic and subtopics. Use a fun, simple, friendly tone, like explaining to a curious 16-year-old. Break down complex ideas into clear steps with vivid examples (e.g., for trading bots, compare them to a robot chef following a recipe) and if it seem important use one analogy per subtopic. Include a description of a diagram or table (e.g., "a diagram showing how a trading bot works") to aid understanding. Use clear headings for each subtopic. Write at least 400 words, avoid copyrighted material, ensure accuracy, and focus only on ${bookTopic} chapter eleven from the table of content. If information is limited, explain in simple terms and note limitations. Do not include the table of contents, other chapters, or unrelated topics like space please only write chapter eleven after you are done writting chapter eleven stop responding.`,

// //     //Chapter 12
// //     `As Hailu,you are going to follow this instruction that i will gave you. You write Chapter 12 of the book about "${bookTopic}", based on the table of contents you created. Focus only on the twelve chapter's topic and subtopics. Use a fun, simple, friendly tone, like explaining to a curious 16-year-old. Break down complex ideas into clear steps with vivid examples (e.g., for trading bots, compare them to a robot chef following a recipe) and if it seem important use one analogy per subtopic. Include a description of a diagram or table (e.g., "a diagram showing how a trading bot works") to aid understanding. Use clear headings for each subtopic. Write at least 400 words, avoid copyrighted material, ensure accuracy, and focus only on ${bookTopic} chapter twelve from the table of content. If information is limited, explain in simple terms and note limitations. Do not include the table of contents, other chapters, or unrelated topics like space please only write chapter twelve after you are done writting chapter twelve stop responding.`,

// //     //Chapter 13
// //     `As Hailu,you are going to follow this instruction that i will gave you. You write Chapter 13 of the book about "${bookTopic}", based on the table of contents you created. Focus only on the thirteen chapter's topic and subtopics. Use a fun, simple, friendly tone, like explaining to a curious 16-year-old. Break down complex ideas into clear steps with vivid examples (e.g., for trading bots, compare them to a robot chef following a recipe) and if it seem important use one analogy per subtopic. Include a description of a diagram or table (e.g., "a diagram showing how a trading bot works") to aid understanding. Use clear headings for each subtopic. Write at least 400 words, avoid copyrighted material, ensure accuracy, and focus only on ${bookTopic} chapter thirteen from the table of content. If information is limited, explain in simple terms and note limitations. Do not include the table of contents, other chapters, or unrelated topics like space please only write chapter thirteen after you are done writting chapter thirteen stop responding.`,

// //     //Chapter 14
// //     `As Hailu,you are going to follow this instruction that i will gave you. You write Chapter 14 of the book about "${bookTopic}", based on the table of contents you created. Focus only on the fourteen chapter's topic and subtopics. Use a fun, simple, friendly tone, like explaining to a curious 16-year-old. Break down complex ideas into clear steps with vivid examples (e.g., for trading bots, compare them to a robot chef following a recipe) and if it seem important use one analogy per subtopic. Include a description of a diagram or table (e.g., "a diagram showing how a trading bot works") to aid understanding. Use clear headings for each subtopic. Write at least 400 words, avoid copyrighted material, ensure accuracy, and focus only on ${bookTopic} chapter fourteen from the table of content. If information is limited, explain in simple terms and note limitations. Do not include the table of contents, other chapters, or unrelated topics like space please only write chapter fourteen after you are done writting chapter fourteen stop responding.`,

// //     //Chapter 15
// //     `As Hailu,you are going to follow this instruction that i will gave you. You write Chapter 15 of the book about "${bookTopic}", based on the table of contents you created. Focus only on the fifteen chapter's topic and subtopics. Use a fun, simple, friendly tone, like explaining to a curious 16-year-old. Break down complex ideas into clear steps with vivid examples (e.g., for trading bots, compare them to a robot chef following a recipe) and if it seem important use one analogy per subtopic. Include a description of a diagram or table (e.g., "a diagram showing how a trading bot works") to aid understanding. Use clear headings for each subtopic. Write at least 400 words, avoid copyrighted material, ensure accuracy, and focus only on ${bookTopic} chapter fifteen from the table of content. If information is limited, explain in simple terms and note limitations. Do not include the table of contents, other chapters, or unrelated topics like space please only write chapter fifteen after you are done writting chapter fifteen stop responding.`,

// //     // Conclusion and References
// //     `As Hailu, write the conclusion and references for the book about "${bookTopic}", based on the table of contents and chapters you created. Use a fun, simple, friendly tone, like explaining to a curious 19-year-old. In the conclusion (200–300 words), summarize the key ideas from all 5 chapters and inspire the reader to learn more about ${bookTopic}. In the references section, provide 3–5 reliable, beginner-friendly resources (e.g., for trading bots: Investopedia, Python libraries, or educational videos) with a 1–2 sentence description each. Use clear headings ("Conclusion" and "References"). Avoid copyrighted material, ensure resources are accessible and appropriate for beginners, and focus only on ${bookTopic}. If resources are limited, suggest general learning platforms and explain why. Do not include the table of contents, chapter content, or unrelated topics like space.`
// //   ];
// // }

// // // === Task Queue ===
// // const bookQueue = async.queue(async (task, callback) => {
// //   try {
// //     const { bookTopic, userId } = task;
// //     await generateBookS(bookTopic, userId);
// //     callback();
// //   } catch (error) {
// //     callback(error);
// //   }
// // }, 1); // Process one book at a time

// // // === Master Function ===
// // //generateBookL
// // export async function generateBookL(bookTopic, userId) {
// //   const safeUserId = `${userId}-${bookTopic.replace(/\s+/g, '_').toLowerCase()}`; // Unique ID per user and topic
// //   logger.info(`Starting book generation for user: ${safeUserId}, topic: ${bookTopic}`);

// //   try {
// //     global.cancelFlags = global.cancelFlags || {}; // ✅ Make sure global flag object exists

// //     // Initialize fresh history for this user and topic
// //     userHistories.set(safeUserId, [{
// //       role: "system",
// //       content:
// //         "Your name is Hailu. You are a kind, smart teacher explaining to a curious person. Use simple, clear words, break down complex ideas step-by-step, and include human-like examples. Always start with a table of contents, then write chapters. Focus only on the requested topic, ignore unrelated contexts."
// //     }]);

// //     const prompts = generatePrompts(bookTopic);
// //     const chapterFiles = [];

// //     for (const [index, prompt] of prompts.entries()) {
// //       // ✅ Check for cancellation before each chapter
// //       if (global.cancelFlags?.[userId]) {
// //         delete global.cancelFlags[userId];
// //         logger.warn(`❌ Book generation cancelled for user: ${userId}`);
// //         throw new Error('Generation cancelled');
// //       }

// //       const chapterNum = index + 1;
// //       logger.info(`Generating Chapter ${chapterNum} for ${bookTopic}`);
// //       try {
// //         const chapterFile = await generateChapter(prompt, chapterNum, safeUserId, bookTopic);
// //         chapterFiles.push(chapterFile);
// //       } catch (error) {
// //         logger.error(`Failed to generate Chapter ${chapterNum}: ${error.message}`);
// //         throw new Error(`Chapter ${chapterNum} generation failed`);
// //       }
// //     }

// //     const combinedContent = combineChapters(chapterFiles);

// //     const safeTopic = bookTopic.slice(0, 20).replace(/\s+/g, "_");
// //     const fileName = `output_${safeUserId}_${safeTopic}.pdf`;
// //     const outputPath = path.join(OUTPUT_DIR, fileName);
// //     await generatePDF(combinedContent, outputPath);

// //     chapterFiles.forEach(deleteFile);
// //     userHistories.delete(safeUserId); // Clean up history

// //     logger.info(`Book generation complete. Output: ${outputPath}`);
// //     return outputPath;
// //   } catch (error) {
// //     logger.error(`Book generation failed for ${safeUserId}: ${error.message}`);
// //     throw error;
// //   }
// // }
// // // === API Wrapper ===
// // export function queueBookGeneration(bookTopic, userId) {
// //   return new Promise((resolve, reject) => {
// //     bookQueue.push({ bookTopic, userId }, (error, result) => {
// //       if (error) {
// //         logger.error(`Queue failed for ${userId}: ${error.message}`);
// //         reject(error);
// //       } else {
// //         resolve(result);
// //       }
// //     });
// //   });
// // } shit
