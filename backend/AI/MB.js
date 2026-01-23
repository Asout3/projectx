import Cerebras from '@cerebras/cerebras_cloud_sdk';
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
const NUTRIENT_API_KEY = process.env.NUTRIENT_API_KEY;

let cerebras = null;
function ensureCerebras() {
  if (cerebras) return cerebras;
  const key = 'csk-8jrexx2mcp496w9ypyxtnffmjdn29dch46ydc2jh9jmh2yxy';
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
  const tables = [];
  const codeBlocks = [];
  content = content.replace(/(\|.+\|[\s]*\n\|[-:\s|]+\|[\s]*\n(?:\|.*\|[\s]*\n?)*)/g, (tbl) => {
    tables.push(tbl);
    return `__TABLE__${tables.length - 1}__`;
  });
  content = content.replace(/```[\w]*\n([\s\S]*?)```/g, (match) => {
    codeBlocks.push(match);
    return `__CODE__${codeBlocks.length - 1}__`;
  });
  content = content.replace(/`([^`]+)`/g, (match) => {
    codeBlocks.push(match);
    return `__CODE__${codeBlocks.length - 1}__`;
  });
  content = content.replace(/^\\\[(.+)\\\]$/gm, '$$$1$$');
  content = content.replace(/\\wedge/g, '^');
  content = content.replace(/\{\\\^\}/g, '^');
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
  const prompt = `Create a detailed table of contents for a comprehensive educational book titled "${bookTopic}".
The book must guide a complete beginner to intermediate/expert proficiency.

REQUIREMENTS (FOLLOW EXACTLY):
- Output EXACTLY 12 chapters
- Progressive structure:
  Chapters 1–2: Foundations and prerequisites
  Chapters 3–6: Core concepts and theory
  Chapters 7–9: Practical techniques and implementation
  Chapters 10–12: Advanced topics, applications, and future directions
- Format: "Chapter X: Descriptive Title" on its own line
- Follow each title with 4–6 subtopics, indented with "   - "
- Subtopics must show clear progression
- Include aspects like examples, pitfalls, exercises where appropriate
- NO extra text, NO explanations, NO markdown beyond specified format`;

  let attempts = 0;
  while (attempts < 5) {
    const genOptions = { maxOutputTokens: 1500, temperature: 0.3 };
    try {
      const rawTOC = await askAI(prompt, userId, bookTopic, { saveToHistory: true, genOptions });
      const cleaned = cleanUpAIText(rawTOC);
      const parsed = parseTOC(cleaned);
      
      if (parsed.length >= 10 && parsed.every(c => c.subtopics.length >= 4)) {
        logger.info(`TOC succeeded on attempt ${attempts + 1} (${parsed.length} chapters)`);
        return { raw: cleaned, parsed };
      }
      logger.warn(`TOC invalid – attempt ${attempts + 1}: Got ${parsed.length} chapters`);
    } catch (e) {
      logger.error(`TOC AI error – attempt ${attempts + 1}: ${e.message}`);
    }
    attempts++;
  }
  
  logger.warn(`TOC failed after 5 attempts – using fallback`);
  return generateFallbackTOC(bookTopic);
}

async function generateChapter(bookTopic, chapterNumber, chapterInfo, userId) {
  const subtopicList = chapterInfo.subtopics.map(s => `- ${s}`).join('\n');
  
  const prompt = `Write Chapter ${chapterNumber}: "${chapterInfo.title}" for a comprehensive educational book on "${bookTopic}".

GOAL: Teach deeply — take a motivated beginner to genuine understanding and practical ability.

MANDATORY PEDAGOGICAL STRUCTURE (in clean Markdown):
- Start with EXACTLY "## ${chapterInfo.title}"
- Overview (150–250 words): motivation, learning objectives, chapter roadmap
- One dedicated subsection (###) for EACH subtopic:
  ${subtopicList}
  Each subsection must include:
  • Clear explanations with analogies
  • Step-by-step breakdowns
  • Worked examples or calculations
  • Common misconceptions and pitfalls
- REQUIRED FINAL SECTIONS:
  ### Key Takeaways (bullet points)
  ### Practice Exercises (4–6 questions of increasing difficulty)
  ### Mini-Project or Application Challenge (one hands-on task)
  ### Further Reading (4–6 real resources: books, papers, websites with authors/years when possible)

ADDITIONAL REQUIREMENTS:
- Use Mermaid diagrams liberally to illustrate processes, architectures, relationships
- For each diagram: wrap in \`\`\`mermaid, followed by one line "*Figure caption: Brief description*"
- Minimum 3000 words total
- Tone: rigorous yet patient, encouraging, clear
- Use strict GitHub Markdown tables
- NO HTML tags

Output ONLY the chapter content.`;

  return cleanUpAIText(await askAI(prompt, userId, bookTopic, {
    minLength: 8000,
    genOptions: { maxOutputTokens: 8000, temperature: 0.4 }
  }));
}

async function generateConclusion(bookTopic, chapterInfos, userId) {
  const titles = chapterInfos.map(c => c.title).join(', ');
  
  const prompt = `Write a comprehensive Conclusion chapter for the book "${bookTopic}".

REQUIREMENTS:
- Synthesize key insights from all chapters: ${titles}
- Discuss real-world impact and major case studies
- Provide a learning roadmap for continued mastery (projects, communities, advanced resources)
- Include reflection questions to solidify understanding
- End with an inspiring outlook on the field's future
- 1000–1500 words
- Tone: reflective, motivating, professional`;

  return cleanUpAIText(await askAI(prompt, userId, bookTopic, {
    minLength: 3000,
    genOptions: { maxOutputTokens: 4000, temperature: 0.4 }
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
    logger.info('Rendering diagrams...');
    const { content: processedContent, figures } = await formatDiagrams(content);
    
    const enhancedHtml = buildEnhancedHTML(processedContent, bookTitle, figures);
    
    const form = new FormData();
    const instructions = {
      parts: [{ html: "index.html" }],
      output: {
        format: "pdf",
        pdf: {
          margin: { top: "100px", bottom: "90px", left: "80px", right: "80px" },
          header: {
            content: '<div style="font-family: Inter, sans-serif; font-size: 11px; text-align: center; color: #64748b;">${bookTitle}</div>',
            spacing: "8mm"
          },
          footer: {
            content: '<div style="font-family: Inter, sans-serif; font-size: 11px; text-align: center; color: #64748b;">Page {pageNumber} • Generated by Bookgen.AI</div>',
            spacing: "8mm"
          },
          waitDelay: 4000,
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
    
    const response = await fetch('https://api.nutrient.io/build', {
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
    logger.info(`PDF generated: ${outputPath}`);
    return outputPath;
  } catch (error) {
    logger.error(`PDF generation failed: ${error.message}`);
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
    const formattedTOC = `# Table of Contents\n\n${chapterInfos.map((ch, i) => {
      const num = i + 1;
      return `${num}. ${ch.title}\n${ch.subtopics.map(s => `   - ${s}`).join('\n')}`;
    }).join('\n\n')}\n\n---\n`;
    
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
      
      const chapter = await generateChapter(bookTopic, chNum, info, safeUserId);
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


// import Cerebras from '@cerebras/cerebras_cloud_sdk';
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
//     this.limit = requestsPerMinute;
//     this.users = new Map();
//   }

//   async wait(userId) {
//     const now = Date.now();
//     if (!this.users.has(userId)) this.users.set(userId, []);
    
//     const userRequests = this.users.get(userId);
//     const recent = userRequests.filter(t => now - t < 60000);
//     this.users.set(userId, recent);

//     while (recent.length >= this.limit) {
//       const oldest = recent[0];
//       const waitTime = 60000 - (now - oldest) + 1000;
//       await new Promise(resolve => setTimeout(resolve, waitTime));
//     }

//     recent.push(now);
//     this.users.set(userId, recent);
//   }
// }

// const userRateLimiter = new RateLimiter(30);
// const HISTORY_DIR = path.join(__dirname, 'history');
// const OUTPUT_DIR = path.join(__dirname, '../pdfs');
// const CHAPTER_PREFIX = 'chapter';
// const MODEL_NAME = 'gpt-oss-120b';
// const NUTRIENT_API_KEY = process.env.NUTRIENT_API_KEY;

// let cerebras = null;
// function ensureCerebras() {
//   if (cerebras) return cerebras;
//   const key = 'csk-8jrexx2mcp496w9ypyxtnffmjdn29dch46ydc2jh9jmh2yxy';
//   if (!key) {
//     throw new Error('CEREBRAS_API_KEY is not set in environment.');
//   }
//   cerebras = new Cerebras({ apiKey: key });
//   return cerebras;
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
//   let clean = text
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

//   clean = clean.replace(/\\(\$)/g, '$');
//   return clean;
// }

// function formatMath(content) {
//   const tables = [];
//   const codeBlocks = [];

//   content = content.replace(/(\|.+\|[\s]*\n\|[-:\s|]+\|[\s]*\n(?:\|.*\|[\s]*\n?)*)/g, (tbl) => {
//     tables.push(tbl);
//     return `__TABLE__${tables.length - 1}__`;
//   });

//   content = content.replace(/```[\w]*\n([\s\S]*?)```/g, (match) => {
//     codeBlocks.push(match);
//     return `__CODE__${codeBlocks.length - 1}__`;
//   });

//   content = content.replace(/`([^`]+)`/g, (match) => {
//     codeBlocks.push(match);
//     return `__CODE__${codeBlocks.length - 1}__`;
//   });

//   content = content.replace(/^\\\[(.+)\\\]$/gm, '$$$1$$');
//   content = content.replace(/\\wedge/g, '^');
//   content = content.replace(/\{\\\^\}/g, '^');

//   content = content.replace(/__TABLE__(\d+)__/g, (_, i) => tables[i]);
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

// // ==================== DIAGRAM LOGIC ====================
// function repairMermaidSyntax(code) {
//   let fixed = code
//     .replace(/^mermaid\s*\n/i, '')
//     .replace(/\[([^\]]*?\(.*?\)[^\]]*?)\]/g, (match, content) => {
//       if (content.startsWith('"') && content.endsWith('"')) return match;
//       return `["${content.replace(/"/g, "'")}"]`;
//     })
//     .replace(/-->;\s*$/gm, '-->')
//     .replace(/-->;\s*\n?\s*([A-Z])/g, '--> $1')
//     .replace(/\n{2,}/g, '\n')
//     .replace(/-->\s*$/gm, '--> EndNode[End]');
//   return fixed.trim();
// }

// async function formatDiagrams(content) {
//   const figures = [];
//   const diagramCounts = {};
//   const diagramRegex = /```mermaid\n([\s\S]*?)```\s*(?:\n\s*\*Figure caption:\s*(.+?)(?=\n\n|\n#|\n$))?/gs;

//   const chapterMatches = [...content.matchAll(/# Chapter (\d+):/g)];
//   const chapterPositions = chapterMatches.map(m => ({ num: parseInt(m[1]), pos: m.index }));
//   const matches = [...content.matchAll(diagramRegex)];

//   if (matches.length > 0) {
//     logger.info(`🔍 Found ${matches.length} mermaid code blocks. Rendering...`);
//   }

//   for (let match of matches) {
//     const fullMatch = match[0];
//     const rawCode = match[1].trim();
//     const caption = match[2] ? match[2].trim() : 'Illustration of the concept';
//     const code = repairMermaidSyntax(rawCode);

//     let currentChapter = 0;
//     for (let i = chapterPositions.length - 1; i >= 0; i--) {
//       if (chapterPositions[i].pos < match.index) {
//         currentChapter = chapterPositions[i].num;
//         break;
//       }
//     }
//     if (currentChapter === 0) {
//       currentChapter = chapterPositions.length > 0 ? chapterPositions[chapterPositions.length - 1].num : 1;
//     }

//     if (!diagramCounts[currentChapter]) diagramCounts[currentChapter] = 0;
//     diagramCounts[currentChapter]++;
//     const figNum = `${currentChapter}.${diagramCounts[currentChapter]}`;

//     try {
//       const response = await fetch('https://kroki.io/mermaid/svg', {
//         method: 'POST',
//         headers: {
//           'Content-Type': 'text/plain',
//           'Accept': 'image/svg+xml'
//         },
//         body: code
//       });

//       if (!response.ok) {
//         if (response.status === 400) {
//           logger.warn(`Invalid Mermaid Syntax Detected:\n${code}`);
//         }
//         throw new Error(`Kroki error: ${response.status}`);
//       }

//       const svg = await response.text();
//       const base64 = `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;

//       figures.push({ base64, figNum, caption });
//       content = content.replace(fullMatch, `__FIGURE__${figures.length - 1}__`);
//       logger.info(`✅ Diagram rendered successfully with caption: "${caption}"`);

//     } catch (error) {
//       logger.error(`❌ Failed to render diagram: ${error.message}`);
//       content = content.replace(fullMatch, '');
//     }
//   }

//   return { content, figures };
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
  
//   return valid.slice(0, 10);
// }

// function generateFallbackTOC(bookTopic) {
//   const cleanTopic = bookTopic.replace(/\bin\s+.*$/i, '').trim();
  
//   const base = [
//     "Introduction to Core Concepts",
//     "Essential Principles and Practices", 
//     "Understanding Key Systems",
//     "Practical Applications and Techniques",
//     "Advanced Topics and Future Trends",
//     "Case Studies and Real-World Examples",
//     "Implementation Strategies",
//     "Optimization and Best Practices",
//     "Troubleshooting and Common Issues",
//     "Future Directions and Innovations"
//   ];
  
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
//     `${c.title}\n${c.subtopics.map(s => `   - ${s}`).join('\n')}`
//   ).join('\n\n');
  
//   return { raw, parsed: chapters };
// }

// // ==================== AI INTERACTION ====================
// async function askAI(prompt, userId, bookTopic, options = {}) {
//   await userRateLimiter.wait(userId);

//   const maxRetries = 3;
//   for (let attempt = 0; attempt < maxRetries; attempt++) {
//     try {
//       const result = await ensureCerebras().chat.completions.create({
//         model: MODEL_NAME,
//         messages: [{ role: "user", content: prompt }],
//         max_tokens: options.genOptions?.maxOutputTokens || 4000,
//         temperature: options.genOptions?.temperature || 0.7,
//         stream: false
//       });
      
//       let reply = result.choices[0].message.content || '';
      
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
//   const prompt = `Create a detailed table of contents for a book about "${bookTopic}".
// REQUIREMENTS (FOLLOW EXACTLY):
// - Output EXACTLY 10 chapters
// - Use the format: "Chapter X: Title" on its own line
// - Follow each chapter title with 3-5 subtopics, each on its own line, indented with 3 spaces and a dash: "   - Subtopic"
// - NO extra text, NO explanations, NO markdown
// - Make titles descriptive and unique`;

//   let attempts = 0;
//   while (attempts < 5) {
//     const genOptions = { maxOutputTokens: 1000, temperature: 0.3, topP: 0.8 };
//     try {
//       const rawTOC = await askAI(prompt, userId, bookTopic, { saveToHistory: true, genOptions });
      
//       const cleaned = cleanUpAIText(rawTOC);
//       const parsed = parseTOC(cleaned);

//       if (parsed.length === 10 && parsed.every(c => c.subtopics.length >= 3)) {
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
//   const subtopicList = chapterInfo.subtopics.map(s => `- ${s}`).join('\n');

//   const prompt = `Write Chapter ${chapterNumber}: "${chapterInfo.title}" for a book about "${bookTopic}".
// CRITICAL FORMATTING RULES:
// - Start with EXACTLY ONE heading: "## ${chapterInfo.title}"
// - Do NOT repeat the title as a second heading
// - Use ### for ALL subsections
// - ALL tables MUST use strict GitHub Markdown table syntax
// - NO HTML tags like <header> or <footer>
// - 600+ words total

// **DIAGRAMS (Optional):**
// - Create Mermaid diagrams ONLY if they help explain complex concepts
// - If used: Wrap in \`\`\`mermaid \`\`\` blocks
// - Quote node labels with parentheses: A["User (Admin)"]
// - Immediately after each diagram block, add EXACTLY one line: *Figure caption: Brief description of the diagram*

// MANDATORY STRUCTURE:
// 1) Introduction: Overview.
// 2) SECTIONS: Create a subsection (###) for EACH subtopic:
// ${subtopicList}
// 3) Practical Application: Real-world example.
// 4) Further Reading: 2-3 references.

// Output ONLY the chapter content.`;

//   return cleanUpAIText(await askAI(prompt, userId, bookTopic, {
//     minLength: 1800,
//     genOptions: { maxOutputTokens: 3500, temperature: 0.4 }
//   }));
// }

// async function generateConclusion(bookTopic, chapterInfos, userId) {
//   const titles = chapterInfos.map(c => c.title).join(', ');
//   const prompt = `Write a professional conclusion for a book about "${bookTopic}". Summarize: ${titles}. 350 words.`;
  
//   return cleanUpAIText(await askAI(prompt, userId, bookTopic, {
//     minLength: 1200,
//     genOptions: { maxOutputTokens: 2000, temperature: 0.4 }
//   }));
// }

// // ==================== PDF GENERATION ====================
// function buildEnhancedHTML(content, bookTitle, figures = []) {
//   const cleaned = cleanUpAIText(content);
//   const formattedContent = formatMath(cleaned);
  
//   // Restore figures with captions
//   const finalContent = formattedContent.replace(/__FIGURE__(\d+)__/g, (_, i) => {
//     const fig = figures[parseInt(i)];
//     if (!fig) return '';
//     return `<figure style="text-align: center; margin: 2em 0;">
//       <img src="${fig.base64}" alt="${fig.caption}" style="max-width: 85%; height: auto; border: 1px solid #e5e7eb; border-radius: 8px; box-shadow: 0 4px 6px rgba(0,0,0,0.05);">
//       <figcaption style="margin-top: 0.5em; font-style: italic; color: #6b7280; font-size: 0.9em;">Figure ${fig.figNum}: ${fig.caption}</figcaption>
//     </figure>`;
//   });

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
//   <link rel="preconnect" href="https://fonts.googleapis.com">
//   <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
//   <link href="https://fonts.googleapis.com/css2?family=Merriweather:wght@300;400;700&family=Inter:wght@400;600;700&display=swap" rel="stylesheet">
//   <script>
//     window.MathJax = {
//       tex: { inlineMath: [['$', '$'], ['\\\\(', '\\\\)']], displayMath: [['$$', '$$']] },
//       svg: { fontCache: 'global' }
//     };
//   </script>
//   <script type="text/javascript" id="MathJax-script" async src="https://cdn.jsdelivr.net/npm/mathjax@3/es5/tex-mml-chtml.js"></script>
//   <script src="https://cdn.jsdelivr.net/npm/prismjs@1.29.0/prism.min.js"></script>
//   <script src="https://cdn.jsdelivr.net/npm/prismjs@1.29.0/components/prism-javascript.min.js"></script>
//   <script src="https://cdn.jsdelivr.net/npm/prismjs@1.29.0/components/prism-python.min.js"></script>
//   <link href="https://cdn.jsdelivr.net/npm/prismjs@1.29.0/themes/prism-tomorrow.min.css" rel="stylesheet">
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
//     pre { background: #1f2937; padding: 20px; overflow-x: auto; border: 1px solid #4b5563; border-radius: 8px; line-height: 1.5; margin: 1.5em 0; white-space: pre-wrap; word-wrap: break-word; box-shadow: 0 4px 6px rgba(0,0,0,0.05); }
//     pre code { background: none; border: none; padding: 0; color: #e5e7eb; }
//     blockquote { border-left: 4px solid #667eea; margin: 2em 0; padding: 1em 1.5em; background: linear-gradient(to right, #f3f4f6 0%, #ffffff 100%); font-style: italic; border-radius: 0 8px 8px 0; position: relative; }
//     blockquote::before { content: "“"; position: absolute; top: -20px; left: 10px; font-size: 80px; color: #d1d5db; font-family: 'Inter', sans-serif; line-height: 1; }
//     .example { background: linear-gradient(to right, #eff6ff 0%, #ffffff 100%); border-left: 4px solid #3b82f6; padding: 20px; margin: 2em 0; border-radius: 0 8px 8px 0; font-style: italic; position: relative; }
//     .example::before { content: "💡 Example"; display: block; font-weight: 600; color: #1d4ed8; margin-bottom: 10px; font-style: normal; }
//     table { width: 100%; border-collapse: collapse; margin: 2em 0; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
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
//     <div class="cover-meta">Generated by bookgen.ai<br>${new Date().toLocaleDateString()}</div>
//   </div>
//   <div class="chapter-content">${marked.parse(finalContent)}</div>
//   <div class="disclaimer-footer">This book was generated by AI for educational purposes. Please verify all information independently.</div>
//   <script>document.addEventListener('DOMContentLoaded', () => { Prism.highlightAll(); });</script>
// </body>
// </html>`;
// }

// async function generatePDF(content, outputPath, bookTitle) {
//   try {
//     logger.info('🎨 Rendering diagrams (if any)...');
//     const { content: processedContent, figures } = await formatDiagrams(content);
    
//     const enhancedHtml = buildEnhancedHTML(processedContent, bookTitle, figures);
    
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

// // ==================== MAIN GENERATOR ====================
// export async function generateBookMedd(rawTopic, userId) {
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
//     const result = await generateBookMedd(task.bookTopic, task.userId);
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













// import Cerebras from '@cerebras/cerebras_cloud_sdk';
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
//     this.limit = requestsPerMinute;
//     this.users = new Map();
//   }

//   async wait(userId) {
//     const now = Date.now();
//     if (!this.users.has(userId)) this.users.set(userId, []);
    
//     const userRequests = this.users.get(userId);
//     const recent = userRequests.filter(t => now - t < 60000);
//     this.users.set(userId, recent);

//     while (recent.length >= this.limit) {
//       const oldest = recent[0];
//       const waitTime = 60000 - (now - oldest) + 1000;
//       await new Promise(resolve => setTimeout(resolve, waitTime));
//     }

//     recent.push(now);
//     this.users.set(userId, recent);
//   }
// }

// const userRateLimiter = new RateLimiter(30); // Cerebras allows 30/min
// const HISTORY_DIR = path.join(__dirname, 'history');
// const OUTPUT_DIR = path.join(__dirname, '../pdfs');
// const STATE_DIR = path.join(__dirname, 'states');
// const CHAPTER_PREFIX = 'chapter';
// const MODEL_NAME = 'gpt-oss-120b';
// const NUTRIENT_API_KEY = process.env.NUTRIENT_API_KEY;

// let cerebras = null;
// function ensureCerebras() {
//   if (cerebras) return cerebras;
//   const key = process.env.CEREBRAS_API_KEY || 'csk-8jrexx2mcp496w9ypyxtnffmjdn29dch46ydc2jh9jmh2yxy';
//   cerebras = new Cerebras({ apiKey: key });
//   return cerebras;
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
// fs.mkdirSync(STATE_DIR, { recursive: true });

// // ==================== CHECKPOINT SYSTEM ====================
// class CheckpointManager {
//   static getPath(userId) {
//     return path.join(STATE_DIR, `state-${userId}.json`);
//   }

//   static load(userId) {
//     const file = this.getPath(userId);
//     if (fs.existsSync(file)) {
//       try {
//         const data = JSON.parse(fs.readFileSync(file, 'utf8'));
//         logger.info(`🔄 Resuming session for ${userId} at Chapter ${data.completedChapters + 1}`);
//         return data;
//       } catch (e) {
//         logger.error('Corrupt state file, starting fresh.');
//       }
//     }
//     return null;
//   }

//   static save(userId, data) {
//     fs.writeFileSync(this.getPath(userId), JSON.stringify(data, null, 2));
//   }

//   static clear(userId) {
//     const file = this.getPath(userId);
//     if (fs.existsSync(file)) fs.unlinkSync(file);
//   }
// }

// // ==================== DYNAMIC MESH COVER ====================
// function generateMeshGradient() {
//   const h1 = Math.floor(Math.random() * 360);
//   const h2 = (h1 + 60) % 360;
//   const h3 = (h1 + 180) % 360;
//   return `background-color: hsl(${h1}, 60%, 50%);
//           background-image: 
//             radial-gradient(at 40% 20%, hsla(${h2}, 100%, 74%, 1) 0px, transparent 50%),
//             radial-gradient(at 80% 0%, hsla(${h3}, 100%, 56%, 1) 0px, transparent 50%),
//             radial-gradient(at 0% 50%, hsla(${h2}, 100%, 93%, 1) 0px, transparent 50%),
//             radial-gradient(at 80% 50%, hsla(${h3}, 100%, 76%, 1) 0px, transparent 50%),
//             radial-gradient(at 0% 100%, hsla(${h1}, 100%, 78%, 1) 0px, transparent 50%),
//             radial-gradient(at 80% 100%, hsla(${h2}, 100%, 56%, 1) 0px, transparent 50%),
//             radial-gradient(at 0% 0%, hsla(${h3}, 100%, 78%, 1) 0px, transparent 50%);`;
// }

// // ==================== TEXT PROCESSING ====================
// function cleanUpAIText(text) {
//   if (!text) return '';
//   let clean = text
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

//   clean = clean.replace(/\\(\$)/g, '$');
//   return clean;
// }

// function formatMath(content) {
//   const tables = [];
//   const codeBlocks = [];

//   content = content.replace(/(\|.+\|[\s]*\n\|[-:\s|]+\|[\s]*\n(?:\|.*\|[\s]*\n?)*)/g, (tbl) => {
//     tables.push(tbl);
//     return `__TABLE__${tables.length - 1}__`;
//   });

//   content = content.replace(/```[\w]*\n([\s\S]*?)```/g, (match) => {
//     codeBlocks.push(match);
//     return `__CODE__${codeBlocks.length - 1}__`;
//   });

//   content = content.replace(/`([^`]+)`/g, (match) => {
//     codeBlocks.push(match);
//     return `__CODE__${codeBlocks.length - 1}__`;
//   });

//   content = content.replace(/^\\\[(.+)\\\]$/gm, '$$$1$$');
//   content = content.replace(/\\wedge/g, '^');
//   content = content.replace(/\{\\\^\}/g, '^');

//   content = content.replace(/__TABLE__(\d+)__/g, (_, i) => tables[i]);
//   content = content.replace(/__CODE__(\d+)__/g, (_, i) => codeBlocks[i]);

//   return content;
// }

// // ==================== MARKED SETUP WITH CALLOUTS ====================
// marked.use({
//   renderer: {
//     blockquote(quote) {
//       const textSource = typeof quote === 'string' ? quote : (quote.text || '');
//       const rawText = textSource.replace(/<p>|<\/p>|\n/g, '').trim();
      
//       if (rawText.includes('[!PRO-TIP]') || rawText.includes('[!TIP]')) {
//         const content = textSource.replace(/\[!(PRO-)?TIP\]/i, '');
//         return `<div class="callout callout-tip"><strong>💡 Pro Tip</strong>${content}</div>`;
//       }
//       if (rawText.includes('[!WARNING]') || rawText.includes('[!CAUTION]')) {
//         const content = textSource.replace(/\[!(WARNING|CAUTION)\]/i, '');
//         return `<div class="callout callout-warning"><strong>⚠️ Caution</strong>${content}</div>`;
//       }
//       if (rawText.includes('[!NOTE]')) {
//         const content = textSource.replace(/\[!NOTE\]/i, '');
//         return `<div class="callout callout-note"><strong>ℹ️ Note</strong>${content}</div>`;
//       }
//       return `<blockquote class="standard-quote">${textSource}</blockquote>`;
//     }
//   },
//   highlight: function(code, lang) {
//     if (lang && hljs.getLanguage(lang)) {
//       return hljs.highlight(code, { language: lang }).value;
//     }
//     return code;
//   },
//   gfm: true,
//   breaks: true
// });

// // ==================== DIAGRAM LOGIC ====================
// function repairMermaidSyntax(code) {
//   return code
//     .replace(/^mermaid\s*\n/i, '')
//     .replace(/\[([^\]]*?\(.*?\)[^\]]*?)\]/g, (m, c) => c.startsWith('"') ? m : `["${c.replace(/"/g, "'")}"]`)
//     .replace(/-->;\s*$/gm, '-->')
//     .replace(/-->\s*$/gm, '--> EndNode[End]')
//     .trim();
// }

// async function formatDiagrams(content) {
//   const figures = [];
//   const diagramRegex = /```mermaid\n([\s\S]*?)```\s*(?:\n\s*\*Figure caption:\s*(.+?)(?=\n\n|\n#|\n$))?/gs;
//   let i = 0;
  
//   const matches = [...content.matchAll(diagramRegex)];
  
//   for (let match of matches) {
//     const fullMatch = match[0];
//     const code = repairMermaidSyntax(match[1]);
//     const caption = match[2] || 'Illustration';
//     const figNum = `${Math.floor(i / 10) + 1}.${(i % 10) + 1}`;
//     i++;

//     try {
//       const res = await fetch('https://kroki.io/mermaid/svg', {
//         method: 'POST',
//         body: code,
//         headers: { 'Content-Type': 'text/plain' }
//       });
//       if (res.ok) {
//         const svg = await res.text();
//         const compressedSvg = svg.replace(/\s+/g, ' ').replace(/"\s+/g, '"').trim();
//         const base64 = `data:image/svg+xml;base64,${Buffer.from(compressedSvg).toString('base64')}`;
//         figures.push({ base64, caption, figNum });
//         content = content.replace(fullMatch, `__FIGURE__${figures.length - 1}__`);
//       } else {
//         content = content.replace(fullMatch, '');
//       }
//     } catch (e) {
//       content = content.replace(fullMatch, '');
//     }
//   }
//   return { content, figures };
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
//       if (nextLine && nextLine.length > 5 && !nextLine.match(/^[\s]*[-•*·\d]/)) {
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
//   logger.info(`✅ Parsed ${valid.length} valid chapters`);
//   return valid.slice(0, 10);
// }

// function generateFallbackTOC(bookTopic) {
//   const cleanTopic = bookTopic.replace(/\bin\s+.*$/i, '').trim();
//   const base = [
//     "Introduction to Core Concepts",
//     "Essential Principles and Practices", 
//     "Understanding Key Systems",
//     "Practical Applications and Techniques",
//     "Advanced Topics and Future Trends",
//     "Case Studies and Real-World Examples",
//     "Implementation Strategies",
//     "Optimization and Best Practices",
//     "Troubleshooting and Common Issues",
//     "Future Directions and Innovations"
//   ];
  
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
//     `${c.title}\n${c.subtopics.map(s => `   - ${s}`).join('\n')}`
//   ).join('\n\n');
  
//   return { raw, parsed: chapters };
// }

// // ==================== AI INTERACTION ====================
// async function askAI(prompt, userId, bookTopic, options = {}) {
//   await userRateLimiter.wait(userId);

//   const maxRetries = 3;
//   for (let attempt = 0; attempt < maxRetries; attempt++) {
//     try {
//       const result = await ensureCerebras().chat.completions.create({
//         model: MODEL_NAME,
//         messages: [{ role: "user", content: prompt }],
//         max_tokens: options.genOptions?.maxOutputTokens || 4000,
//         temperature: options.genOptions?.temperature || 0.7,
//         stream: false
//       });
      
//       let reply = result.choices[0].message.content || '';
      
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
//   const prompt = `Create a Table of Contents for "${bookTopic}".
// Requirements:
// - EXACTLY 10 Chapters
// - Format: "Chapter X: Title"
// - 3-5 subtopics per chapter, indented with "- "
// - NO extra text, NO markdown`;
  
//   let attempts = 0;
//   while (attempts < 5) {
//     const genOptions = { maxOutputTokens: 1000, temperature: 0.3 };
//     try {
//       const rawTOC = await askAI(prompt, userId, bookTopic, { saveToHistory: true, genOptions });
//       const cleaned = cleanUpAIText(rawTOC);
//       const parsed = parseTOC(cleaned);

//       if (parsed.length === 10 && parsed.every(c => c.subtopics.length >= 3)) {
//         logger.info(`✅ TOC succeeded on attempt ${attempts + 1}`);
//         return { raw: cleaned, parsed };
//       }
//       logger.warn(`❌ TOC invalid – attempt ${attempts + 1}: Got ${parsed.length} chapters`);
//     } catch (e) {
//       logger.error(`❌ TOC AI error – attempt ${attempts + 1}: ${e.message}`);
//     }
//     attempts++;
//   }
//   return generateFallbackTOC(bookTopic);
// }

// async function generateChapter(bookTopic, chapterNumber, chapterInfo, prevContext, userId) {
//   const subtopicList = chapterInfo.subtopics.map(s => `- ${s}`).join('\n');

//   const prompt = `Write Chapter ${chapterNumber}: "${chapterInfo.title}" for a book about "${bookTopic}".

// [CONTEXT BRIDGE]
// Previous Chapter Summary: "${prevContext || 'This is the first chapter.'}"
// Use this to transition smoothly. Do NOT repeat the summary.

// CRITICAL FORMATTING RULES:
// - Start with EXACTLY ONE heading: "## ${chapterInfo.title}"
// - Use ### for ALL subsections
// - ALL tables MUST use strict GitHub Markdown table syntax
// - Use [!PRO-TIP], [!WARNING], or [!NOTE] callouts where relevant
// - Create Mermaid diagrams ONLY if they help explain concepts
// - 600+ words total

// MANDATORY STRUCTURE:
// ${subtopicList}

// [METADATA EXTRACTION]
// At the VERY END, append:

// ---METADATA---
// {
//   "summary": "One sentence for next chapter context",
//   "glossary": [{"term": "Keyword", "def": "Definition"}],
//   "quiz": [{"q": "Question?", "options": ["A)", "B)", "C)", "D)"], "correct": "A", "explanation": "Why"}]
// }
// ---METADATA---`;

//   const rawResponse = await askAI(prompt, userId, bookTopic, {
//     minLength: 1800,
//     genOptions: { maxOutputTokens: 5000, temperature: 0.5 }
//   });
  
//   const splitParts = rawResponse.split('---METADATA---');
//   let chapterBody = splitParts[0].trim();
//   let metadata = { summary: "", glossary: [], quiz: [] };

//   if (splitParts.length > 1) {
//     try {
//       const jsonMatch = splitParts[1].match(/\{[\s\S]*\}/);
//       if (jsonMatch) metadata = JSON.parse(jsonMatch[0]);
//       logger.info(`✅ Successfully parsed metadata for Ch ${chapterNumber}`);
//     } catch (e) {
//       logger.warn(`⚠️ Metadata parse failed Ch ${chapterNumber}: ${e.message}`);
//       metadata.summary = `Chapter ${chapterNumber} explored ${chapterInfo.title}.`;
//     }
//   } else {
//     logger.warn(`⚠️ No metadata block found for Ch ${chapterNumber}`);
//     metadata.summary = `Chapter ${chapterNumber} covered ${chapterInfo.title}.`;
//   }

//   return { content: cleanUpAIText(chapterBody), metadata };
// }

// async function generateConclusion(bookTopic, chapterInfos, userId) {
//   const titles = chapterInfos.map(c => c.title).join(', ');
//   const prompt = `Write a professional conclusion for a book about "${bookTopic}". Summarize: ${titles}. 350 words.`;
  
//   return cleanUpAIText(await askAI(prompt, userId, bookTopic, {
//     minLength: 1200,
//     genOptions: { maxOutputTokens: 2000, temperature: 0.4 }
//   }));
// }

// // ==================== PDF GENERATION ====================
// function buildEnhancedHTML(content, bookTitle, figures = [], glossary = null, quizzes = null, chapterInfos = null) {
//   const safeGlossary = glossary || [];
//   const safeQuizzes = quizzes || [];
  
//   // FIX: Process math BEFORE diagrams to preserve LaTeX
//   const cleaned = cleanUpAIText(content);
//   const formattedContent = formatMath(cleaned);
//   const meshBg = generateMeshGradient();

//   // FIX: Generate TOC in HTML
//   const tocHTML = chapterInfos ? `
//     <div class="chapter-break"></div>
//     <h1>Table of Contents</h1>
//     <div class="toc-list">
//       ${chapterInfos.map((ch, i) => `
//         <div class="toc-chapter">
//           <strong>${i + 1}. ${ch.title}</strong>
//           <div class="toc-subtopics">
//             ${ch.subtopics.map(s => `<div class="toc-sub">• ${s}</div>`).join('')}
//           </div>
//         </div>
//       `).join('')}
//     </div>
//     <div class="chapter-break"></div>
//   ` : '';

//   const glossaryHTML = safeGlossary.length > 0 ? `
//     <div class="chapter-break"></div>
//     <h1>Technical Glossary</h1>
//     <dl class="glossary-list">
//       ${safeGlossary.sort((a,b) => a.term.localeCompare(b.term)).map(item => `
//         <dt>${item.term}</dt>
//         <dd>${item.def}</dd>
//       `).join('')}
//     </dl>
//   ` : '';

//   const answerKeyHTML = safeQuizzes.length > 0 ? `
//     <div class="chapter-break"></div>
//     <h1>Answer Key</h1>
//     ${safeQuizzes.map((ch, idx) => `
//       <h3>Chapter ${idx + 1}: ${ch.chapterTitle}</h3>
//       <div class="answer-block">
//         ${ch.questions.map((q, qIdx) => `
//           <div class="answer-item">
//             <strong>Q${qIdx + 1}: ${q.correct}</strong> - ${q.explanation}
//           </div>
//         `).join('')}
//       </div>
//     `).join('')}
//   ` : '';

//   const finalContent = formattedContent.replace(/__FIGURE__(\d+)__/g, (_, i) => {
//     const fig = figures[parseInt(i)];
//     if (!fig) return '';
//     return `<figure style="text-align: center; margin: 2em 0;">
//       <img src="${fig.base64}" alt="${fig.caption}" style="max-width: 85%; height: auto; border: 1px solid #e5e7eb; border-radius: 8px; box-shadow: 0 4px 6px rgba(0,0,0,0.05);">
//       <figcaption style="margin-top: 0.5em; font-style: italic; color: #6b7280; font-size: 0.9em;">Figure ${fig.figNum}: ${fig.caption}</figcaption>
//     </figure>`;
//   });

//   const titleMatch = cleaned.match(/^#\s+(.+)$/m);
//   let displayTitle = titleMatch ? titleMatch[1] : bookTitle;
//   displayTitle = displayTitle.replace(/^Chapter\s+\d+:\s*/i, '').trim();

//   return `<!DOCTYPE html>
// <html lang="en">
// <head>
//   <meta charset="utf-8">
//   <meta name="viewport" content="width=device-width, initial-scale=1.0">
//   <title>${displayTitle} - BookGen AI</title>
//   <link rel="preconnect" href="https://fonts.googleapis.com">
//   <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
//   <link href="https://fonts.googleapis.com/css2?family=Merriweather:wght@300;400;700&family=Inter:wght@400;600;700&display=swap" rel="stylesheet">
//   <script>
//     window.MathJax = {
//       tex: { inlineMath: [['$', '$'], ['\\\\(', '\\\\)']], displayMath: [['$$', '$$']] },
//       svg: { fontCache: 'global' }
//     };
//   </script>
//   <script type="text/javascript" id="MathJax-script" async src="https://cdn.jsdelivr.net/npm/mathjax@3/es5/tex-mml-chtml.js"></script>
//   <script src="https://cdn.jsdelivr.net/npm/prismjs@1.29.0/prism.min.js"></script>
//   <script src="https://cdn.jsdelivr.net/npm/prismjs@1.29.0/components/prism-javascript.min.js"></script>
//   <script src="https://cdn.jsdelivr.net/npm/prismjs@1.29.0/components/prism-python.min.js"></script>
//   <link href="https://cdn.jsdelivr.net/npm/prismjs@1.29.0/themes/prism-tomorrow.min.css" rel="stylesheet">
//   <style>
//     /* PDF MEMORY OPTIMIZATIONS */
//     * { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
//     img { image-rendering: auto; max-width: 100%; height: auto; }
    
//     /* TOC Styles */
//     .toc-list { margin: 2em 0; }
//     .toc-chapter { margin-bottom: 1.5em; }
//     .toc-subtopics { margin-left: 2em; margin-top: 0.5em; }
//     .toc-sub { font-size: 0.9em; color: #6b7280; margin-bottom: 0.3em; }
    
//     .glossary-list dt { font-weight: bold; font-family: 'Inter', sans-serif; margin-top: 1em; color: #2563eb; }
//     .glossary-list dd { margin-left: 0; margin-bottom: 0.5em; }
//     .answer-item { margin-bottom: 0.8em; padding-bottom: 0.8em; border-bottom: 1px dashed #eee; }
//     .callout { padding: 1.2em; margin: 1.5em 0; border-left: 5px solid; border-radius: 4px; font-family: 'Inter', sans-serif; font-size: 0.9em; page-break-inside: avoid; }
//     .callout strong { display: block; margin-bottom: 0.5em; text-transform: uppercase; letter-spacing: 0.05em; }
//     .callout-tip { background-color: #f0fdf4; border-color: #16a34a; color: #166534; }
//     .callout-warning { background-color: #fff7ed; border-color: #ea580c; color: #9a3412; }
//     .callout-note { background-color: #eff6ff; border-color: #2563eb; color: #1e40af; }
    
//     @page { margin: 90px 70px 80px 70px; size: A4; }
//     .cover-page { page: cover; }
//     @page cover { margin: 0; @top-center { content: none; } @bottom-center { content: none; } }
//     body { font-family: 'Merriweather', Georgia, serif; font-size: 14px; line-height: 1.8; color: #1f2937; background: white; margin: 0; padding: 0; text-align: justify; hyphens: auto; }
    
//     .cover-page {
//       display: flex; flex-direction: column; justify-content: center; align-items: center;
//       height: 100vh; page-break-after: always; text-align: center; color: white;
//       margin: -90px -70px -80px -70px; padding: 70px; ${meshBg}
//     }
//     .cover-title { font-family: 'Inter', sans-serif; font-size: 48px; font-weight: 700; margin-bottom: 0.3em; line-height: 1.2; text-shadow: 0 2px 10px rgba(0,0,0,0.1); color: white; border: none; }
//     .cover-subtitle { font-family: 'Inter', sans-serif; font-size: 24px; font-weight: 300; margin-bottom: 2em; opacity: 0.9; }
//     .cover-meta { position: absolute; bottom: 60px; font-size: 14px; font-weight: 300; opacity: 0.8; }
//     .cover-disclaimer { margin-top: 30px; font-size: 12px; color: #fecaca; font-style: italic; }
    
//     h1, h2, h3, h4 { font-family: 'Inter', sans-serif; font-weight: 600; color: #1f2937; margin-top: 2.5em; margin-bottom: 0.8em; position: relative; }
//     h1 { font-size: 28px; border-bottom: 3px solid #667eea; padding-bottom: 15px; margin-top: 0; page-break-before: always; }
//     h1::after { content: ""; display: block; width: 80px; height: 3px; background: #764ba2; margin-top: 15px; }
//     h2 { font-size: 22px; border-bottom: 2px solid #e5e7eb; padding-bottom: 8px; color: #4b5563; }
//     h3 { font-size: 18px; color: #6b7280; }
    
//     .chapter-content > h1 + p::first-letter {
//       float: left; font-size: 4em; line-height: 1; margin: 0.1em 0.1em 0 0;
//       font-weight: 700; color: #667eea; font-family: 'Inter', sans-serif;
//     }
    
//     code { background: #f3f4f6; padding: 3px 8px; border: 1px solid #e5e7eb; font-family: 'Fira Code', 'Courier New', monospace; font-size: 13px; border-radius: 4px; color: #1e40af; }
//     pre { background: #1f2937; padding: 20px; overflow-x: auto; border: 1px solid #4b5563; border-radius: 8px; line-height: 1.5; margin: 1.5em 0; white-space: pre-wrap; word-wrap: break-word; box-shadow: 0 4px 6px rgba(0,0,0,0.05); }
//     pre code { background: none; border: none; padding: 0; color: #e5e7eb; }
    
//     blockquote { border-left: 4px solid #667eea; margin: 2em 0; padding: 1em 1.5em; background: linear-gradient(to right, #f3f4f6 0%, #ffffff 100%); font-style: italic; border-radius: 0 8px 8px 0; position: relative; }
//     blockquote::before { content: "“"; position: absolute; top: -20px; left: 10px; font-size: 80px; color: #d1d5db; font-family: 'Inter', sans-serif; line-height: 1; }
    
//     .example { background: linear-gradient(to right, #eff6ff 0%, #ffffff 100%); border-left: 4px solid #3b82f6; padding: 20px; margin: 2em 0; border-radius: 0 8px 8px 0; font-style: italic; position: relative; }
//     .example::before { content: "💡 Example"; display: block; font-weight: 600; color: #1d4ed8; margin-bottom: 10px; font-style: normal; }
    
//     table { width: 100%; border-collapse: collapse; margin: 2em 0; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
//     th { background: #374151; color: white; padding: 12px; text-align: left; font-family: 'Inter', sans-serif; font-weight: 600; }
//     td { padding: 12px; border-bottom: 1px solid #e5e7eb; }
//     tr:nth-child(even) { background: #f9fafb; }
    
//     .MathJax_Display { margin: 2em 0 !important; padding: 1em 0; overflow-x: auto; }
//     .chapter-break { page-break-before: always; }
//     .disclaimer-footer { margin-top: 4em; padding-top: 2em; border-top: 2px solid #e5e7eb; font-size: 12px; color: #6b7280; font-style: italic; text-align: center; }
//   </style>
// </head>
// <body>
//   <div class="cover-page">
//     <div class="cover-content">
//       <h1 class="cover-title">${bookTitle}</h1>
//       <h2 class="cover-subtitle">A Professional Guide</h2>
//       <div class="cover-disclaimer">⚠️ Caution: AI-generated content may contain errors</div>
//     </div>
//     <div class="cover-meta">Generated by BookGen AI<br>${new Date().toLocaleDateString()}</div>
//   </div>
//   ${tocHTML}
//   <div class="chapter-content">${marked.parse(finalContent)}</div>
//   ${glossaryHTML}
//   ${answerKeyHTML}
//   <div class="disclaimer-footer">This book was generated by AI for educational purposes. Please verify all information independently.</div>
//   <script>document.addEventListener('DOMContentLoaded', () => { Prism.highlightAll(); });</script>
// </body>
// </html>`;
// }

// async function generatePDF(content, outputPath, bookTitle, chapterInfos) {
//   try {
//     logger.info('🎨 Rendering diagrams and math...');
//     // FIX: Process math BEFORE diagrams to preserve LaTeX
//     const mathProcessed = formatMath(content);
//     const { content: processedContent, figures } = await formatDiagrams(mathProcessed);
    
//     const enhancedHtml = buildEnhancedHTML(processedContent, bookTitle, figures, null, null, chapterInfos);
    
//     const form = new FormData();
//     const instructions = {
//       parts: [{ html: "index.html" }],
//       output: {
//         format: "pdf",
//         pdf: {
//           margin: { top: "90px", bottom: "80px", left: "70px", right: "70px" },
//           header: {
//             content: '<div style="font-size: 10px; text-align: center; width: 100%; color: #6b7280;">Generated by BookGen AI</div>',
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

// // ==================== MAIN GENERATOR ====================
// export async function generateBookMedd(rawTopic, userId) {
//   const bookTopic = rawTopic.replace(/^(generate|create|write)( me)? (a book )?(about )?/i, '').trim();
//   const safeUserId = `${userId}-${bookTopic.replace(/\s+/g, '_').toLowerCase().slice(0, 50)}`;
  
//   let state = CheckpointManager.load(safeUserId) || {
//     bookTopic,
//     chapterInfos: [],
//     completedChapters: 0,
//     generatedFiles: [],
//     glossaryAccumulator: [],
//     quizAccumulator: [],
//     lastContext: null,
//     tocGenerated: false
//   };

//   logger.info(`=== Starting: "${bookTopic}" for ${safeUserId} ===`);

//   try {
//     if (!state.tocGenerated) {
//       userHistories.delete(safeUserId);
//       const { parsed } = await generateTOC(bookTopic, safeUserId);
//       state.chapterInfos = parsed;
//       state.tocGenerated = true;
//       CheckpointManager.save(safeUserId, state);
//     }

//     for (let i = state.completedChapters; i < state.chapterInfos.length; i++) {
//       const info = state.chapterInfos[i];
//       const chNum = i + 1;
//       logger.info(` ${chNum}. ${info.title}`);
      
//       const { content, metadata } = await generateChapter(
//         bookTopic, chNum, info, state.lastContext, safeUserId
//       );
      
//       const txt = `\n<div class="chapter-break"></div>\n\n# Chapter ${chNum}: ${info.title}\n\n${content}\n\n---\n`;
//       const f = path.join(OUTPUT_DIR, `${CHAPTER_PREFIX}-${safeUserId}-${chNum}.txt`);
//       saveToFile(f, txt);
//       state.generatedFiles.push(f);

//       state.completedChapters++;
//       state.lastContext = metadata.summary;
//       if (metadata.glossary) state.glossaryAccumulator.push(...metadata.glossary);
//       if (metadata.quiz?.length) {
//         state.quizAccumulator.push({ chapterTitle: info.title, questions: metadata.quiz });
//       }
      
//       CheckpointManager.save(safeUserId, state);
//     }

//     const conclusion = await generateConclusion(bookTopic, state.chapterInfos, safeUserId);
//     const conclFile = path.join(OUTPUT_DIR, `${CHAPTER_PREFIX}-${safeUserId}-conclusion.txt`);
//     saveToFile(conclFile, `\n<div class="chapter-break"></div>\n\n# Conclusion\n\n${conclusion}\n`);
//     state.generatedFiles.push(conclFile);

//     logger.info('Combining content and generating PDF...');
    
//     // FIX: Combine files sequentially to reduce memory
//     let combined = '';
//     for (const file of state.generatedFiles) {
//       combined += fs.readFileSync(file, 'utf8') + '\n';
//     }
    
//     if (state.glossaryAccumulator.length > 0) {
//       combined += `\n<div class="chapter-break"></div>\n\n# Technical Glossary\n\n${state.glossaryAccumulator
//         .sort((a,b) => a.term.localeCompare(b.term))
//         .map(item => `**${item.term}**: ${item.def}`).join('\n\n')}\n`;
//     }
    
//     if (state.quizAccumulator.length > 0) {
//       combined += `\n<div class="chapter-break"></div>\n\n# Answer Key\n\n${state.quizAccumulator
//         .map((ch, idx) => `## Chapter ${idx + 1}: ${ch.chapterTitle}\n\n${ch.questions
//           .map((q, qIdx) => `**Q${qIdx + 1}**: ${q.correct} - ${q.explanation}`).join('\n\n')}`).join('\n\n')}\n`;
//     }

//     const safeName = bookTopic.slice(0, 30).replace(/\s+/g, '_');
//     const pdfPath = path.join(OUTPUT_DIR, `book_${safeUserId}_${safeName}.pdf`);
//     await generatePDF(combined, pdfPath, bookTopic, state.chapterInfos);

//     state.generatedFiles.forEach(deleteFile);
//     userHistories.delete(safeUserId);
//     CheckpointManager.clear(safeUserId);
    
//     logger.info(`=== SUCCESS: ${pdfPath} ===`);
//     return pdfPath;
//   } catch (e) {
//     logger.error(`❌ Failed: ${e.message}`);
//     throw e;
//   }
// }

// // FIX: Reduced concurrency to 1 for memory optimization
// const bookQueue = async.queue(async (task, callback) => {
//   try {
//     const result = await generateBookMedd(task.bookTopic, task.userId);
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
// const MODEL_NAME = 'gemini-2.5-flash-lite';
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
//   let clean = text
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

//   clean = clean.replace(/\\(\$)/g, '$');
//   return clean;
// }

// // ==================== DIAGRAM LOGIC ====================
// function repairMermaidSyntax(code) {
//   let fixed = code
//     .replace(/^mermaid\s*\n/i, '')
//     .replace(/\[([^\]]*?\(.*?\)[^\]]*?)\]/g, (match, content) => {
//       if (content.startsWith('"') && content.endsWith('"')) return match;
//       return `["${content.replace(/"/g, "'")}"]`;
//     })
//     .replace(/-->;\s*$/gm, '-->')
//     .replace(/-->;\s*\n?\s*([A-Z])/g, '--> $1')
//     .replace(/\n{2,}/g, '\n')
//     .replace(/-->\s*$/gm, '--> EndNode[End]');
//   return fixed.trim();
// }

// async function formatDiagrams(content) {
//   const figures = [];
//   const diagramCounts = {};
//   const diagramRegex = /```mermaid\n([\s\S]*?)```\s*(?:\n\s*\*Figure caption:\s*(.+?)(?=\n\n|\n#|\n$))?/gs;

//   const chapterMatches = [...content.matchAll(/# Chapter (\d+):/g)];
//   const chapterPositions = chapterMatches.map(m => ({ num: parseInt(m[1]), pos: m.index }));
//   const matches = [...content.matchAll(diagramRegex)];

//   if (matches.length > 0) {
//     logger.info(`🔍 Found ${matches.length} mermaid code blocks. Rendering...`);
//   }

//   for (let match of matches) {
//     const fullMatch = match[0];
//     const rawCode = match[1].trim();
//     const caption = match[2] ? match[2].trim() : 'Illustration of the concept';
//     const code = repairMermaidSyntax(rawCode);

//     let currentChapter = 0;
//     for (let i = chapterPositions.length - 1; i >= 0; i--) {
//       if (chapterPositions[i].pos < match.index) {
//         currentChapter = chapterPositions[i].num;
//         break;
//       }
//     }
//     if (currentChapter === 0) {
//       currentChapter = chapterPositions.length > 0 ? chapterPositions[chapterPositions.length - 1].num : 1;
//     }

//     if (!diagramCounts[currentChapter]) diagramCounts[currentChapter] = 0;
//     diagramCounts[currentChapter]++;
//     const figNum = `${currentChapter}.${diagramCounts[currentChapter]}`;

//     try {
//       const response = await fetch('https://kroki.io/mermaid/svg', {
//         method: 'POST',
//         headers: {
//           'Content-Type': 'text/plain',
//           'Accept': 'image/svg+xml'
//         },
//         body: code
//       });

//       if (!response.ok) {
//         if (response.status === 400) {
//           logger.warn(`Invalid Mermaid Syntax Detected:\n${code}`);
//         }
//         throw new Error(`Kroki error: ${response.status}`);
//       }

//       const svg = await response.text();
//       const base64 = `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;

//       figures.push({ base64, figNum, caption });
//       content = content.replace(fullMatch, `__FIGURE__${figures.length - 1}__`);
//       logger.info(`✅ Diagram rendered successfully with caption: "${caption}"`);

//     } catch (error) {
//       logger.error(`❌ Failed to render diagram: ${error.message}`);
//       content = content.replace(fullMatch, '');
//     }
//   }

//   return { content, figures };
// }

// function formatMath(content) {
//   const tables = [];
//   const codeBlocks = [];

//   content = content.replace(/(\|.+\|[\s]*\n\|[-:\s|]+\|[\s]*\n(?:\|.*\|[\s]*\n?)*)/g, (tbl) => {
//     tables.push(tbl);
//     return `__TABLE__${tables.length - 1}__`;
//   });

//   content = content.replace(/```[\w]*\n([\s\S]*?)```/g, (match, code) => {
//     codeBlocks.push(match);
//     return `__CODE__${codeBlocks.length - 1}__`;
//   });

//   content = content.replace(/`([^`]+)`/g, (match) => {
//     codeBlocks.push(match);
//     return `__CODE__${codeBlocks.length - 1}__`;
//   });

//   content = content.replace(/^\\\[(.+)\\\]$/gm, '$$$1$$');
//   content = content.replace(/\\wedge/g, '^');
//   content = content.replace(/\{\\\^\}/g, '^');

//   content = content.replace(/__TABLE__(\d+)__/g, (_, i) => tables[i]);
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
  
//   return valid.slice(0, 10);
// }

// function generateFallbackTOC(bookTopic) {
//   const cleanTopic = bookTopic.replace(/\bin\s+.*$/i, '').trim();
  
//   const base = [
//     "Introduction to Core Concepts",
//     "Essential Principles and Practices", 
//     "Understanding Key Systems",
//     "Practical Applications and Techniques",
//     "Advanced Topics and Future Trends",
//     "Case Studies and Real-World Examples",
//     "Implementation Strategies",
//     "Optimization and Best Practices",
//     "Troubleshooting and Common Issues",
//     "Future Directions and Innovations"
//   ];
  
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
//   const prompt = `Create a detailed table of contents for a book about "${bookTopic}".
// REQUIREMENTS (FOLLOW EXACTLY):
// - Output EXACTLY 10 chapters
// - Use the format: "Chapter X: Title" on its own line
// - Follow each chapter title with 3-5 subtopics, each on its own line, indented with 3 spaces and a dash: "   - Subtopic"
// - NO extra text, NO explanations, NO markdown
// - Make titles descriptive and unique`;

//   let attempts = 0;
//   while (attempts < 5) {
//     const genOptions = { maxOutputTokens: 1000, temperature: 0.3, topP: 0.8 };
//     try {
//       const rawTOC = await askAI(prompt, userId, bookTopic, { saveToHistory: true, genOptions });
      
//       const cleaned = cleanUpAIText(rawTOC);
//       const parsed = parseTOC(cleaned);

//       if (parsed.length === 10 && parsed.every(c => c.subtopics.length >= 3)) {
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
//   const subtopicList = chapterInfo.subtopics.map(s => `- ${s}`).join('\n');

//   // 🔥 FIXED: Stricter prompt like 5-chapter version - removes "include Math if relevant"
//   const prompt = `Write Chapter ${chapterNumber}: "${chapterInfo.title}" for a book about "${bookTopic}".
// CRITICAL FORMATTING RULES:
// - Start with EXACTLY ONE heading: "## ${chapterInfo.title}"
// - Do NOT repeat the title as a second heading
// - Use ### for ALL subsections
// - ALL tables MUST use strict GitHub Markdown table syntax
// - NO HTML tags like <header> or <footer>
// - 600+ words total

// **DIAGRAMS (Optional):**
// - Create Mermaid diagrams ONLY if they help explain complex concepts
// - If used: Wrap in \`\`\`mermaid \`\`\` blocks
// - Quote node labels with parentheses: A["User (Admin)"]
// - Immediately after each diagram block, add EXACTLY one line: *Figure caption: Brief description of the diagram*

// MANDATORY STRUCTURE:
// 1) Introduction: Overview.
// 2) SECTIONS: Create a subsection (###) for EACH subtopic:
// ${subtopicList}
// 3) Practical Application: Real-world example.
// 4) Further Reading: 2-3 references.

// Output ONLY the chapter content.`;

//   return cleanUpAIText(await askAI(prompt, userId, bookTopic, {
//     minLength: 1800,
//     genOptions: { maxOutputTokens: 3500, temperature: 0.4 }
//   }));
// }

// async function generateConclusion(bookTopic, chapterInfos, userId) {
//   const titles = chapterInfos.map(c => c.title).join(', ');
//   const prompt = `Write a professional conclusion for a book about "${bookTopic}". Summarize: ${titles}. 350 words.`;
  
//   return cleanUpAIText(await askAI(prompt, userId, bookTopic, {
//     minLength: 1200,
//     genOptions: { maxOutputTokens: 2000, temperature: 0.4 }
//   }));
// }

// // ==================== PDF GENERATION ====================
// function buildEnhancedHTML(content, bookTitle, figures = []) {
//   const cleaned = cleanUpAIText(content);
//   const formattedContent = formatMath(cleaned);
  
//   // Restore figures with captions
//   const finalContent = formattedContent.replace(/__FIGURE__(\d+)__/g, (_, i) => {
//     const fig = figures[parseInt(i)];
//     if (!fig) return '';
//     return `<figure style="text-align: center; margin: 2em 0;">
//       <img src="${fig.base64}" alt="${fig.caption}" style="max-width: 85%; height: auto; border: 1px solid #e5e7eb; border-radius: 8px; box-shadow: 0 4px 6px rgba(0,0,0,0.05);">
//       <figcaption style="margin-top: 0.5em; font-style: italic; color: #6b7280; font-size: 0.9em;">Figure ${fig.figNum}: ${fig.caption}</figcaption>
//     </figure>`;
//   });

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
//   <link rel="preconnect" href="https://fonts.googleapis.com">
//   <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
//   <link href="https://fonts.googleapis.com/css2?family=Merriweather:wght@300;400;700&family=Inter:wght@400;600;700&display=swap" rel="stylesheet">
//   <script>
//     window.MathJax = {
//       tex: { inlineMath: [['$', '$'], ['\\\\(', '\\\\)']], displayMath: [['$$', '$$']] },
//       svg: { fontCache: 'global' }
//     };
//   </script>
//   <script type="text/javascript" id="MathJax-script" async src="https://cdn.jsdelivr.net/npm/mathjax@3/es5/tex-mml-chtml.js"></script>
//   <script src="https://cdn.jsdelivr.net/npm/prismjs@1.29.0/prism.min.js"></script>
//   <script src="https://cdn.jsdelivr.net/npm/prismjs@1.29.0/components/prism-javascript.min.js"></script>
//   <script src="https://cdn.jsdelivr.net/npm/prismjs@1.29.0/components/prism-python.min.js"></script>
//   <link href="https://cdn.jsdelivr.net/npm/prismjs@1.29.0/themes/prism-tomorrow.min.css" rel="stylesheet">
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
//     pre { background: #1f2937; padding: 20px; overflow-x: auto; border: 1px solid #4b5563; border-radius: 8px; line-height: 1.5; margin: 1.5em 0; white-space: pre-wrap; word-wrap: break-word; box-shadow: 0 4px 6px rgba(0,0,0,0.05); }
//     pre code { background: none; border: none; padding: 0; color: #e5e7eb; }
//     blockquote { border-left: 4px solid #667eea; margin: 2em 0; padding: 1em 1.5em; background: linear-gradient(to right, #f3f4f6 0%, #ffffff 100%); font-style: italic; border-radius: 0 8px 8px 0; position: relative; }
//     blockquote::before { content: "“"; position: absolute; top: -20px; left: 10px; font-size: 80px; color: #d1d5db; font-family: 'Inter', sans-serif; line-height: 1; }
//     .example { background: linear-gradient(to right, #eff6ff 0%, #ffffff 100%); border-left: 4px solid #3b82f6; padding: 20px; margin: 2em 0; border-radius: 0 8px 8px 0; font-style: italic; position: relative; }
//     .example::before { content: "💡 Example"; display: block; font-weight: 600; color: #1d4ed8; margin-bottom: 10px; font-style: normal; }
//     table { width: 100%; border-collapse: collapse; margin: 2em 0; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
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
//     <div class="cover-meta">Generated by bookgen.ai<br>${new Date().toLocaleDateString()}</div>
//   </div>
//   <div class="chapter-content">${marked.parse(finalContent)}</div>
//   <div class="disclaimer-footer">This book was generated by AI for educational purposes. Please verify all information independently.</div>
//   <script>document.addEventListener('DOMContentLoaded', () => { Prism.highlightAll(); });</script>
// </body>
// </html>`;
// }

// async function generatePDF(content, outputPath, bookTitle) {
//   try {
//     logger.info('🎨 Rendering diagrams (if any)...');
//     const { content: processedContent, figures } = await formatDiagrams(content);
    
//     const enhancedHtml = buildEnhancedHTML(processedContent, bookTitle, figures);
    
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
// export async function generateBookMedd(rawTopic, userId) {
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
//     const result = await generateBookMedd(task.bookTopic, task.userId);
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




// import Cerebras from '@cerebras/cerebras_cloud_sdk';
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
//     this.limit = requestsPerMinute;
//     this.users = new Map();
//   }

//   async wait(userId) {
//     const now = Date.now();
//     if (!this.users.has(userId)) this.users.set(userId, []);
    
//     const userRequests = this.users.get(userId);
//     const recent = userRequests.filter(t => now - t < 60000);
//     this.users.set(userId, recent);

//     while (recent.length >= this.limit) {
//       const oldest = recent[0];
//       const waitTime = 60000 - (now - oldest) + 1000;
//       await new Promise(resolve => setTimeout(resolve, waitTime));
//     }

//     recent.push(now);
//     this.users.set(userId, recent);
//   }
// }

// const userRateLimiter = new RateLimiter(15);
// const HISTORY_DIR = path.join(__dirname, 'history');
// const OUTPUT_DIR = path.join(__dirname, '../pdfs');
// const STATE_DIR = path.join(__dirname, 'states');
// const CHAPTER_PREFIX = 'chapter';
// const MODEL_NAME = 'gpt-oss-120b';
// const NUTRIENT_API_KEY = process.env.NUTRIENT_API_KEY;

// let cerebras = null;
// function ensureCerebras() {
//   if (cerebras) return cerebras;
//   const key = process.env.CEREBRAS_API_KEY || 'csk-8jrexx2mcp496w9ypyxtnffmjdn29dch46ydc2jh9jmh2yxy';
//   if (!key) throw new Error('CEREBRAS_API_KEY not set');
//   cerebras = new Cerebras({ apiKey: key });
//   return cerebras;
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
// fs.mkdirSync(STATE_DIR, { recursive: true });

// // ==================== [FEATURE] CHECKPOINT SYSTEM ====================
// class CheckpointManager {
//   static getPath(userId) {
//     return path.join(STATE_DIR, `state-${userId}.json`);
//   }

//   static load(userId) {
//     const file = this.getPath(userId);
//     if (fs.existsSync(file)) {
//       try {
//         const data = JSON.parse(fs.readFileSync(file, 'utf8'));
//         logger.info(`🔄 Resuming session for ${userId} at Chapter ${data.completedChapters + 1}`);
//         return data;
//       } catch (e) {
//         logger.error('Corrupt state file, starting fresh.');
//       }
//     }
//     return null;
//   }

//   static save(userId, data) {
//     fs.writeFileSync(this.getPath(userId), JSON.stringify(data, null, 2));
//   }

//   static clear(userId) {
//     const file = this.getPath(userId);
//     if (fs.existsSync(file)) fs.unlinkSync(file);
//   }
// }

// // ==================== [FEATURE] DYNAMIC MESH COVER ====================
// function generateMeshGradient() {
//   const h1 = Math.floor(Math.random() * 360);
//   const h2 = (h1 + 60) % 360;
//   const h3 = (h1 + 180) % 360;
//   return `background-color: hsl(${h1}, 60%, 50%);
//           background-image: 
//             radial-gradient(at 40% 20%, hsla(${h2}, 100%, 74%, 1) 0px, transparent 50%),
//             radial-gradient(at 80% 0%, hsla(${h3}, 100%, 56%, 1) 0px, transparent 50%),
//             radial-gradient(at 0% 50%, hsla(${h2}, 100%, 93%, 1) 0px, transparent 50%),
//             radial-gradient(at 80% 50%, hsla(${h3}, 100%, 76%, 1) 0px, transparent 50%),
//             radial-gradient(at 0% 100%, hsla(${h1}, 100%, 78%, 1) 0px, transparent 50%),
//             radial-gradient(at 80% 100%, hsla(${h2}, 100%, 56%, 1) 0px, transparent 50%),
//             radial-gradient(at 0% 0%, hsla(${h3}, 100%, 78%, 1) 0px, transparent 50%);`;
// }

// // ==================== TEXT PROCESSING ====================
// function cleanUpAIText(text) {
//   if (!text) return '';
//   let clean = text
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
//   clean = clean.replace(/\\(\$)/g, '$');
//   return clean;
// }

// function formatMath(content) {
//   const tables = [];
//   const codeBlocks = [];
  
//   content = content.replace(/(\|.+\|[\s]*\n\|[-:\s|]+\|[\s]*\n(?:\|.*\|[\s]*\n?)*)/g, (tbl) => {
//     tables.push(tbl);
//     return `__TABLE__${tables.length - 1}__`;
//   });
  
//   content = content.replace(/```[\w]*\n([\s\S]*?)```/g, (match) => {
//     codeBlocks.push(match);
//     return `__CODE__${codeBlocks.length - 1}__`;
//   });
  
//   content = content.replace(/`([^`]+)`/g, (match) => {
//     codeBlocks.push(match);
//     return `__CODE__${codeBlocks.length - 1}__`;
//   });
  
//   content = content.replace(/^\\\[(.+)\\\]$/gm, '$$$1$$');
//   content = content.replace(/\\wedge/g, '^');
//   content = content.replace(/\{\\\^\}/g, '^');
  
//   content = content.replace(/__TABLE__(\d+)__/g, (_, i) => tables[i]);
//   content = content.replace(/__CODE__(\d+)__/g, (_, i) => codeBlocks[i]);
  
//   return content;
// }

// // ==================== MARKED SETUP WITH CALLOUTS ====================
// marked.use({
//   renderer: {
//     blockquote(quote) {
//       const textSource = typeof quote === 'string' ? quote : (quote.text || '');
//       const rawText = textSource.replace(/<p>|<\/p>|\n/g, '').trim();
      
//       if (rawText.includes('[!PRO-TIP]') || rawText.includes('[!TIP]')) {
//         const content = textSource.replace(/\[!(PRO-)?TIP\]/i, '');
//         return `<div class="callout callout-tip"><strong>💡 Pro Tip</strong>${content}</div>`;
//       }
//       if (rawText.includes('[!WARNING]') || rawText.includes('[!CAUTION]')) {
//         const content = textSource.replace(/\[!(WARNING|CAUTION)\]/i, '');
//         return `<div class="callout callout-warning"><strong>⚠️ Caution</strong>${content}</div>`;
//       }
//       if (rawText.includes('[!NOTE]')) {
//         const content = textSource.replace(/\[!NOTE\]/i, '');
//         return `<div class="callout callout-note"><strong>ℹ️ Note</strong>${content}</div>`;
//       }
//       return `<blockquote class="standard-quote">${textSource}</blockquote>`;
//     }
//   },
//   highlight: function(code, lang) {
//     if (lang && hljs.getLanguage(lang)) {
//       return hljs.highlight(code, { language: lang }).value;
//     }
//     return code;
//   },
//   gfm: true,
//   breaks: true
// });

// // ==================== DIAGRAM LOGIC ====================
// function repairMermaidSyntax(code) {
//   return code
//     .replace(/^mermaid\s*\n/i, '')
//     .replace(/\[([^\]]*?\(.*?\)[^\]]*?)\]/g, (m, c) => code.startsWith('"') ? m : `["${c.replace(/"/g, "'")}"]`)
//     .replace(/-->;\s*$/gm, '-->')
//     .replace(/-->\s*$/gm, '--> EndNode[End]')
//     .trim();
// }

// async function formatDiagrams(content) {
//   const figures = [];
//   const diagramRegex = /```mermaid\n([\s\S]*?)```\s*(?:\n\s*\*Figure caption:\s*(.+?)(?=\n\n|\n#|\n$))?/gs;
//   let i = 0;
  
//   const matches = [...content.matchAll(diagramRegex)];
  
//   for (let match of matches) {
//     const fullMatch = match[0];
//     const code = repairMermaidSyntax(match[1]);
//     const caption = match[2] || 'Illustration';
//     const figNum = `Fig-${i++}`;

//     try {
//       const res = await fetch('https://kroki.io/mermaid/svg', {
//         method: 'POST',
//         body: code,
//         headers: { 'Content-Type': 'text/plain' }
//       });
//       if (res.ok) {
//         const svg = await res.text();
//         const base64 = `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
//         figures.push({ base64, caption, figNum });
//         content = content.replace(fullMatch, `__FIGURE__${figures.length - 1}__`);
//       } else {
//         content = content.replace(fullMatch, '');
//       }
//     } catch (e) {
//       content = content.replace(fullMatch, '');
//     }
//   }
//   return { content, figures };
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
//       if (nextLine && nextLine.length > 5 && !nextLine.match(/^[\s]*[-•*·\d]/)) {
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
//   logger.info(`✅ Parsed ${valid.length} valid chapters`);
//   return valid.slice(0, 10);
// }

// function generateFallbackTOC(bookTopic) {
//   const cleanTopic = bookTopic.replace(/\bin\s+.*$/i, '').trim();
//   const base = [
//     "Introduction to Core Concepts",
//     "Essential Principles and Practices", 
//     "Understanding Key Systems",
//     "Practical Applications and Techniques",
//     "Advanced Topics and Future Trends",
//     "Case Studies and Real-World Examples",
//     "Implementation Strategies",
//     "Optimization and Best Practices",
//     "Troubleshooting and Common Issues",
//     "Future Directions and Innovations"
//   ];
  
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
  
//   return { raw: '', parsed: chapters };
// }

// // ==================== AI INTERACTION ====================
// async function askAI(prompt, userId, bookTopic, options = {}) {
//   await userRateLimiter.wait(userId);

//   const maxRetries = 3;
//   for (let attempt = 0; attempt < maxRetries; attempt++) {
//     try {
//       const result = await ensureCerebras().chat.completions.create({
//         model: MODEL_NAME,
//         messages: [{ role: "user", content: prompt }],
//         max_tokens: options.genOptions?.maxOutputTokens || 4000,
//         temperature: options.genOptions?.temperature || 0.7,
//         stream: false
//       });
      
//       let reply = result.choices[0].message.content || '';
      
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
//   const prompt = `Create a Table of Contents for "${bookTopic}".
// Requirements:
// - EXACTLY 10 Chapters
// - Format: "Chapter X: Title"
// - 3-5 subtopics per chapter, indented with "- "
// - NO extra text, NO markdown`;
  
//   let attempts = 0;
//   while (attempts < 5) {
//     const genOptions = { maxOutputTokens: 1000, temperature: 0.3 };
//     try {
//       const rawTOC = await askAI(prompt, userId, bookTopic, { saveToHistory: true, genOptions });
//       const cleaned = cleanUpAIText(rawTOC);
//       const parsed = parseTOC(cleaned);

//       if (parsed.length === 10 && parsed.every(c => c.subtopics.length >= 3)) {
//         logger.info(`✅ TOC succeeded on attempt ${attempts + 1}`);
//         return { raw: cleaned, parsed };
//       }
//       logger.warn(`❌ TOC invalid – attempt ${attempts + 1}: Got ${parsed.length} chapters`);
//     } catch (e) {
//       logger.error(`❌ TOC AI error – attempt ${attempts + 1}: ${e.message}`);
//     }
//     attempts++;
//   }
//   return generateFallbackTOC(bookTopic);
// }

// async function generateChapter(bookTopic, chapterNumber, chapterInfo, prevContext, userId) {
//   const subtopicList = chapterInfo.subtopics.map(s => `- ${s}`).join('\n');

//   const prompt = `Write Chapter ${chapterNumber}: "${chapterInfo.title}" for a book about "${bookTopic}".

// [CONTEXT BRIDGE]
// Previous Chapter Summary: "${prevContext || 'This is the first chapter.'}"
// Use this to transition smoothly. Do NOT repeat the summary.

// CRITICAL FORMATTING RULES:
// - Start with EXACTLY ONE heading: "## ${chapterInfo.title}"
// - Use ### for ALL subsections
// - ALL tables MUST use strict GitHub Markdown table syntax
// - Use [!PRO-TIP], [!WARNING], or [!NOTE] callouts where relevant
// - Create Mermaid diagrams ONLY if they help explain concepts
// - 600+ words total

// MANDATORY STRUCTURE:
// ${subtopicList}

// [METADATA EXTRACTION]
// At the VERY END, append:

// ---METADATA---
// {
//   "summary": "One sentence for next chapter context",
//   "glossary": [{"term": "Keyword", "def": "Definition"}],
//   "quiz": [{"q": "Question?", "options": ["A)", "B)", "C)", "D)"], "correct": "A", "explanation": "Why"}]
// }
// ---METADATA---`;

//   const rawResponse = await askAI(prompt, userId, bookTopic, {
//     minLength: 1800,
//     genOptions: { maxOutputTokens: 5000, temperature: 0.5 }
//   });
  
//   const splitParts = rawResponse.split('---METADATA---');
//   let chapterBody = splitParts[0].trim();
//   let metadata = { summary: "", glossary: [], quiz: [] };

//   if (splitParts.length > 1) {
//     try {
//       const jsonMatch = splitParts[1].match(/\{[\s\S]*\}/);
//       if (jsonMatch) metadata = JSON.parse(jsonMatch[0]);
//       logger.info(`✅ Successfully parsed metadata for Ch ${chapterNumber}`);
//     } catch (e) {
//       logger.warn(`⚠️ Metadata parse failed Ch ${chapterNumber}: ${e.message}`);
//       metadata.summary = `Chapter ${chapterNumber} explored ${chapterInfo.title}.`;
//     }
//   } else {
//     logger.warn(`⚠️ No metadata block found for Ch ${chapterNumber}`);
//     metadata.summary = `Chapter ${chapterNumber} covered ${chapterInfo.title}.`;
//   }

//   return { content: cleanUpAIText(chapterBody), metadata };
// }

// async function generateConclusion(bookTopic, chapterInfos, userId) {
//   const titles = chapterInfos.map(c => c.title).join(', ');
//   const prompt = `Write a professional conclusion for a book about "${bookTopic}". Summarize: ${titles}. 350 words.`;
  
//   return cleanUpAIText(await askAI(prompt, userId, bookTopic, {
//     minLength: 1200,
//     genOptions: { maxOutputTokens: 2000, temperature: 0.4 }
//   }));
// }

// // ==================== PDF GENERATION ====================
// function buildEnhancedHTML(content, bookTitle, figures = [], glossary = null, quizzes = null) {
//   // Add null safety - fix for the crash
//   const safeGlossary = glossary || [];
//   const safeQuizzes = quizzes || [];
  
//   const cleaned = cleanUpAIText(content);
//   const formattedContent = formatMath(cleaned);
//   const meshBg = generateMeshGradient();

//   const glossaryHTML = safeGlossary.length > 0 ? `
//     <div class="chapter-break"></div>
//     <h1>Technical Glossary</h1>
//     <dl class="glossary-list">
//       ${safeGlossary.sort((a,b) => a.term.localeCompare(b.term)).map(item => `
//         <dt>${item.term}</dt>
//         <dd>${item.def}</dd>
//       `).join('')}
//     </dl>
//   ` : '';

//   const answerKeyHTML = safeQuizzes.length > 0 ? `
//     <div class="chapter-break"></div>
//     <h1>Answer Key</h1>
//     ${safeQuizzes.map((ch, idx) => `
//       <h3>Chapter ${idx + 1}: ${ch.chapterTitle}</h3>
//       <div class="answer-block">
//         ${ch.questions.map((q, qIdx) => `
//           <div class="answer-item">
//             <strong>Q${qIdx + 1}: ${q.correct}</strong> - ${q.explanation}
//           </div>
//         `).join('')}
//       </div>
//     `).join('')}
//   ` : '';

//   const finalContent = formattedContent.replace(/__FIGURE__(\d+)__/g, (_, i) => {
//     const fig = figures[parseInt(i)];
//     if (!fig) return '';
//     return `<figure style="text-align: center; margin: 2em 0;">
//       <img src="${fig.base64}" alt="${fig.caption}" style="max-width: 85%; height: auto; border: 1px solid #e5e7eb; border-radius: 8px; box-shadow: 0 4px 6px rgba(0,0,0,0.05);">
//       <figcaption style="margin-top: 0.5em; font-style: italic; color: #6b7280; font-size: 0.9em;">Figure ${fig.figNum}: ${fig.caption}</figcaption>
//     </figure>`;
//   });

//   const titleMatch = cleaned.match(/^#\s+(.+)$/m);
//   let displayTitle = titleMatch ? titleMatch[1] : bookTitle;
//   displayTitle = displayTitle.replace(/^Chapter\s+\d+:\s*/i, '').trim();

//   return `<!DOCTYPE html>
// <html lang="en">
// <head>
//   <meta charset="utf-8">
//   <meta name="viewport" content="width=device-width, initial-scale=1.0">
//   <title>${displayTitle} - BookGen AI</title>
//   <link rel="preconnect" href="https://fonts.googleapis.com">
//   <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
//   <link href="https://fonts.googleapis.com/css2?family=Merriweather:wght@300;400;700&family=Inter:wght@400;600;700&display=swap" rel="stylesheet">
//   <script>
//     window.MathJax = {
//       tex: { inlineMath: [['$', '$'], ['\\\\(', '\\\\)']], displayMath: [['$$', '$$']] },
//       svg: { fontCache: 'global' }
//     };
//   </script>
//   <script type="text/javascript" id="MathJax-script" async src="https://cdn.jsdelivr.net/npm/mathjax@3/es5/tex-mml-chtml.js"></script>
//   <script src="https://cdn.jsdelivr.net/npm/prismjs@1.29.0/prism.min.js"></script>
//   <script src="https://cdn.jsdelivr.net/npm/prismjs@1.29.0/components/prism-javascript.min.js"></script>
//   <script src="https://cdn.jsdelivr.net/npm/prismjs@1.29.0/components/prism-python.min.js"></script>
//   <link href="https://cdn.jsdelivr.net/npm/prismjs@1.29.0/themes/prism-tomorrow.min.css" rel="stylesheet">
//   <style>
//     .glossary-list dt { font-weight: bold; font-family: 'Inter', sans-serif; margin-top: 1em; color: #2563eb; }
//     .glossary-list dd { margin-left: 0; margin-bottom: 0.5em; }
//     .answer-item { margin-bottom: 0.8em; padding-bottom: 0.8em; border-bottom: 1px dashed #eee; }
//     .callout { padding: 1.2em; margin: 1.5em 0; border-left: 5px solid; border-radius: 4px; font-family: 'Inter', sans-serif; font-size: 0.9em; page-break-inside: avoid; }
//     .callout strong { display: block; margin-bottom: 0.5em; text-transform: uppercase; letter-spacing: 0.05em; }
//     .callout-tip { background-color: #f0fdf4; border-color: #16a34a; color: #166534; }
//     .callout-warning { background-color: #fff7ed; border-color: #ea580c; color: #9a3412; }
//     .callout-note { background-color: #eff6ff; border-color: #2563eb; color: #1e40af; }
    
//     @page { margin: 90px 70px 80px 70px; size: A4; }
//     .cover-page { page: cover; }
//     @page cover { margin: 0; @top-center { content: none; } @bottom-center { content: none; } }
//     body { font-family: 'Merriweather', Georgia, serif; font-size: 14px; line-height: 1.8; color: #1f2937; background: white; margin: 0; padding: 0; text-align: justify; hyphens: auto; }
    
//     .cover-page {
//       display: flex; flex-direction: column; justify-content: center; align-items: center;
//       height: 100vh; page-break-after: always; text-align: center; color: white;
//       margin: -90px -70px -80px -70px; padding: 70px; ${meshBg}
//     }
//     .cover-title { font-family: 'Inter', sans-serif; font-size: 48px; font-weight: 700; margin-bottom: 0.3em; line-height: 1.2; text-shadow: 0 2px 10px rgba(0,0,0,0.1); color: white; border: none; }
//     .cover-subtitle { font-family: 'Inter', sans-serif; font-size: 24px; font-weight: 300; margin-bottom: 2em; opacity: 0.9; }
//     .cover-meta { position: absolute; bottom: 60px; font-size: 14px; font-weight: 300; opacity: 0.8; }
//     .cover-disclaimer { margin-top: 30px; font-size: 12px; color: #fecaca; font-style: italic; }
    
//     h1, h2, h3, h4 { font-family: 'Inter', sans-serif; font-weight: 600; color: #1f2937; margin-top: 2.5em; margin-bottom: 0.8em; position: relative; }
//     h1 { font-size: 28px; border-bottom: 3px solid #667eea; padding-bottom: 15px; margin-top: 0; page-break-before: always; }
//     h1::after { content: ""; display: block; width: 80px; height: 3px; background: #764ba2; margin-top: 15px; }
//     h2 { font-size: 22px; border-bottom: 2px solid #e5e7eb; padding-bottom: 8px; color: #4b5563; }
//     h3 { font-size: 18px; color: #6b7280; }
    
//     .chapter-content > h1 + p::first-letter {
//       float: left; font-size: 4em; line-height: 1; margin: 0.1em 0.1em 0 0;
//       font-weight: 700; color: #667eea; font-family: 'Inter', sans-serif;
//     }
    
//     code { background: #f3f4f6; padding: 3px 8px; border: 1px solid #e5e7eb; font-family: 'Fira Code', 'Courier New', monospace; font-size: 13px; border-radius: 4px; color: #1e40af; }
//     pre { background: #1f2937; padding: 20px; overflow-x: auto; border: 1px solid #4b5563; border-radius: 8px; line-height: 1.5; margin: 1.5em 0; white-space: pre-wrap; word-wrap: break-word; box-shadow: 0 4px 6px rgba(0,0,0,0.05); }
//     pre code { background: none; border: none; padding: 0; color: #e5e7eb; }
    
//     blockquote { border-left: 4px solid #667eea; margin: 2em 0; padding: 1em 1.5em; background: linear-gradient(to right, #f3f4f6 0%, #ffffff 100%); font-style: italic; border-radius: 0 8px 8px 0; position: relative; }
//     blockquote::before { content: "“"; position: absolute; top: -20px; left: 10px; font-size: 80px; color: #d1d5db; font-family: 'Inter', sans-serif; line-height: 1; }
    
//     .example { background: linear-gradient(to right, #eff6ff 0%, #ffffff 100%); border-left: 4px solid #3b82f6; padding: 20px; margin: 2em 0; border-radius: 0 8px 8px 0; font-style: italic; position: relative; }
//     .example::before { content: "💡 Example"; display: block; font-weight: 600; color: #1d4ed8; margin-bottom: 10px; font-style: normal; }
    
//     table { width: 100%; border-collapse: collapse; margin: 2em 0; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
//     th { background: #374151; color: white; padding: 12px; text-align: left; font-family: 'Inter', sans-serif; font-weight: 600; }
//     td { padding: 12px; border-bottom: 1px solid #e5e7eb; }
//     tr:nth-child(even) { background: #f9fafb; }
    
//     .MathJax_Display { margin: 2em 0 !important; padding: 1em 0; overflow-x: auto; }
//     .chapter-break { page-break-before: always; }
//     .disclaimer-footer { margin-top: 4em; padding-top: 2em; border-top: 2px solid #e5e7eb; font-size: 12px; color: #6b7280; font-style: italic; text-align: center; }
    
//     figure img { max-width: 100%; height: auto; display: block; margin: 0 auto; }
//     figcaption { text-align: center; font-size: 0.85em; color: #666; margin-top: 0.5em; font-style: italic; }
//   </style>
// </head>
// <body>
//   <div class="cover-page">
//     <div class="cover-content">
//       <h1 class="cover-title">${displayTitle}</h1>
//       <h2 class="cover-subtitle">A Professional Guide</h2>
//       <div class="cover-disclaimer">⚠️ Caution: AI-generated content may contain errors</div>
//     </div>
//     <div class="cover-meta">Generated by BookGen AI<br>${new Date().toLocaleDateString()}</div>
//   </div>
//   <div class="chapter-content">${marked.parse(finalContent)}</div>
//   ${glossaryHTML}
//   ${answerKeyHTML}
//   <div class="disclaimer-footer">This book was generated by AI for educational purposes. Please verify all information independently.</div>
//   <script>document.addEventListener('DOMContentLoaded', () => { Prism.highlightAll(); });</script>
// </body>
// </html>`;
// }

// async function generatePDF(content, outputPath, bookTitle) {
//   try {
//     logger.info('🎨 Rendering diagrams and math...');
//     const { content: processedContent, figures } = await formatDiagrams(content);
    
//     const enhancedHtml = buildEnhancedHTML(processedContent, bookTitle, figures, null, null);
    
//     const form = new FormData();
//     const instructions = {
//       parts: [{ html: "index.html" }],
//       output: {
//         format: "pdf",
//         pdf: {
//           margin: { top: "90px", bottom: "80px", left: "70px", right: "70px" },
//           header: {
//             content: '<div style="font-size: 10px; text-align: center; width: 100%; color: #6b7280;">Generated by BookGen AI</div>',
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

// // ==================== MAIN GENERATOR ====================
// export async function generateBookMedd(rawTopic, userId) {
//   const bookTopic = rawTopic.replace(/^(generate|create|write)( me)? (a book )?(about )?/i, '').trim();
//   const safeUserId = `${userId}-${bookTopic.replace(/\s+/g, '_').toLowerCase().slice(0, 50)}`;
  
//   let state = CheckpointManager.load(safeUserId) || {
//     bookTopic,
//     chapterInfos: [],
//     completedChapters: 0,
//     generatedFiles: [],
//     glossaryAccumulator: [],
//     quizAccumulator: [],
//     lastContext: null,
//     tocGenerated: false
//   };

//   logger.info(`=== Starting: "${bookTopic}" for ${safeUserId} ===`);

//   try {
//     if (!state.tocGenerated) {
//       userHistories.delete(safeUserId);
//       const { parsed } = await generateTOC(bookTopic, safeUserId);
//       state.chapterInfos = parsed;
//       state.tocGenerated = true;
//       CheckpointManager.save(safeUserId, state);
//     }

//     for (let i = state.completedChapters; i < state.chapterInfos.length; i++) {
//       const info = state.chapterInfos[i];
//       const chNum = i + 1;
//       logger.info(` ${chNum}. ${info.title}`);
      
//       const { content, metadata } = await generateChapter(
//         bookTopic, chNum, info, state.lastContext, safeUserId
//       );
      
//       const txt = `\n<div class="chapter-break"></div>\n\n# Chapter ${chNum}: ${info.title}\n\n${content}\n\n---\n`;
//       const f = path.join(OUTPUT_DIR, `${CHAPTER_PREFIX}-${safeUserId}-${chNum}.txt`);
//       saveToFile(f, txt);
//       state.generatedFiles.push(f);

//       state.completedChapters++;
//       state.lastContext = metadata.summary;
//       if (metadata.glossary) state.glossaryAccumulator.push(...metadata.glossary);
//       if (metadata.quiz?.length) {
//         state.quizAccumulator.push({ chapterTitle: info.title, questions: metadata.quiz });
//       }
      
//       CheckpointManager.save(safeUserId, state);
//     }

//     const conclusion = await generateConclusion(bookTopic, state.chapterInfos, safeUserId);
//     const conclFile = path.join(OUTPUT_DIR, `${CHAPTER_PREFIX}-${safeUserId}-conclusion.txt`);
//     saveToFile(conclFile, `\n<div class="chapter-break"></div>\n\n# Conclusion\n\n${conclusion}\n`);
//     state.generatedFiles.push(conclFile);

//     logger.info('Combining content and generating PDF...');
//     let combined = state.generatedFiles.map(f => fs.readFileSync(f, 'utf8')).join('\n');
    
//     if (state.glossaryAccumulator.length > 0) {
//       combined += `\n<div class="chapter-break"></div>\n\n# Technical Glossary\n\n${state.glossaryAccumulator
//         .sort((a,b) => a.term.localeCompare(b.term))
//         .map(item => `**${item.term}**: ${item.def}`).join('\n\n')}\n`;
//     }
    
//     if (state.quizAccumulator.length > 0) {
//       combined += `\n<div class="chapter-break"></div>\n\n# Answer Key\n\n${state.quizAccumulator
//         .map((ch, idx) => `## Chapter ${idx + 1}: ${ch.chapterTitle}\n\n${ch.questions
//           .map((q, qIdx) => `**Q${qIdx + 1}**: ${q.correct} - ${q.explanation}`).join('\n\n')}`).join('\n\n')}\n`;
//     }

//     const safeName = bookTopic.slice(0, 30).replace(/\s+/g, '_');
//     const pdfPath = path.join(OUTPUT_DIR, `book_${safeUserId}_${safeName}.pdf`);
//     await generatePDF(combined, pdfPath, bookTopic);

//     state.generatedFiles.forEach(deleteFile);
//     userHistories.delete(safeUserId);
//     CheckpointManager.clear(safeUserId);
    
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
//     const result = await generateBookMedd(task.bookTopic, task.userId);
//     callback(null, result);
//   } catch (error) {
//     callback(error);
//   }
// }, 2);

// export function queueBookGeneration(bookTopic, userId) {
//   return new Promise((resolve, reject) => {
//     bookQueue.push({ bookTopic, userId }, (error, result) => {
//       if (error) reject(error);
//       else resolve(result);
//     });
//   });
// }































// // // AI/MB.js – FINAL FIXED VERSION: 5 Chapters, Subtopics Enforced + MATH FIXES + CLEAN URLS
// // import { GoogleGenerativeAI } from '@google/generative-ai';
// // import { marked } from 'marked';
// // import hljs from 'highlight.js';
// // import fs from 'fs';
// // import path from 'path';
// // import { fileURLToPath } from 'url';
// // import async from 'async';
// // import winston from 'winston';
// // import fetch from 'node-fetch';
// // import FormData from 'form-data';
// // import dotenv from 'dotenv';

// // dotenv.config();


// // const __filename = fileURLToPath(import.meta.url);
// // const __dirname = path.dirname(__filename);

// // // ==================== CORE SETUP ====================
// // class RateLimiter {
// //   constructor(requestsPerMinute) {
// //     this.requestsPerMinute = requestsPerMinute;
// //     this.requests = [];
// //   }
// //   async wait() {
// //     const now = Date.now();
// //     this.requests = this.requests.filter(t => now - t < 60000);
// //     while (this.requests.length >= this.requestsPerMinute) {
// //       const oldest = this.requests[0];
// //       const waitTime = 60000 - (now - oldest) + 1000;
// //       await new Promise(resolve => setTimeout(resolve, waitTime));
// //     }
// //     this.requests.push(Date.now());
// //   }
// // }

// // const globalRateLimiter = new RateLimiter(15);
// // const HISTORY_DIR = path.join(__dirname, 'history');
// // const OUTPUT_DIR = path.join(__dirname, '../pdfs');
// // const CHAPTER_PREFIX = 'chapter';
// // const MODEL_NAME = 'gemini-2.5-flash-lite'; // Updated model name if needed
// // const NUTRIENT_API_KEY = process.env.NUTRIENT_API_KEY;

// // let genAI = null;
// // function ensureGenAI() {
// //   if (genAI) return genAI;
// //   const key = process.env.GEMINI_API_KEY;
// //   if (!key) {
// //     throw new Error('GEMINI_API_KEY is not set in environment. Configure it in your deployment or .env file.');
// //   }
// //   genAI = new GoogleGenerativeAI(key);
// //   return genAI;
// // }
// // const userHistories = new Map();

// // const logger = winston.createLogger({
// //   level: 'info',
// //   format: winston.format.combine(winston.format.timestamp(), winston.format.json()),
// //   transports: [
// //     new winston.transports.File({ filename: 'bookgen.log' }),
// //     new winston.transports.Console({ format: winston.format.simple() })
// //   ]
// // });

// // fs.mkdirSync(HISTORY_DIR, { recursive: true });
// // fs.mkdirSync(OUTPUT_DIR, { recursive: true });

// // // ==================== TEXT PROCESSING ====================
// // function cleanUpAIText(text) {
// //   if (!text) return '';
// //   let clean = text
// //     .replace(/^(?:Hi|Hello|Hey|Sure|Here).*?(\n\n|$)/gis, '')
// //     .replace(/<\/?(header|footer|figure|figcaption)[^>]*>/gi, '')
// //     .replace(/^\s*Table of Contents\s*$/gim, '')
// //     .replace(/(\d+)([a-zA-Z]+)/g, '$1 $2')
// //     .replace(/\b([A-Z])\s+([a-z]{2,})\b/g, (match, p1, p2) => {
// //       if (match.includes('`') || match.includes('```')) return match;
// //       return p1 + p2;
// //     })
// //     .replace(/\\([[\]{}()])/g, '$1')
// //     .replace(/\n{3,}/g, '\n\n')
// //     .replace(/[\u2013\u2014]/g, '-')
// //     .replace(/\*\s*$/gm, '')
// //     .trim();

// //   // 🔥 MATH FIX: Remove backslashes before dollar signs (\$ -> $)
// //   clean = clean.replace(/\\(\$)/g, '$');
// //   return clean;
// // }

// // function formatMath(content) {
// //   const tables = [];
// //   const codeBlocks = [];

// //   // Protect tables
// //   content = content.replace(/(\|.+\|[\s]*\n\|[-:\s|]+\|[\s]*\n(?:\|.*\|[\s]*\n?)*)/g, (tbl) => {
// //     tables.push(tbl);
// //     return `__TABLE__${tables.length - 1}__`;
// //   });

// //   // Protect fenced code
// //   content = content.replace(/```[\w]*\n([\s\S]*?)```/g, (match, code) => {
// //     codeBlocks.push(match);
// //     return `__CODE__${codeBlocks.length - 1}__`;
// //   });

// //   // Protect inline code
// //   content = content.replace(/`([^`]+)`/g, (match) => {
// //     codeBlocks.push(match);
// //     return `__CODE__${codeBlocks.length - 1}__`;
// //   });

// //   // 🔥 MATH FIX: Simplify math logic
// //   content = content.replace(/^\\\[(.+)\\\]$/gm, '$$$1$$'); // Convert \[ \] to $$ $$
  
// //   // Clean up common AI artifacts
// //   content = content.replace(/\\wedge/g, '^'); 
// //   content = content.replace(/\{\\\^\}/g, '^');

// //   // Restore protected blocks
// //   content = content.replace(/__TABLE__(\d+)__/g, (_, i) => tables[i]);
// //   content = content.replace(/__CODE__(\d+)__/g, (_, i) => codeBlocks[i]);

// //   return content;
// // }

// // // ==================== MARKED SETUP ====================
// // marked.setOptions({
// //   headerIds: false,
// //   breaks: true,
// //   gfm: true,
// //   highlight: function(code, lang) {
// //     if (lang && hljs.getLanguage(lang)) {
// //       return hljs.highlight(code, { language: lang }).value;
// //     }
// //     return code;
// //   }
// // });

// // // ==================== HELPER FUNCTIONS ====================
// // function getHistoryFile(userId) {
// //   return path.join(HISTORY_DIR, `history-${userId}.json`);
// // }

// // function loadConversationHistory(userId) {
// //   try {
// //     return JSON.parse(fs.readFileSync(getHistoryFile(userId), 'utf8'));
// //   } catch {
// //     return [];
// //   }
// // }

// // function saveConversationHistory(userId, history) {
// //   fs.writeFileSync(getHistoryFile(userId), JSON.stringify(history, null, 2));
// // }

// // function saveToFile(filename, content) {
// //   fs.writeFileSync(filename, content);
// //   logger.info(`Saved: ${filename}`);
// // }

// // function deleteFile(filePath) {
// //   try {
// //     fs.unlinkSync(filePath);
// //   } catch {
// //     logger.warn(`Delete failed: ${filePath}`);
// //   }
// // }

// // // ==================== TOC PARSER ====================
// // function parseTOC(tocContent) {
// //   const lines = tocContent.split('\n').map(l => l.trimEnd()).filter(l => l.trim());
// //   const chapters = [];
// //   let current = null;

// //   for (let i = 0; i < lines.length; i++) {
// //     let line = lines[i];
    
// //     if (!line) continue;

// //     if (line.length === 1 && /^[A-Z]$/.test(line) && i + 1 < lines.length) {
// //       const nextLine = lines[i + 1];
// //       if (nextLine && nextLine.length > 5 && !nextLine.match(/^[\s]*[-•*·\d]/) && !nextLine.startsWith(' ')) {
// //         line = line + nextLine;
// //         i++;
// //       }
// //     }

// //     const chapterMatch = line.match(/^Chapter\s+\d+:\s*(.+)$/i);
// //     const simpleMatch = line.match(/^(?:\d+[\.\):]|\d+\s+|[-\*•])\s*(.+)$/i);
// //     const chapMatch = chapterMatch || simpleMatch;
    
// //     if (chapMatch && !line.startsWith('  -') && !line.match(/^[\s]*[-•*·]/)) {
// //       let title = chapMatch[1].trim();
// //       title = title.replace(/[:–—*]\s*$/, '').trim();
// //       title = title.replace(/^\d+\.\s*/, '');
      
// //       if (title && title.length > 10 && !/^(introduction|chapter|basics|overview|conclusion)$/i.test(title)) {
// //         if (current) chapters.push(current);
// //         current = { title, subtopics: [] };
// //       }
// //     } else if (current && line.match(/^[\s]*[-•*·]\s+(.+)$/)) {
// //       const sub = line.match(/^[\s]*[-•*·]\s+(.+)$/)[1].trim();
// //       if (sub && sub.length > 5 && !/^(subtopic|section|part)/i.test(sub)) {
// //         current.subtopics.push(sub);
// //       }
// //     }
// //   }
// //   if (current) chapters.push(current);

// //   const valid = chapters.filter(c => c.subtopics.length >= 3);
// //   logger.debug(`✅ Parsed ${valid.length} valid chapters out of ${chapters.length} total`);
  
// //   return valid.slice(0, 10); 
// // }

// // function generateFallbackTOC(bookTopic) {
// //   const cleanTopic = bookTopic.replace(/\bin\s+.*$/i, '').trim();
  
// //  const base = [
// //   "Introduction to Core Concepts",
// //   "Essential Principles and Practices", 
// //   "Understanding Key Systems",
// //   "Practical Applications and Techniques",
// //   "Advanced Topics and Future Trends",
// //   "Case Studies and Real-World Examples",
// //   "Implementation Strategies",
// //   "Optimization and Best Practices",
// //   "Troubleshooting and Common Issues",
// //   "Future Directions and Innovations"
// // ];
  
// //   const isTechName = cleanTopic.length > 2 && cleanTopic.length < 20 && !cleanTopic.includes(' ');
// //   const suffix = isTechName ? ` in ${cleanTopic}` : '';
  
// //   const chapters = base.map((t, i) => ({
// //     title: `${t}${suffix}`,
// //     subtopics: [
// //       "Understanding the core concept",
// //       "Practical applications",
// //       "Common challenges and how to address them"
// //     ]
// //   }));
  
// //   const raw = chapters.map(c =>
// //     `${c.title}\n${c.subtopics.map(s => `    - ${s}`).join('\n')}`
// //   ).join('\n');
  
// //   return { raw, parsed: chapters };
// // }

// // // ==================== AI INTERACTION ====================
// // async function askAI(prompt, userId, bookTopic, options = {}) {
// //   await globalRateLimiter.wait();

// //   const genCfg = options.genOptions || { maxOutputTokens: 4000, temperature: 0.7, topP: 0.9 };
// //   const model = ensureGenAI().getGenerativeModel({ model: MODEL_NAME, generationConfig: genCfg });

// //   const maxRetries = 3;
// //   for (let attempt = 0; attempt < maxRetries; attempt++) {
// //     try {
// //       const result = await model.generateContent(prompt);
      
// //       let reply = '';
// //       if (result.response && typeof result.response.text === 'function') {
// //         reply = await result.response.text();
// //       } else if (result.candidates?.[0]?.content?.parts?.[0]?.text) {
// //         reply = result.candidates[0].content.parts[0].text;
// //       } else if (result.output && Array.isArray(result.output)) {
// //         reply = result.output.map(o => (o?.content || o?.text || '')).join('\n');
// //       } else if (result.text) {
// //         reply = result.text;
// //       }
      
// //       reply = (reply || '').toString().trim();

// //       if (!reply || reply.length < 50) {
// //         logger.warn(`Empty reply on attempt ${attempt + 1}, retrying...`);
// //         if (attempt < maxRetries - 1) await new Promise(r => setTimeout(r, 2000 * (attempt + 1)));
// //         continue;
// //       }

// //       if (options.minLength && reply.length < options.minLength) {
// //         throw new Error(`Response too short: ${reply.length} < ${options.minLength}`);
// //       }

// //       if (options.saveToHistory) {
// //         const hist = userHistories.get(userId) || [];
// //         hist.push({ role: 'user', content: prompt });
// //         hist.push({ role: 'assistant', content: reply });
// //         userHistories.set(userId, hist);
// //         saveConversationHistory(userId, hist);
// //       }
// //       return reply;
// //     } catch (e) {
// //       logger.error(`AI call error (attempt ${attempt + 1}): ${e.message}`);
// //       if (attempt === maxRetries - 1) throw e;
// //       await new Promise(r => setTimeout(r, 3000 * (attempt + 1)));
// //     }
// //   }
// // }

// // // ==================== CONTENT GENERATION ====================
// // async function generateTOC(bookTopic, userId) {
// //   const prompt = `Create a detailed table of contents for a book about "${bookTopic}".
// // REQUIREMENTS (FOLLOW EXACTLY):
// // - Output EXACTLY 10 chapters
// // - Use the format: "Chapter X: Title" on its own line
// // - Follow each chapter title with 3-5 subtopics, each on its own line, indented with 3 spaces and a dash: "   - Subtopic"
// // - NO extra text, NO explanations, NO markdown
// // - Make titles descriptive and unique
// // - Example format:
// // Chapter 1: Getting Started
// //    - Core Concepts
// //    - Practical Steps
// //    - Common Mistakes
// // [... continues to Chapter 10]`;

// //   let attempts = 0;
// //   let lastRaw = '';

// //   while (attempts < 5) {
// //     const genOptions = { maxOutputTokens: 1000, temperature: 0.3, topP: 0.8 };
// //     try {
// //       const rawTOC = await askAI(prompt, userId, bookTopic, { saveToHistory: true, genOptions });
// //       lastRaw = rawTOC;
      
// //       logger.debug(`Raw TOC (attempt ${attempts + 1}):\n${rawTOC.substring(0, 500)}...`);
      
// //       const cleaned = cleanUpAIText(rawTOC);
// //       const parsed = parseTOC(cleaned);

// //       if (parsed.length === 10 && parsed.every(c => c.subtopics.length >= 3)) {
// //         logger.info(`✅ TOC succeeded on attempt ${attempts + 1}`);
// //         return { raw: cleaned, parsed };
// //       }
      
// //       logger.warn(`❌ TOC invalid – attempt ${attempts + 1}: Got ${parsed.length} chapters`);
// //     } catch (e) {
// //       logger.error(`❌ TOC AI error – attempt ${attempts + 1}: ${e.message}`);
// //     }
// //     attempts++;
// //   }

// //   logger.warn(`⚠️ TOC failed after 5 attempts – using fallback for "${bookTopic}"`);
// //   return generateFallbackTOC(bookTopic);
// // }

// // async function generateChapter(bookTopic, chapterNumber, chapterInfo, userId) {
// //   const subtopicList = chapterInfo.subtopics.map(s => `- ${s}`).join('\n');

// //   // 🔥 MATH FIX: Explicit Math Formatting Rules in Prompt
// //   const prompt = `Write Chapter ${chapterNumber}: "${chapterInfo.title}" for a book about "${bookTopic}".

// // CRITICAL FORMATTING RULES:
// // - Start with EXACTLY ONE heading: "## ${chapterInfo.title}"
// // - Do NOT repeat the title as a second heading
// // - Use ### for ALL subsections
// // - ALL tables MUST use strict GitHub Markdown table syntax
// // - NO trailing asterisks (*) on any lines
// // - NO HTML tags like <header> or <footer>
// // - 600+ words total

// // **MATH FORMATTING RULES (CRITICAL):**
// // - Use LaTeX for ALL mathematical expressions.
// // - Wrap **inline math** in single dollar signs, e.g., $E = mc^2$.
// // - Wrap **block math** (centered equations) in double dollar signs, e.g., $$x = \\frac{-b \\pm \\sqrt{b^2 - 4ac}}{2a}$$
// // - **DO NOT** escape the dollar signs (write $, not \\$).
// // - **DO NOT** escape LaTeX backslashes (write \\frac, not \\\\frac).
// // - Use standard LaTeX notation (e.g., x^2 for power, \\int for integral).

// // MANDATORY CONTENT STRUCTURE:
// // 1) Introduction: A brief overview of the chapter.
// // 2) KEY SECTIONS: You MUST create a specific subsection (### Heading) for EACH of the following subtopics:
// // ${subtopicList}

// // 3) Practical Application/Exercise: A real-world example (include Math if relevant).
// // 4) Further Reading: 2-3 references.

// // Output ONLY the chapter content.`;

// //   return cleanUpAIText(await askAI(prompt, userId, bookTopic, {
// //     minLength: 1800,
// //     genOptions: { maxOutputTokens: 3500, temperature: 0.4 }
// //   }));
// // }

// // async function generateConclusion(bookTopic, chapterInfos, userId) {
// //   const titles = chapterInfos.map(c => c.title).join(', ');
// //   const prompt = `Write a professional conclusion for a book about "${bookTopic}".
// // Summarize these key topics: ${titles}
// // Include 3-5 authoritative resources with descriptions.

// // Use natural language and focus on summarizing the core concepts.
// // 300-350 words, formal tone.

// // Output ONLY the conclusion content.`;

// //   return cleanUpAIText(await askAI(prompt, userId, bookTopic, {
// //     minLength: 1200,
// //     genOptions: { maxOutputTokens: 2000, temperature: 0.4 }
// //   }));
// // }

// // // ==================== PDF GENERATION ====================
// // function buildEnhancedHTML(content, bookTitle) {
// //   const cleaned = cleanUpAIText(content);
// //   const formattedContent = formatMath(cleaned);
  
// //   // Extract clean title for cover
// //   const titleMatch = cleaned.match(/^#\s+(.+)$/m);
// //   let displayTitle = titleMatch ? titleMatch[1] : bookTitle;
// //   displayTitle = displayTitle
// //     .replace(/^Chapter\s+\d+:\s*/i, '')
// //     .replace(/^\d+\.\s*/, '')
// //     .trim();

// //   // 🔥 MATH FIX: Updated MathJax config script + CLEAN URLS
// //   return `<!DOCTYPE html>
// // <html lang="en">
// // <head>
// //   <meta charset="utf-8">
// //   <meta name="viewport" content="width=device-width, initial-scale=1.0">
// //   <title>${displayTitle} - Bookgen.ai</title>
// //   <link rel="preconnect" href="https://fonts.googleapis.com ">
// //   <link rel="preconnect" href="https://fonts.gstatic.com " crossorigin>
// //   <link href="https://fonts.googleapis.com/css2?family=Merriweather:wght@300 ;400;700&family=Inter:wght@400;600;700&display=swap" rel="stylesheet">
// //   <script>
// //     window.MathJax = {
// //       tex: { inlineMath: [['$', '$'], ['\\\\(', '\\\\)']], displayMath: [['$$', '$$']] },
// //       svg: { fontCache: 'none', scale: 0.95 }
// //     };
// //   </script>
// //   <script type="text/javascript" id="MathJax-script" async src="https://cdn.jsdelivr.net/npm/mathjax@3/es5/tex-mml-chtml.js "></script>
// //   <script src="https://cdn.jsdelivr.net/npm/prismjs@1.29.0/prism.min.js "></script>
// //   <script src="https://cdn.jsdelivr.net/npm/prismjs@1.29.0/components/prism-javascript.min.js "></script>
// //   <script src="https://cdn.jsdelivr.net/npm/prismjs@1.29.0/components/prism-python.min.js "></script>
// //   <script src="https://cdn.jsdelivr.net/npm/prismjs@1.29.0/components/prism-java.min.js "></script>
// //   <script src="https://cdn.jsdelivr.net/npm/prismjs@1.29.0/components/prism-cpp.min.js "></script>
// //   <script src="https://cdn.jsdelivr.net/npm/prismjs@1.29.0/components/prism-scala.min.js "></script>
// //   <link href="https://cdn.jsdelivr.net/npm/prismjs@1.29.0/themes/prism-tomorrow.min.css " rel="stylesheet">
// //   <style>
// //     @page { margin: 90px 70px 80px 70px; size: A4; }
// //     .cover-page { page: cover; }
// //     @page cover { margin: 0; @top-center { content: none; } @bottom-center { content: none; } }
// //     body { font-family: 'Merriweather', Georgia, serif; font-size: 14px; line-height: 1.8; color: #1f2937; background: white; margin: 0; padding: 0; text-align: justify; hyphens: auto; }
// //     .cover-page { display: flex; flex-direction: column; justify-content: center; align-items: center; height: 100vh; page-break-after: always; text-align: center; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; margin: -90px -70px -80px -70px; padding: 70px; }
// //     .cover-title { font-family: 'Inter', sans-serif; font-size: 48px; font-weight: 700; margin-bottom: 0.3em; line-height: 1.2; text-shadow: 2px 2px 4px rgba(0,0,0,0.1); }
// //     .cover-subtitle { font-family: 'Inter', sans-serif; font-size: 24px; font-weight: 300; margin-bottom: 2em; opacity: 0.9; }
// //     .cover-meta { position: absolute; bottom: 60px; font-size: 14px; font-weight: 300; opacity: 0.8; }
// //     .cover-disclaimer { margin-top: 30px; font-size: 12px; color: #fecaca; font-style: italic; }
// //     h1, h2, h3, h4 { font-family: 'Inter', sans-serif; font-weight: 600; color: #1f2937; margin-top: 2.5em; margin-bottom: 0.8em; position: relative; }
// //     h1 { font-size: 28px; border-bottom: 3px solid #667eea; padding-bottom: 15px; margin-top: 0; page-break-before: always; }
// //     h1::after { content: ""; display: block; width: 80px; height: 3px; background: #764ba2; margin-top: 15px; }
// //     h2 { font-size: 22px; border-bottom: 2px solid #e5e7eb; padding-bottom: 8px; color: #4b5563; }
// //     h3 { font-size: 18px; color: #6b7280; }
// //     .chapter-content > h1 + p::first-letter { float: left; font-size: 4em; line-height: 1; margin: 0.1em 0.1em 0 0; font-weight: 700; color: #667eea; font-family: 'Inter', sans-serif; }
// //     code { background: #f3f4f6; padding: 3px 8px; border: 1px solid #e5e7eb; font-family: 'Fira Code', 'Courier New', monospace; font-size: 13px; border-radius: 4px; color: #1e40af; }
// //     pre { background: #1f2937; padding: 20px; overflow-x: auto; border: 1px solid #4b5563; border-radius: 8px; line-height: 1.5; margin: 1.5em 0; white-space: pre-wrap; word-wrap: break-word; box-shadow: 0 4px 6px rgba(0, 0, 0, 0.05); }
// //     pre code { background: none; border: none; padding: 0; color: #e5e7eb; }
// //     blockquote { border-left: 4px solid #667eea; margin: 2em 0; padding: 1em 1.5em; background: linear-gradient(to right, #f3f4f6 0%, #ffffff 100%); font-style: italic; border-radius: 0 8px 8px 0; position: relative; }
// //     blockquote::before { content: "“"; position: absolute; top: -20px; left: 10px; font-size: 80px; color: #d1d5db; font-family: 'Inter', sans-serif; line-height: 1; }
// //     .example { background: linear-gradient(to right, #eff6ff 0%, #ffffff 100%); border-left: 4px solid #3b82f6; padding: 20px; margin: 2em 0; border-radius: 0 8px 8px 0; font-style: italic; position: relative; }
// //     .example::before { content: "💡 Example"; display: block; font-weight: 600; color: #1d4ed8; margin-bottom: 10px; font-style: normal; }
// //     table { width: 100%; border-collapse: collapse; margin: 2em 0; box-shadow: 0 1px 3px rgba(0, 0, 0, 0.1); }
// //     th { background: #374151; color: white; padding: 12px; text-align: left; font-family: 'Inter', sans-serif; font-weight: 600; }
// //     td { padding: 12px; border-bottom: 1px solid #e5e7eb; }
// //     tr:nth-child(even) { background: #f9fafb; }
// //     .MathJax_Display { margin: 2em 0 !important; padding: 1em 0; overflow-x: auto; }
// //     .disclaimer-footer { margin-top: 4em; padding-top: 2em; border-top: 2px solid #e5e7eb; font-size: 12px; color: #6b7280; font-style: italic; text-align: center; }
// //   </style>
// // </head>
// // <body>
// //   <div class="cover-page">
// //     <div class="cover-content">
// //       <h1 class="cover-title">Bookgen.AI</h1>
// //       <h2 class="cover-subtitle">A Guide book</h2>
// //       <div class="cover-disclaimer">⚠️ Caution: AI-generated content may contain errors</div>
// //     </div>
// //     <div class="cover-meta">Generated by Bookgen.ai<br>${new Date().toLocaleDateString()}</div>
// //   </div>
// //   <div class="chapter-content">${marked.parse(formattedContent)}</div>
// //   <div class="disclaimer-footer">This book was generated by AI for educational purposes. Please verify all information independently.</div>
// //   <script>document.addEventListener('DOMContentLoaded', () => { Prism.highlightAll(); });</script>
// // </body>
// // </html>`;
// // }

// // async function generatePDF(content, outputPath, bookTitle) {
// //   try {
// //     const enhancedHtml = buildEnhancedHTML(content, bookTitle);
    
// //     const form = new FormData();
// //     const instructions = {
// //       parts: [{ html: "index.html" }],
// //       output: {
// //         format: "pdf",
// //         pdf: {
// //           margin: { top: "90px", bottom: "80px", left: "70px", right: "70px" },
// //           header: {
// //             content: '<div style="font-size: 10px; text-align: center; width: 100%; color: #6b7280;">Generated by bookgen.ai</div>',
// //             spacing: "5mm"
// //           },
// //           footer: {
// //             content: '<div style="font-size: 10px; text-align: center; width: 100%; color: #6b7280;">Page {pageNumber}</div>',
// //             spacing: "5mm"
// //           },
// //           waitDelay: 3000,
// //           printBackground: true,
// //           preferCSSPageSize: true
// //         }
// //       }
// //     };
    
// //     form.append('instructions', JSON.stringify(instructions));
// //     form.append('index.html', Buffer.from(enhancedHtml), {
// //       filename: 'index.html',
// //       contentType: 'text/html'
// //     });

// //     const response = await fetch('https://api.nutrient.io/build ', {
// //       method: 'POST',
// //       headers: { 'Authorization': `Bearer ${NUTRIENT_API_KEY}` },
// //       body: form
// //     });

// //     if (!response.ok) {
// //       const errorText = await response.text();
// //       throw new Error(`Nutrient API error: ${response.status} - ${errorText}`);
// //     }

// //     const pdfBuffer = await response.buffer();
// //     fs.writeFileSync(outputPath, pdfBuffer);
// //     logger.info(`✅ PDF generated: ${outputPath}`);
// //     return outputPath;
// //   } catch (error) {
// //     logger.error(`❌ PDF generation failed: ${error.message}`);
// //     throw error;
// //   }
// // }

// // // ==================== MAIN GENERATOR ====================
// // export async function generateBookMedd(rawTopic, userId) {
// //   const bookTopic = rawTopic.replace(/^(generate|create|write)( me)? (a book )?(about )?/i, '').trim();
// //   const safeUserId = `${userId}-${bookTopic.replace(/\s+/g, '_').toLowerCase().slice(0, 50)}`;
// //   logger.info(`=== Starting: "${bookTopic}" for ${safeUserId} ===`);

// //   try {
// //     userHistories.delete(safeUserId);
// //     const { raw: tocRaw, parsed: chapterInfos } = await generateTOC(bookTopic, safeUserId);
    
// //     // Format TOC for PDF
// //     const formattedTOC = chapterInfos.map((ch, i) => {
// //       const num = i + 1;
// //       return `${num}. ${ch.title}\n${ch.subtopics.map(s => `   - ${s}`).join('\n')}`;
// //     }).join('\n\n');
    
// //     const tocFile = path.join(OUTPUT_DIR, `${CHAPTER_PREFIX}-${safeUserId}-toc.txt`);
// //     saveToFile(tocFile, `# Table of Contents\n\n${formattedTOC}\n\n---\n`);
// //     const files = [tocFile];

// //     // Generate chapters
// //     logger.info('Step 2/3: Generating chapters...');
// //     for (let i = 0; i < chapterInfos.length; i++) {
// //       if (global.cancelFlags?.[safeUserId]) {
// //         delete global.cancelFlags[safeUserId];
// //         throw new Error('Generation cancelled');
// //       }

// //       const chNum = i + 1;
// //       const info = chapterInfos[i];
// //       logger.info(` ${chNum}. ${info.title}`);
      
// //       const chapter = await generateChapter(bookTopic, chNum, info, safeUserId);
// //       const txt = `\n<div class="chapter-break"></div>\n\n# Chapter ${chNum}: ${info.title}\n\n${chapter}\n\n---\n`;
      
// //       const f = path.join(OUTPUT_DIR, `${CHAPTER_PREFIX}-${safeUserId}-${chNum}.txt`);
// //       saveToFile(f, txt);
// //       files.push(f);
// //     }

// //     // Generate conclusion
// //     logger.info('Step 3/3: Generating conclusion...');
// //     const conclusion = await generateConclusion(bookTopic, chapterInfos, safeUserId);
// //     const conclFile = path.join(OUTPUT_DIR, `${CHAPTER_PREFIX}-${safeUserId}-conclusion.txt`);
// //     saveToFile(conclFile, `\n<div class="chapter-break"></div>\n\n# Conclusion\n\n${conclusion}\n`);
// //     files.push(conclFile);

// //     // Combine and generate PDF
// //     logger.info('Combining content and generating PDF...');
// //     const combined = files.map(f => fs.readFileSync(f, 'utf8')).join('\n');
// //     const safeName = bookTopic.slice(0, 30).replace(/\s+/g, '_');
// //     const pdfPath = path.join(OUTPUT_DIR, `book_${safeUserId}_${safeName}.pdf`);
    
// //     await generatePDF(combined, pdfPath, bookTopic);

// //     // Cleanup
// //     files.forEach(deleteFile);
// //     userHistories.delete(safeUserId);
    
// //     logger.info(`=== SUCCESS: ${pdfPath} ===`);
// //     return pdfPath;
// //   } catch (e) {
// //     logger.error(`❌ Failed: ${e.message}`);
// //     throw e;
// //   }
// // }

// // // ==================== QUEUE SYSTEM ====================
// // const bookQueue = async.queue(async (task, callback) => {
// //   try {
// //     const result = await generateBookMedd(task.bookTopic, task.userId);
// //     callback(null, result);
// //   } catch (error) {
// //     callback(error);
// //   }
// // }, 1);

// // export function queueBookGeneration(bookTopic, userId) {
// //   return new Promise((resolve, reject) => {
// //     bookQueue.push({ bookTopic, userId }, (error, result) => {
// //       if (error) reject(error);
// //       else resolve(result);
// //     });
// //   });
// // }






























// // // AI/MB.js – FINAL FIXED VERSION: 5 Chapters, Subtopics Enforced
// // import { GoogleGenerativeAI } from '@google/generative-ai';
// // import { marked } from 'marked';
// // import hljs from 'highlight.js';
// // import fs from 'fs';
// // import path from 'path';
// // import { fileURLToPath } from 'url';
// // import async from 'async';
// // import winston from 'winston';
// // import fetch from 'node-fetch';
// // import FormData from 'form-data';
// // import dotenv from 'dotenv';

// // dotenv.config();


// // const __filename = fileURLToPath(import.meta.url);
// // const __dirname = path.dirname(__filename);

// // // ==================== CORE SETUP ====================
// // class RateLimiter {
// //   constructor(requestsPerMinute) {
// //     this.requestsPerMinute = requestsPerMinute;
// //     this.requests = [];
// //   }
// //   async wait() {
// //     const now = Date.now();
// //     this.requests = this.requests.filter(t => now - t < 60000);
// //     while (this.requests.length >= this.requestsPerMinute) {
// //       const oldest = this.requests[0];
// //       const waitTime = 60000 - (now - oldest) + 1000;
// //       await new Promise(resolve => setTimeout(resolve, waitTime));
// //     }
// //     this.requests.push(Date.now());
// //   }
// // }

// // const globalRateLimiter = new RateLimiter(15);
// // const HISTORY_DIR = path.join(__dirname, 'history');
// // const OUTPUT_DIR = path.join(__dirname, '../pdfs');
// // const CHAPTER_PREFIX = 'chapter';
// // const MODEL_NAME = 'gemini-2.5-flash-lite'; // Updated model name if needed
// // const NUTRIENT_API_KEY = process.env.NUTRIENT_API_KEY;

// // let genAI = null;
// // function ensureGenAI() {
// //   if (genAI) return genAI;
// //   const key = process.env.GEMINI_API_KEY;
// //   if (!key) {
// //     throw new Error('GEMINI_API_KEY is not set in environment. Configure it in your deployment or .env file.');
// //   }
// //   genAI = new GoogleGenerativeAI(key);
// //   return genAI;
// // }
// // const userHistories = new Map();

// // const logger = winston.createLogger({
// //   level: 'info',
// //   format: winston.format.combine(winston.format.timestamp(), winston.format.json()),
// //   transports: [
// //     new winston.transports.File({ filename: 'bookgen.log' }),
// //     new winston.transports.Console({ format: winston.format.simple() })
// //   ]
// // });

// // fs.mkdirSync(HISTORY_DIR, { recursive: true });
// // fs.mkdirSync(OUTPUT_DIR, { recursive: true });

// // // ==================== TEXT PROCESSING ====================
// // function cleanUpAIText(text) {
// //   if (!text) return '';
// //   return text
// //     .replace(/^(?:Hi|Hello|Hey|Sure|Here).*?(\n\n|$)/gis, '')
// //     .replace(/<\/?(header|footer|figure|figcaption)[^>]*>/gi, '')
// //     .replace(/^\s*Table of Contents\s*$/gim, '')
// //     .replace(/(\d+)([a-zA-Z]+)/g, '$1 $2')
// //     .replace(/\b([A-Z])\s+([a-z]{2,})\b/g, (match, p1, p2) => {
// //       if (match.includes('`') || match.includes('```')) return match;
// //       return p1 + p2;
// //     })
// //     .replace(/\\([[\]{}()])/g, '$1')
// //     .replace(/\n{3,}/g, '\n\n')
// //     .replace(/[\u2013\u2014]/g, '-')
// //     .replace(/\*\s*$/gm, '')
// //     .trim();
// // }

// // function formatMath(content) {
// //   const tables = [];
// //   const codeBlocks = [];

// //   // Protect tables (GitHub-style)
// //   content = content.replace(/(\|.+\|[\s]*\n\|[-:\s|]+\|[\s]*\n(?:\|.*\|[\s]*\n?)*)/g, (tbl) => {
// //     tables.push(tbl);
// //     return `__TABLE__${tables.length - 1}__`;
// //   });

// //   // Protect fenced code
// //   content = content.replace(/```[\w]*\n([\s\S]*?)```/g, (match, code) => {
// //     codeBlocks.push(match);
// //     return `__CODE__${codeBlocks.length - 1}__`;
// //   });

// //   // Protect inline code
// //   content = content.replace(/`([^`]+)`/g, (match) => {
// //     codeBlocks.push(match);
// //     return `__CODE__${codeBlocks.length - 1}__`;
// //   });

// //   // ======== FIX MATH ========
// //   content = content.replace(/\b(\d+)\s*\/\s*(\d+)\b/g, '\\(\\\\frac{$1}{$2}\\\\)');
// //   content = content.replace(/\b([a-zA-Z0-9]+)\s*\^\s*([a-zA-Z0-9]+)\b/g, '\\($1^{$2}\\)');
// //   content = content.replace(/\b(\d+)e(\d+)\b/gi, '\\($1 \\times 10^{$2}\\)');

// //   // Restore tables
// //   content = content.replace(/__TABLE__(\d+)__/g, (_, i) => tables[i]);
// //   // Restore code blocks
// //   content = content.replace(/__CODE__(\d+)__/g, (_, i) => codeBlocks[i]);

// //   return content;
// // }

// // // ==================== MARKED SETUP ====================
// // marked.setOptions({
// //   headerIds: false,
// //   breaks: true,
// //   gfm: true,
// //   highlight: function(code, lang) {
// //     if (lang && hljs.getLanguage(lang)) {
// //       return hljs.highlight(code, { language: lang }).value;
// //     }
// //     return code;
// //   }
// // });

// // // ==================== HELPER FUNCTIONS ====================
// // function getHistoryFile(userId) {
// //   return path.join(HISTORY_DIR, `history-${userId}.json`);
// // }

// // function loadConversationHistory(userId) {
// //   try {
// //     return JSON.parse(fs.readFileSync(getHistoryFile(userId), 'utf8'));
// //   } catch {
// //     return [];
// //   }
// // }

// // function saveConversationHistory(userId, history) {
// //   fs.writeFileSync(getHistoryFile(userId), JSON.stringify(history, null, 2));
// // }

// // function saveToFile(filename, content) {
// //   fs.writeFileSync(filename, content);
// //   logger.info(`Saved: ${filename}`);
// // }

// // function deleteFile(filePath) {
// //   try {
// //     fs.unlinkSync(filePath);
// //   } catch {
// //     logger.warn(`Delete failed: ${filePath}`);
// //   }
// // }

// // // ==================== TOC PARSER ====================
// // function parseTOC(tocContent) {
// //   const lines = tocContent.split('\n').map(l => l.trimEnd()).filter(l => l.trim());
// //   const chapters = [];
// //   let current = null;

// //   for (let i = 0; i < lines.length; i++) {
// //     let line = lines[i];
    
// //     if (!line) continue;

// //     if (line.length === 1 && /^[A-Z]$/.test(line) && i + 1 < lines.length) {
// //       const nextLine = lines[i + 1];
// //       if (nextLine && nextLine.length > 5 && !nextLine.match(/^[\s]*[-•*·\d]/) && !nextLine.startsWith(' ')) {
// //         line = line + nextLine;
// //         i++;
// //       }
// //     }

// //     const chapterMatch = line.match(/^Chapter\s+\d+:\s*(.+)$/i);
// //     const simpleMatch = line.match(/^(?:\d+[\.\):]|\d+\s+|[-\*•])\s*(.+)$/i);
// //     const chapMatch = chapterMatch || simpleMatch;
    
// //     if (chapMatch && !line.startsWith('  -') && !line.match(/^[\s]*[-•*·]/)) {
// //       let title = chapMatch[1].trim();
// //       title = title.replace(/[:–—*]\s*$/, '').trim();
// //       title = title.replace(/^\d+\.\s*/, '');
      
// //       if (title && title.length > 10 && !/^(introduction|chapter|basics|overview|conclusion)$/i.test(title)) {
// //         if (current) chapters.push(current);
// //         current = { title, subtopics: [] };
// //       }
// //     } else if (current && line.match(/^[\s]*[-•*·]\s+(.+)$/)) {
// //       const sub = line.match(/^[\s]*[-•*·]\s+(.+)$/)[1].trim();
// //       if (sub && sub.length > 5 && !/^(subtopic|section|part)/i.test(sub)) {
// //         current.subtopics.push(sub);
// //       }
// //     }
// //   }
// //   if (current) chapters.push(current);

// //   const valid = chapters.filter(c => c.subtopics.length >= 3);
// //   logger.debug(`✅ Parsed ${valid.length} valid chapters out of ${chapters.length} total`);
  
// //   // <--- CHANGED: Changed from 10 to 5 to force limit
// //   return valid.slice(0, 10); 
// // }

// // function generateFallbackTOC(bookTopic) {
// //   const cleanTopic = bookTopic.replace(/\bin\s+.*$/i, '').trim();
  
// //   // <--- CHANGED: Reduced fallback to 5 chapters
// //  const base = [
// //   "Introduction to Core Concepts",
// //   "Essential Principles and Practices", 
// //   "Understanding Key Systems",
// //   "Practical Applications and Techniques",
// //   "Advanced Topics and Future Trends",
// //   "Case Studies and Real-World Examples",
// //   "Implementation Strategies",
// //   "Optimization and Best Practices",
// //   "Troubleshooting and Common Issues",
// //   "Future Directions and Innovations"
// // ];
  
// //   const isTechName = cleanTopic.length > 2 && cleanTopic.length < 20 && !cleanTopic.includes(' ');
// //   const suffix = isTechName ? ` in ${cleanTopic}` : '';
  
// //   const chapters = base.map((t, i) => ({
// //     title: `${t}${suffix}`,
// //     subtopics: [
// //       "Understanding the core concept",
// //       "Practical applications",
// //       "Common challenges and how to address them"
// //     ]
// //   }));
  
// //   const raw = chapters.map(c =>
// //     `${c.title}\n${c.subtopics.map(s => `    - ${s}`).join('\n')}`
// //   ).join('\n');
  
// //   return { raw, parsed: chapters };
// // }

// // // ==================== AI INTERACTION ====================
// // async function askAI(prompt, userId, bookTopic, options = {}) {
// //   await globalRateLimiter.wait();

// //   const genCfg = options.genOptions || { maxOutputTokens: 4000, temperature: 0.7, topP: 0.9 };
// //   const model = ensureGenAI().getGenerativeModel({ model: MODEL_NAME, generationConfig: genCfg });

// //   const maxRetries = 3;
// //   for (let attempt = 0; attempt < maxRetries; attempt++) {
// //     try {
// //       const result = await model.generateContent(prompt);
      
// //       let reply = '';
// //       if (result.response && typeof result.response.text === 'function') {
// //         reply = await result.response.text();
// //       } else if (result.candidates?.[0]?.content?.parts?.[0]?.text) {
// //         reply = result.candidates[0].content.parts[0].text;
// //       } else if (result.output && Array.isArray(result.output)) {
// //         reply = result.output.map(o => (o?.content || o?.text || '')).join('\n');
// //       } else if (result.text) {
// //         reply = result.text;
// //       }
      
// //       reply = (reply || '').toString().trim();

// //       if (!reply || reply.length < 50) {
// //         logger.warn(`Empty reply on attempt ${attempt + 1}, retrying...`);
// //         if (attempt < maxRetries - 1) await new Promise(r => setTimeout(r, 2000 * (attempt + 1)));
// //         continue;
// //       }

// //       if (options.minLength && reply.length < options.minLength) {
// //         throw new Error(`Response too short: ${reply.length} < ${options.minLength}`);
// //       }

// //       if (options.saveToHistory) {
// //         const hist = userHistories.get(userId) || [];
// //         hist.push({ role: 'user', content: prompt });
// //         hist.push({ role: 'assistant', content: reply });
// //         userHistories.set(userId, hist);
// //         saveConversationHistory(userId, hist);
// //       }
// //       return reply;
// //     } catch (e) {
// //       logger.error(`AI call error (attempt ${attempt + 1}): ${e.message}`);
// //       if (attempt === maxRetries - 1) throw e;
// //       await new Promise(r => setTimeout(r, 3000 * (attempt + 1)));
// //     }
// //   }
// // }

// // // ==================== CONTENT GENERATION ====================
// // async function generateTOC(bookTopic, userId) {
// //   // <--- CHANGED: Requested EXACTLY 5 chapters in prompt
// //   const prompt = `Create a detailed table of contents for a book about "${bookTopic}".
// // REQUIREMENTS (FOLLOW EXACTLY):
// // - Output EXACTLY 10 chapters
// // - Use the format: "Chapter X: Title" on its own line
// // - Follow each chapter title with 3-5 subtopics, each on its own line, indented with 3 spaces and a dash: "   - Subtopic"
// // - NO extra text, NO explanations, NO markdown
// // - Make titles descriptive and unique
// // - Example format:
// // Chapter 1: Getting Started
// //    - Core Concepts
// //    - Practical Steps
// //    - Common Mistakes
// // [... continues to Chapter 10]`;

// //   let attempts = 0;
// //   let lastRaw = '';

// //   while (attempts < 5) {
// //     const genOptions = { maxOutputTokens: 1000, temperature: 0.3, topP: 0.8 };
// //     try {
// //       const rawTOC = await askAI(prompt, userId, bookTopic, { saveToHistory: true, genOptions });
// //       lastRaw = rawTOC;
      
// //       logger.debug(`Raw TOC (attempt ${attempts + 1}):\n${rawTOC.substring(0, 500)}...`);
      
// //       const cleaned = cleanUpAIText(rawTOC);
// //       const parsed = parseTOC(cleaned);

// //       // <--- CHANGED: Validation check for 5 chapters
// //       if (parsed.length === 10 && parsed.every(c => c.subtopics.length >= 3)) {
// //         logger.info(`✅ TOC succeeded on attempt ${attempts + 1}`);
// //         return { raw: cleaned, parsed };
// //       }
      
// //       logger.warn(`❌ TOC invalid – attempt ${attempts + 1}: Got ${parsed.length} chapters`);
// //     } catch (e) {
// //       logger.error(`❌ TOC AI error – attempt ${attempts + 1}: ${e.message}`);
// //     }
// //     attempts++;
// //   }

// //   logger.warn(`⚠️ TOC failed after 5 attempts – using fallback for "${bookTopic}"`);
// //   return generateFallbackTOC(bookTopic);
// // }

// // async function generateChapter(bookTopic, chapterNumber, chapterInfo, userId) {
// //   // <--- CHANGED: Extract subtopics into a list string
// //   const subtopicList = chapterInfo.subtopics.map(s => `- ${s}`).join('\n');

// //   // <--- CHANGED: Updated prompt to enforce specific subtopics
// //   const prompt = `Write Chapter ${chapterNumber}: "${chapterInfo.title}" for a book about "${bookTopic}".

// // CRITICAL FORMATTING RULES:
// // - Start with EXACTLY ONE heading: "## ${chapterInfo.title}"
// // - Do NOT repeat the title as a second heading
// // - Use ### for ALL subsections
// // - ALL tables MUST use strict GitHub Markdown table syntax
// // - NO trailing asterisks (*) on any lines
// // - NO HTML tags like <header> or <footer>
// // - 600+ words total

// // MANDATORY CONTENT STRUCTURE:
// // 1) Introduction: A brief overview of the chapter.
// // 2) KEY SECTIONS: You MUST create a specific subsection (### Heading) for EACH of the following subtopics:
// // ${subtopicList}

// // 3) Practical Application/Exercise: A real-world example or exercise.
// // 4) Further Reading: 2-3 references.

// // INSTRUCTIONS:
// // - For each subtopic listed above, explain it in detail.
// // - Use code examples ONLY if the topic is technical (programming/data).
// // - If writing code, use fenced code blocks like \`\`\`python or \`\`\`javascript.
// // - Use tables when comparing items.
// // - Ensure the flow is natural between subtopics.

// // Output ONLY the chapter content.`;

// //   return cleanUpAIText(await askAI(prompt, userId, bookTopic, {
// //     minLength: 1800,
// //     genOptions: { maxOutputTokens: 3500, temperature: 0.4 }
// //   }));
// // }

// // async function generateConclusion(bookTopic, chapterInfos, userId) {
// //   const titles = chapterInfos.map(c => c.title).join(', ');
// //   const prompt = `Write a professional conclusion for a book about "${bookTopic}".
// // Summarize these key topics: ${titles}
// // Include 3-5 authoritative resources with descriptions.

// // Use natural language and focus on summarizing the core concepts.
// // 300-350 words, formal tone.

// // Output ONLY the conclusion content.`;

// //   return cleanUpAIText(await askAI(prompt, userId, bookTopic, {
// //     minLength: 1200,
// //     genOptions: { maxOutputTokens: 2000, temperature: 0.4 }
// //   }));
// // }

// // // ==================== PDF GENERATION ====================
// // function buildEnhancedHTML(content, bookTitle) {
// //   const cleaned = cleanUpAIText(content);
// //   const formattedContent = formatMath(cleaned);
  
// //   // Extract clean title for cover
// //   const titleMatch = cleaned.match(/^#\s+(.+)$/m);
// //   let displayTitle = titleMatch ? titleMatch[1] : bookTitle;
// //   displayTitle = displayTitle
// //     .replace(/^Chapter\s+\d+:\s*/i, '')
// //     .replace(/^\d+\.\s*/, '')
// //     .trim();

// //   return `<!DOCTYPE html>
// // <html lang="en">
// // <head>
// //   <meta charset="utf-8">
// //   <meta name="viewport" content="width=device-width, initial-scale=1.0">
// //   <title>${displayTitle} - Bookgen.ai</title>
// //   <link rel="preconnect" href="[https://fonts.googleapis.com](https://fonts.googleapis.com)">
// //   <link rel="preconnect" href="[https://fonts.gstatic.com](https://fonts.gstatic.com)" crossorigin>
// //   <link href="[https://fonts.googleapis.com/css2?family=Merriweather:wght@300;400;700&family=Inter:wght@400;600;700&display=swap](https://fonts.googleapis.com/css2?family=Merriweather:wght@300;400;700&family=Inter:wght@400;600;700&display=swap)" rel="stylesheet">
// //   <script>
// //     window.MathJax = {
// //       tex: { inlineMath: [['\\\\(', '\\\\)']], displayMath: [['$$', '$$']] },
// //       svg: { fontCache: 'none', scale: 0.95 }
// //     };
// //   </script>
// //   <script type="text/javascript" id="MathJax-script" async src="[https://cdn.jsdelivr.net/npm/mathjax@3/es5/tex-mml-chtml.js](https://cdn.jsdelivr.net/npm/mathjax@3/es5/tex-mml-chtml.js)"></script>
// //   <script src="[https://cdn.jsdelivr.net/npm/prismjs@1.29.0/prism.min.js](https://cdn.jsdelivr.net/npm/prismjs@1.29.0/prism.min.js)"></script>
// //   <script src="[https://cdn.jsdelivr.net/npm/prismjs@1.29.0/components/prism-javascript.min.js](https://cdn.jsdelivr.net/npm/prismjs@1.29.0/components/prism-javascript.min.js)"></script>
// //   <script src="[https://cdn.jsdelivr.net/npm/prismjs@1.29.0/components/prism-python.min.js](https://cdn.jsdelivr.net/npm/prismjs@1.29.0/components/prism-python.min.js)"></script>
// //   <script src="[https://cdn.jsdelivr.net/npm/prismjs@1.29.0/components/prism-java.min.js](https://cdn.jsdelivr.net/npm/prismjs@1.29.0/components/prism-java.min.js)"></script>
// //   <script src="[https://cdn.jsdelivr.net/npm/prismjs@1.29.0/components/prism-cpp.min.js](https://cdn.jsdelivr.net/npm/prismjs@1.29.0/components/prism-cpp.min.js)"></script>
// //   <script src="[https://cdn.jsdelivr.net/npm/prismjs@1.29.0/components/prism-scala.min.js](https://cdn.jsdelivr.net/npm/prismjs@1.29.0/components/prism-scala.min.js)"></script>
// //   <link href="[https://cdn.jsdelivr.net/npm/prismjs@1.29.0/themes/prism-tomorrow.min.css](https://cdn.jsdelivr.net/npm/prismjs@1.29.0/themes/prism-tomorrow.min.css)" rel="stylesheet">
// //   <style>
// //     @page { margin: 90px 70px 80px 70px; size: A4; }
// //     .cover-page { page: cover; }
// //     @page cover { margin: 0; @top-center { content: none; } @bottom-center { content: none; } }
// //     body { font-family: 'Merriweather', Georgia, serif; font-size: 14px; line-height: 1.8; color: #1f2937; background: white; margin: 0; padding: 0; text-align: justify; hyphens: auto; }
// //     .cover-page { display: flex; flex-direction: column; justify-content: center; align-items: center; height: 100vh; page-break-after: always; text-align: center; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; margin: -90px -70px -80px -70px; padding: 70px; }
// //     .cover-title { font-family: 'Inter', sans-serif; font-size: 48px; font-weight: 700; margin-bottom: 0.3em; line-height: 1.2; text-shadow: 2px 2px 4px rgba(0,0,0,0.1); }
// //     .cover-subtitle { font-family: 'Inter', sans-serif; font-size: 24px; font-weight: 300; margin-bottom: 2em; opacity: 0.9; }
// //     .cover-meta { position: absolute; bottom: 60px; font-size: 14px; font-weight: 300; opacity: 0.8; }
// //     .cover-disclaimer { margin-top: 30px; font-size: 12px; color: #fecaca; font-style: italic; }
// //     h1, h2, h3, h4 { font-family: 'Inter', sans-serif; font-weight: 600; color: #1f2937; margin-top: 2.5em; margin-bottom: 0.8em; position: relative; }
// //     h1 { font-size: 28px; border-bottom: 3px solid #667eea; padding-bottom: 15px; margin-top: 0; page-break-before: always; }
// //     h1::after { content: ""; display: block; width: 80px; height: 3px; background: #764ba2; margin-top: 15px; }
// //     h2 { font-size: 22px; border-bottom: 2px solid #e5e7eb; padding-bottom: 8px; color: #4b5563; }
// //     h3 { font-size: 18px; color: #6b7280; }
// //     .chapter-content > h1 + p::first-letter { float: left; font-size: 4em; line-height: 1; margin: 0.1em 0.1em 0 0; font-weight: 700; color: #667eea; font-family: 'Inter', sans-serif; }
// //     code { background: #f3f4f6; padding: 3px 8px; border: 1px solid #e5e7eb; font-family: 'Fira Code', 'Courier New', monospace; font-size: 13px; border-radius: 4px; color: #1e40af; }
// //     pre { background: #1f2937; padding: 20px; overflow-x: auto; border: 1px solid #4b5563; border-radius: 8px; line-height: 1.5; margin: 1.5em 0; white-space: pre-wrap; word-wrap: break-word; box-shadow: 0 4px 6px rgba(0, 0, 0, 0.05); }
// //     pre code { background: none; border: none; padding: 0; color: #e5e7eb; }
// //     blockquote { border-left: 4px solid #667eea; margin: 2em 0; padding: 1em 1.5em; background: linear-gradient(to right, #f3f4f6 0%, #ffffff 100%); font-style: italic; border-radius: 0 8px 8px 0; position: relative; }
// //     blockquote::before { content: "“"; position: absolute; top: -20px; left: 10px; font-size: 80px; color: #d1d5db; font-family: 'Inter', sans-serif; line-height: 1; }
// //     .example { background: linear-gradient(to right, #eff6ff 0%, #ffffff 100%); border-left: 4px solid #3b82f6; padding: 20px; margin: 2em 0; border-radius: 0 8px 8px 0; font-style: italic; position: relative; }
// //     .example::before { content: "💡 Example"; display: block; font-weight: 600; color: #1d4ed8; margin-bottom: 10px; font-style: normal; }
// //     table { width: 100%; border-collapse: collapse; margin: 2em 0; box-shadow: 0 1px 3px rgba(0, 0, 0, 0.1); }
// //     th { background: #374151; color: white; padding: 12px; text-align: left; font-family: 'Inter', sans-serif; font-weight: 600; }
// //     td { padding: 12px; border-bottom: 1px solid #e5e7eb; }
// //     tr:nth-child(even) { background: #f9fafb; }
// //     .MathJax_Display { margin: 2em 0 !important; padding: 1em 0; overflow-x: auto; }
// //     .disclaimer-footer { margin-top: 4em; padding-top: 2em; border-top: 2px solid #e5e7eb; font-size: 12px; color: #6b7280; font-style: italic; text-align: center; }
// //   </style>
// // </head>
// // <body>
// //   <div class="cover-page">
// //     <div class="cover-content">
// //       <h1 class="cover-title">Bookgen.AI</h1>
// //       <h2 class="cover-subtitle">A Guide book</h2>
// //       <div class="cover-disclaimer">⚠️ Caution: AI-generated content may contain errors</div>
// //     </div>
// //     <div class="cover-meta">Generated by Bookgen.ai<br>${new Date().toLocaleDateString()}</div>
// //   </div>
// //   <div class="chapter-content">${marked.parse(formattedContent)}</div>
// //   <div class="disclaimer-footer">This book was generated by AI for educational purposes. Please verify all information independently.</div>
// //   <script>document.addEventListener('DOMContentLoaded', () => { Prism.highlightAll(); });</script>
// // </body>
// // </html>`;
// // }

// // async function generatePDF(content, outputPath, bookTitle) {
// //   try {
// //     const enhancedHtml = buildEnhancedHTML(content, bookTitle);
    
// //     const form = new FormData();
// //     const instructions = {
// //       parts: [{ html: "index.html" }],
// //       output: {
// //         format: "pdf",
// //         pdf: {
// //           margin: { top: "90px", bottom: "80px", left: "70px", right: "70px" },
// //           header: {
// //             content: '<div style="font-size: 10px; text-align: center; width: 100%; color: #6b7280;">Generated by bookgen.ai</div>',
// //             spacing: "5mm"
// //           },
// //           footer: {
// //             content: '<div style="font-size: 10px; text-align: center; width: 100%; color: #6b7280;">Page {pageNumber}</div>',
// //             spacing: "5mm"
// //           },
// //           waitDelay: 3000,
// //           printBackground: true,
// //           preferCSSPageSize: true
// //         }
// //       }
// //     };
    
// //     form.append('instructions', JSON.stringify(instructions));
// //     form.append('index.html', Buffer.from(enhancedHtml), {
// //       filename: 'index.html',
// //       contentType: 'text/html'
// //     });

// //     //const response = await fetch('[https://api.nutrient.io/build](https://api.nutrient.io/build)', {
// //     const response = await fetch('https://api.nutrient.io/build', {
// //       method: 'POST',
// //       headers: { 'Authorization': `Bearer ${NUTRIENT_API_KEY}` },
// //       body: form
// //     });

// //     if (!response.ok) {
// //       const errorText = await response.text();
// //       throw new Error(`Nutrient API error: ${response.status} - ${errorText}`);
// //     }

// //     const pdfBuffer = await response.buffer();
// //     fs.writeFileSync(outputPath, pdfBuffer);
// //     logger.info(`✅ PDF generated: ${outputPath}`);
// //     return outputPath;
// //   } catch (error) {
// //     logger.error(`❌ PDF generation failed: ${error.message}`);
// //     throw error;
// //   }
// // }

// // // ==================== MAIN GENERATOR ====================
// // export async function generateBookMedd(rawTopic, userId) {
// //   const bookTopic = rawTopic.replace(/^(generate|create|write)( me)? (a book )?(about )?/i, '').trim();
// //   const safeUserId = `${userId}-${bookTopic.replace(/\s+/g, '_').toLowerCase().slice(0, 50)}`;
// //   logger.info(`=== Starting: "${bookTopic}" for ${safeUserId} ===`);

// //   try {
// //     userHistories.delete(safeUserId);
// //     const { raw: tocRaw, parsed: chapterInfos } = await generateTOC(bookTopic, safeUserId);
    
// //     // Format TOC for PDF
// //     const formattedTOC = chapterInfos.map((ch, i) => {
// //       const num = i + 1;
// //       return `${num}. ${ch.title}\n${ch.subtopics.map(s => `   - ${s}`).join('\n')}`;
// //     }).join('\n\n');
    
// //     const tocFile = path.join(OUTPUT_DIR, `${CHAPTER_PREFIX}-${safeUserId}-toc.txt`);
// //     saveToFile(tocFile, `# Table of Contents\n\n${formattedTOC}\n\n---\n`);
// //     const files = [tocFile];

// //     // Generate chapters
// //     logger.info('Step 2/3: Generating chapters...');
// //     for (let i = 0; i < chapterInfos.length; i++) {
// //       if (global.cancelFlags?.[safeUserId]) {
// //         delete global.cancelFlags[safeUserId];
// //         throw new Error('Generation cancelled');
// //       }

// //       const chNum = i + 1;
// //       const info = chapterInfos[i];
// //       logger.info(` ${chNum}. ${info.title}`);
      
// //       const chapter = await generateChapter(bookTopic, chNum, info, safeUserId);
// //       const txt = `\n<div class="chapter-break"></div>\n\n# Chapter ${chNum}: ${info.title}\n\n${chapter}\n\n---\n`;
      
// //       const f = path.join(OUTPUT_DIR, `${CHAPTER_PREFIX}-${safeUserId}-${chNum}.txt`);
// //       saveToFile(f, txt);
// //       files.push(f);
// //     }

// //     // Generate conclusion
// //     logger.info('Step 3/3: Generating conclusion...');
// //     const conclusion = await generateConclusion(bookTopic, chapterInfos, safeUserId);
// //     const conclFile = path.join(OUTPUT_DIR, `${CHAPTER_PREFIX}-${safeUserId}-conclusion.txt`);
// //     saveToFile(conclFile, `\n<div class="chapter-break"></div>\n\n# Conclusion\n\n${conclusion}\n`);
// //     files.push(conclFile);

// //     // Combine and generate PDF
// //     logger.info('Combining content and generating PDF...');
// //     const combined = files.map(f => fs.readFileSync(f, 'utf8')).join('\n');
// //     const safeName = bookTopic.slice(0, 30).replace(/\s+/g, '_');
// //     const pdfPath = path.join(OUTPUT_DIR, `book_${safeUserId}_${safeName}.pdf`);
    
// //     await generatePDF(combined, pdfPath, bookTopic);

// //     // Cleanup
// //     files.forEach(deleteFile);
// //     userHistories.delete(safeUserId);
    
// //     logger.info(`=== SUCCESS: ${pdfPath} ===`);
// //     return pdfPath;
// //   } catch (e) {
// //     logger.error(`❌ Failed: ${e.message}`);
// //     throw e;
// //   }
// // }

// // // ==================== QUEUE SYSTEM ====================
// // const bookQueue = async.queue(async (task, callback) => {
// //   try {
// //     const result = await generateBookMedd(task.bookTopic, task.userId);
// //     callback(null, result);
// //   } catch (error) {
// //     callback(error);
// //   }
// // }, 1);

// // export function queueBookGeneration(bookTopic, userId) {
// //   return new Promise((resolve, reject) => {
// //     bookQueue.push({ bookTopic, userId }, (error, result) => {
// //       if (error) reject(error);
// //       else resolve(result);
// //     });
// //   });
// // }

// //generateBookMedd






























// // // AI/MB.js – FINAL FIXED VERSION: TOC, no duplicates, tables, clean HTML, perfect formatting
// // import { GoogleGenerativeAI } from '@google/generative-ai';
// // import { marked } from 'marked';
// // import hljs from 'highlight.js';
// // import fs from 'fs';
// // import path from 'path';
// // import { fileURLToPath } from 'url';
// // import async from 'async';
// // import winston from 'winston';
// // import fetch from 'node-fetch';
// // import FormData from 'form-data';
// // import dotenv from 'dotenv';

// // dotenv.config();

// // const __filename = fileURLToPath(import.meta.url);
// // const __dirname = path.dirname(__filename);

// // // ==================== CORE SETUP ====================
// // class RateLimiter {
// //   constructor(requestsPerMinute) {
// //     this.requestsPerMinute = requestsPerMinute;
// //     this.requests = [];
// //   }
// //   async wait() {
// //     const now = Date.now();
// //     this.requests = this.requests.filter(t => now - t < 60000);
// //     while (this.requests.length >= this.requestsPerMinute) {
// //       const oldest = this.requests[0];
// //       const waitTime = 60000 - (now - oldest) + 1000;
// //       await new Promise(resolve => setTimeout(resolve, waitTime));
// //     }
// //     this.requests.push(Date.now());
// //   }
// // }

// // const globalRateLimiter = new RateLimiter(15);
// // const HISTORY_DIR = path.join(__dirname, 'history');
// // const OUTPUT_DIR = path.join(__dirname, '../pdfs');
// // const CHAPTER_PREFIX = 'chapter';
// // const MODEL_NAME = 'gemini-2.5-flash-lite'   //gemini-2.5-flash-preview-09-2025 gemini-2.0-flash-lite';
// // const API_KEY = process.env.GEMINI_API_KEY;
// // const NUTRIENT_API_KEY = process.env.NUTRIENT_API_KEY;

// // if (!API_KEY) {
// //   console.error("❌ FATAL ERROR: GEMINI_API_KEY is missing from .env file");
// //   process.exit(1);
// // }

// // const genAI = new GoogleGenerativeAI(API_KEY);
// // const userHistories = new Map();

// // const logger = winston.createLogger({
// //   level: 'info',
// //   format: winston.format.combine(winston.format.timestamp(), winston.format.json()),
// //   transports: [
// //     new winston.transports.File({ filename: 'bookgen.log' }),
// //     new winston.transports.Console({ format: winston.format.simple() })
// //   ]
// // });

// // fs.mkdirSync(HISTORY_DIR, { recursive: true });
// // fs.mkdirSync(OUTPUT_DIR, { recursive: true });

// // // ==================== TOPIC DETECTION ====================
// // // function isProgrammingTopic(topic) {
// // //   const programmingKeywords = [
// // //     'programming', 'code', 'development', 'software', 'tutorial', 'guide',
// // //     'javascript', 'python', 'java', 'scala', 'cpp', 'c++', 'csharp', 'c#',
// // //     'typescript', 'ts', 'react', 'node', 'web', 'api', 'database',
// // //     'algorithm', 'data structure', 'function', 'class', 'object', 'variable',
// // //     'loop', 'conditional', 'module', 'library', 'framework', 'syntax'
// // //   ];
  
// // //   const lowerTopic = topic.toLowerCase();
// // //   return programmingKeywords.some(keyword => lowerTopic.includes(keyword));
// // // }

// // // function detectLanguage(topic) {
// // //   const langMap = {
// // //     'python': 'python', 'javascript': 'javascript', 'js': 'javascript',
// // //     'java': 'java', 'scala': 'scala', 'cpp': 'cpp', 'c++': 'cpp',
// // //     'csharp': 'csharp', 'c#': 'csharp', 'go': 'go', 'rust': 'rust',
// // //     'typescript': 'typescript', 'ts': 'typescript', 'react': 'jsx'
// // //   };
  
// // //   const lowerTopic = topic.toLowerCase();
// // //   for (const [key, lang] of Object.entries(langMap)) {
// // //     if (lowerTopic.includes(key)) return lang;
// // //   }
// // //   return 'java';
// // // }

// // // ==================== TEXT PROCESSING ====================
// // function cleanUpAIText(text) {
// //   if (!text) return '';
// //   return text
// //     // Remove greeting lines
// //     .replace(/^(?:Hi|Hello|Hey|Sure|Here).*?(\n\n|$)/gis, '')
// //     // Strip HTML artifacts completely
// //     .replace(/<\/?(header|footer|figure|figcaption)[^>]*>/gi, '')
// //     // Remove standalone "Table of Contents" lines
// //     .replace(/^\s*Table of Contents\s*$/gim, '')
// //     // Fix spacing: ensure numbers followed by words have space
// //     .replace(/(\d+)([a-zA-Z]+)/g, '$1 $2')
// //     // Fix split words (e.g., "J ava" -> "Java") - but NOT in code blocks
// //     .replace(/\b([A-Z])\s+([a-z]{2,})\b/g, (match, p1, p2) => {
// //       if (match.includes('`') || match.includes('```')) return match;
// //       return p1 + p2;
// //     })
// //     // Remove escaping of brackets/parentheses
// //     .replace(/\\([[\]{}()])/g, '$1')
// //     // Collapse excessive newlines
// //     .replace(/\n{3,}/g, '\n\n')
// //     // Normalize dashes
// //     .replace(/[\u2013\u2014]/g, '-')
// //     // Remove trailing asterisks
// //     .replace(/\*\s*$/gm, '')
// //     .trim();
// // }

// // /**
// //  * NEW: Enhanced to protect markdown tables
// //  */
// // // function formatMath(content) {
// // //   const links = [];
// // //   const codeBlocks = [];
// // //   const tables = [];
  
// // //   // Protect markdown tables (lines starting with | and having header separators)
// // //   content = content.replace(/(\|.*\|[\s]*\n\|[-:\s|]+\|[\s]*\n(\|.*\|[\s]*\n)*)/g, (table) => {
// // //     tables.push(table);
// // //     return `__TABLE__${tables.length - 1}__`;
// // //   });
  
// // //   // Protect code blocks
// // //   content = content.replace(/```[\w]*\n([\s\S]*?)\n```/g, (_, code) => {
// // //     codeBlocks.push(code);
// // //     return `__CODE__${codeBlocks.length - 1}__`;
// // //   });
  
// // //   // Protect inline code
// // //   content = content.replace(/`([^`]+)`/g, (_, code) => {
// // //     codeBlocks.push(code);
// // //     return `__CODE__${codeBlocks.length - 1}__`;
// // //   });

// // //   // Process math and links
// // //   content = content.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, text, url) => {
// // //     links.push(`<a href="${url}" target="_blank">${text}</a>`);
// // //     return `__LINK__${links.length - 1}__`;
// // //   });

// // //   content = content
// // //     .replace(/\[\s*(.*?)\s*\]/gs, '\\($1\\)')
// // //     .replace(/\(\s*(.*?)\s*\)/gs, '\\($1\\)')
// // //     .replace(/([a-zA-Z0-9]+)\s*\^\s*([a-zA-Z0-9]+)/g, '\\($1^{$2}\\)')
// // //     .replace(/(?<!\\)(?<!\w)(\d+)\s*\/\s*(\d+)(?!\w)/g, '\\(\\frac{$1}{$2}\\)');

// // //   // Restore links
// // //   content = content.replace(/__LINK__(\d+)__/g, (_, i) => links[i]);
  
// // //   // Restore tables
// // //   content = content.replace(/__TABLE__(\d+)__/g, (_, i) => tables[i]);
  
// // //   // Restore code blocks
// // //   content = content.replace(/__CODE__(\d+)__/g, (_, i) => {
// // //     const code = codeBlocks[i];
// // //     if (code.includes('\n')) {
// // //       return `\`\`\`\n${code}\n\`\`\``;
// // //     }
// // //     return `\`${code}\``;
// // //   });

// // //   return content;
// // // }

// // function formatMath(content) {
// //   const tables = [];
// //   const codeBlocks = [];

// //   // Protect tables (GitHub-style)
// //   content = content.replace(/(\|.+\|[\s]*\n\|[-:\s|]+\|[\s]*\n(?:\|.*\|[\s]*\n?)*)/g, (tbl) => {
// //     tables.push(tbl);
// //     return `__TABLE__${tables.length - 1}__`;
// //   });

// //   // Protect fenced code
// //   content = content.replace(/```[\w]*\n([\s\S]*?)```/g, (match, code) => {
// //     codeBlocks.push(match);
// //     return `__CODE__${codeBlocks.length - 1}__`;
// //   });

// //   // Protect inline code
// //   content = content.replace(/`([^`]+)`/g, (match) => {
// //     codeBlocks.push(match);
// //     return `__CODE__${codeBlocks.length - 1}__`;
// //   });

// //   // ======== FIX MATH ========
// //   // Fractions like 3/5 → \( \frac{3}{5} \)
// //   content = content.replace(/\b(\d+)\s*\/\s*(\d+)\b/g, '\\(\\\\frac{$1}{$2}\\\\)');

// //   // Powers like x^2 → \( x^{2} \)
// //   content = content.replace(/\b([a-zA-Z0-9]+)\s*\^\s*([a-zA-Z0-9]+)\b/g, '\\($1^{$2}\\)');

// //   // Scientific notation like 3e8 → \( 3 \times 10^{8} \)
// //   content = content.replace(/\b(\d+)e(\d+)\b/gi, '\\($1 \\times 10^{$2}\\)');

// //   // Restore tables
// //   content = content.replace(/__TABLE__(\d+)__/g, (_, i) => tables[i]);

// //   // Restore code blocks
// //   content = content.replace(/__CODE__(\d+)__/g, (_, i) => codeBlocks[i]);

// //   return content;
// // }

// // // ==================== MARKED SETUP ====================
// // marked.setOptions({
// //   headerIds: false,
// //   breaks: true,
// //   gfm: true,
// //   highlight: function(code, lang) {
// //     if (lang && hljs.getLanguage(lang)) {
// //       return hljs.highlight(code, { language: lang }).value;
// //     }
// //     return code;
// //   }
// // });

// // // ==================== HELPER FUNCTIONS ====================
// // function getHistoryFile(userId) {
// //   return path.join(HISTORY_DIR, `history-${userId}.json`);
// // }

// // function loadConversationHistory(userId) {
// //   try {
// //     return JSON.parse(fs.readFileSync(getHistoryFile(userId), 'utf8'));
// //   } catch {
// //     return [];
// //   }
// // }

// // function saveConversationHistory(userId, history) {
// //   fs.writeFileSync(getHistoryFile(userId), JSON.stringify(history, null, 2));
// // }

// // function saveToFile(filename, content) {
// //   fs.writeFileSync(filename, content);
// //   logger.info(`Saved: ${filename}`);
// // }

// // function deleteFile(filePath) {
// //   try {
// //     fs.unlinkSync(filePath);
// //   } catch {
// //     logger.warn(`Delete failed: ${filePath}`);
// //   }
// // }

// // // ==================== TOC PARSER ====================
// // /**
// //  * FINAL FIX: Better title extraction, no truncation, handles "Chapter X:" format
// //  */
// // function parseTOC(tocContent) {
// //   const lines = tocContent.split('\n').map(l => l.trimEnd()).filter(l => l.trim());
// //   const chapters = [];
// //   let current = null;

// //   for (let i = 0; i < lines.length; i++) {
// //     let line = lines[i];
    
// //     if (!line) continue;

// //     // Smart line merging for broken words
// //     if (line.length === 1 && /^[A-Z]$/.test(line) && i + 1 < lines.length) {
// //       const nextLine = lines[i + 1];
// //       if (nextLine && nextLine.length > 5 && !nextLine.match(/^[\s]*[-•*·\d]/) && !nextLine.startsWith(' ')) {
// //         line = line + nextLine;
// //         i++;
// //       }
// //     }

// //     // Match chapter lines: "Chapter 1: Title" OR "1. Title" OR "- Title"
// //     const chapterMatch = line.match(/^Chapter\s+\d+:\s*(.+)$/i);
// //     const simpleMatch = line.match(/^(?:\d+[\.\):]|\d+\s+|[-\*•])\s*(.+)$/i);
// //     const chapMatch = chapterMatch || simpleMatch;
    
// //     if (chapMatch && !line.startsWith('  -') && !line.match(/^[\s]*[-•*·]/)) {
// //       let title = chapMatch[1].trim();
      
// //       // Remove trailing punctuation but keep the full title
// //       title = title.replace(/[:–—*]\s*$/, '').trim();
// //       title = title.replace(/^\d+\.\s*/, '');
      
// //       // Validate it's a real chapter title (not too short, not generic)
// //       if (title && title.length > 10 && !/^(introduction|chapter|basics|overview|conclusion)$/i.test(title)) {
// //         if (current) chapters.push(current);
// //         current = { title, subtopics: [] };
// //       }
// //     } else if (current && line.match(/^[\s]*[-•*·]\s+(.+)$/)) {
// //       const sub = line.match(/^[\s]*[-•*·]\s+(.+)$/)[1].trim();
// //       if (sub && sub.length > 5 && !/^(subtopic|section|part)/i.test(sub)) {
// //         current.subtopics.push(sub);
// //       }
// //     }
// //   }
// //   if (current) chapters.push(current);

// //   const valid = chapters.filter(c => c.subtopics.length >= 3);
// //   logger.debug(`✅ Parsed ${valid.length} valid chapters out of ${chapters.length} total`);
// //   return valid.slice(0, 10);
// // }

// // function generateFallbackTOC(bookTopic) {
// //   const cleanTopic = bookTopic.replace(/\bin\s+.*$/i, '').trim();
  
// //   const base = [
// //     "Introduction to Core Concepts",
// //     "Essential Principles and Practices", 
// //     "Understanding Key Systems",
// //     "Practical Applications and Techniques",
// //     "Common Challenges and Solutions",
// //     "Best Practices and Guidelines",
// //     "Advanced Topics and Considerations",
// //     "Maintenance and Optimization",
// //     "Specialized Topics",
// //     "Building Expertise"
// //   ];
  
// //   const isTechName = cleanTopic.length > 2 && cleanTopic.length < 20 && !cleanTopic.includes(' ');
// //   const suffix = isTechName ? ` in ${cleanTopic}` : '';
  
// //   const chapters = base.map((t, i) => ({
// //     title: `${t}${suffix}`,
// //     subtopics: [
// //       "Understanding the core concept",
// //       "Practical applications",
// //       "Common challenges and how to address them"
// //     ]
// //   }));
  
// //   const raw = chapters.map(c =>
// //     `${c.title}\n${c.subtopics.map(s => `   - ${s}`).join('\n')}`
// //   ).join('\n');
  
// //   return { raw, parsed: chapters };
// // }

// // // ==================== AI INTERACTION ====================
// // async function askAI(prompt, userId, bookTopic, options = {}) {
// //   await globalRateLimiter.wait();

// //   const genCfg = options.genOptions || { maxOutputTokens: 4000, temperature: 0.7, topP: 0.9 };
// //   const model = genAI.getGenerativeModel({ model: MODEL_NAME, generationConfig: genCfg });

// //   const maxRetries = 3;
// //   for (let attempt = 0; attempt < maxRetries; attempt++) {
// //     try {
// //       const result = await model.generateContent(prompt);
      
// //       let reply = '';
// //       if (result.response && typeof result.response.text === 'function') {
// //         reply = await result.response.text();
// //       } else if (result.candidates?.[0]?.content?.parts?.[0]?.text) {
// //         reply = result.candidates[0].content.parts[0].text;
// //       } else if (result.output && Array.isArray(result.output)) {
// //         reply = result.output.map(o => (o?.content || o?.text || '')).join('\n');
// //       } else if (result.text) {
// //         reply = result.text;
// //       }
      
// //       reply = (reply || '').toString().trim();

// //       if (!reply || reply.length < 50) {
// //         logger.warn(`Empty reply on attempt ${attempt + 1}, retrying...`);
// //         if (attempt < maxRetries - 1) await new Promise(r => setTimeout(r, 2000 * (attempt + 1)));
// //         continue;
// //       }

// //       if (options.minLength && reply.length < options.minLength) {
// //         throw new Error(`Response too short: ${reply.length} < ${options.minLength}`);
// //       }

// //       if (options.saveToHistory) {
// //         const hist = userHistories.get(userId) || [];
// //         hist.push({ role: 'user', content: prompt });
// //         hist.push({ role: 'assistant', content: reply });
// //         userHistories.set(userId, hist);
// //         saveConversationHistory(userId, hist);
// //       }
// //       return reply;
// //     } catch (e) {
// //       logger.error(`AI call error (attempt ${attempt + 1}): ${e.message}`);
// //       if (attempt === maxRetries - 1) throw e;
// //       await new Promise(r => setTimeout(r, 3000 * (attempt + 1)));
// //     }
// //   }
// // }

// // // ==================== CONTENT GENERATION ==================== where is theerrr
// // async function generateTOC(bookTopic, userId) {
// //   const prompt = `Create a detailed table of contents for a book about "${bookTopic}".
// // REQUIREMENTS (FOLLOW EXACTLY):
// // - Output EXACTLY 10 chapters
// // - Use the format: "Chapter X: Title" on its own line
// // - Follow each chapter title with 3-5 subtopics, each on its own line, indented with 3 spaces and a dash: "   - Subtopic"
// // - NO extra text, NO explanations, NO markdown
// // - Make titles descriptive and unique
// // - Example format:
// // Chapter 1: Getting Started
// //    - Core Concepts
// //    - Practical Steps
// //    - Common Mistakes
// // [... continues to Chapter 10]`;

// //   let attempts = 0;
// //   let lastRaw = '';

// //   while (attempts < 5) {
// //     const genOptions = { maxOutputTokens: 1000, temperature: 0.3, topP: 0.8 };
// //     try {
// //       const rawTOC = await askAI(prompt, userId, bookTopic, { saveToHistory: true, genOptions });
// //       lastRaw = rawTOC;
      
// //       logger.debug(`Raw TOC (attempt ${attempts + 1}):\n${rawTOC.substring(0, 500)}...`);
      
// //       const cleaned = cleanUpAIText(rawTOC);
// //       const parsed = parseTOC(cleaned);

// //       if (parsed.length === 10 && parsed.every(c => c.subtopics.length >= 3)) {
// //         logger.info(`✅ TOC succeeded on attempt ${attempts + 1}`);
// //         return { raw: cleaned, parsed };
// //       }
      
// //       logger.warn(`❌ TOC invalid – attempt ${attempts + 1}: Got ${parsed.length} chapters`);
// //     } catch (e) {
// //       logger.error(`❌ TOC AI error – attempt ${attempts + 1}: ${e.message}`);
// //     }
// //     attempts++;
// //   }

// //   logger.warn(`⚠️ TOC failed after 5 attempts – using fallback for "${bookTopic}"`);
// //   return generateFallbackTOC(bookTopic);
// // }

// // /**
// //  * FINAL FIX: Dynamic structure, NO duplicate headers, PROPER subtopic integration
// //  */
// // // async function generateChapter(bookTopic, chapterNumber, chapterInfo, userId) {
// // //   const language = detectLanguage(bookTopic);
// // //   const isProgramming = isProgrammingTopic(bookTopic);
  
// // //   // Build dynamic structure based on topic type
// // //   let promptStructure = `
// // // - Structure:
// // //   1) Short intro (50-80 words) - NO heading
// // //   2) ## Concepts — explain key ideas (200-300 words)`;
  
// // //   if (isProgramming) {
// // //     promptStructure += `
// // //   3) ### ${chapterInfo.subtopics[0]} — Show ${language} code with explanation (include fenced code block)
// // //   4) ### ${chapterInfo.subtopics[1]} — Practical ${language} snippet with context
// // //   5) ### ${chapterInfo.subtopics[2]} — Common pitfalls and solutions`;
// // //   } else {
// // //     promptStructure += `
// // //   3) ### ${chapterInfo.subtopics[0]} — Detailed real-world scenario or case study
// // //   4) ### ${chapterInfo.subtopics[1]} — Practical application with step-by-step guidance
// // //   5) ### ${chapterInfo.subtopics[2]} — Common challenges and proven solutions`;
// // //   }
  
// // //   promptStructure += `
// // //   6) ### Exercise — 1 short question
// // //   7) ### Solution — Clear answer to the exercise
// // //   End with "Further reading:" and 2 references.`;

// // //   const prompt = `Write Chapter ${chapterNumber}: "${chapterInfo.title}" for a book about "${bookTopic}".
// // // CRITICAL FORMATTING RULES:
// // // - Start with EXACTLY ONE heading: "## ${chapterInfo.title}"
// // // - Do NOT repeat the title as a second heading
// // // - Use ### for ALL subsections (including the three listed above)
// // // - ALL tables MUST use strict GitHub Markdown table syntax:
// // //   | Column A | Column B |
// // //   |----------|----------|
// // //   | value    | value    |
// // // - Do NOT use lists, bullets, dashes, colons, or anything else to simulate tables.
// // // - Never output "Action - Result" or "A | B" without a proper header + divider line.
// // // - Use blockquotes (>) for important notes or definitions
// // // - NO trailing asterisks (*) on any lines
// // // - NO HTML tags like <header> or <footer>
// // // - 500+ words total
// // // ${promptStructure}
// // // - Output ONLY the chapter content.`;

// // //   return cleanUpAIText(await askAI(prompt, userId, bookTopic, {
// // //     minLength: 1800,
// // //     genOptions: { maxOutputTokens: 3500, temperature: 0.4 }
// // //   }));
// // // }

// // async function generateChapter(bookTopic, chapterNumber, chapterInfo, userId) {
// //   const prompt = `Write Chapter ${chapterNumber}: "${chapterInfo.title}" for a book about "${bookTopic}".

// // CRITICAL FORMATTING RULES:
// // - Start with EXACTLY ONE heading: "## ${chapterInfo.title}"
// // - Do NOT repeat the title as a second heading
// // - Use ### for ALL subsections
// // - ALL tables MUST use strict GitHub Markdown table syntax:
// //   | Column A | Column B |
// //   |----------|----------|
// //   | value    | value    |
// // - Include content that naturally fits the topic
// // - Use code examples ONLY when they genuinely help explain technical concepts
// // - If you include code, use proper fenced code blocks with language specification
// // - Use tables when they help organize information clearly
// // - Use blockquotes (>) for important notes or definitions
// // - NO trailing asterisks (*) on any lines
// // - NO HTML tags like <header> or <footer>
// // - 500+ words total

// // CONTENT STRUCTURE:
// // 1) Introduction explaining the chapter's focus
// // 2) Clear explanations of key concepts
// // 3) Practical examples or case studies (use code only if technical)
// // 4) Common challenges and solutions
// // 5) Exercise with solution
// // 6) Further reading references

// // Let the content flow naturally and use the most appropriate format for each section.

// // - Output ONLY the chapter content.`;

// //   return cleanUpAIText(await askAI(prompt, userId, bookTopic, {
// //     minLength: 1800,
// //     genOptions: { maxOutputTokens: 3500, temperature: 0.4 }
// //   }));
// // }

// // // async function generateConclusion(bookTopic, chapterInfos, userId) {
// // //   const titles = chapterInfos.map(c => c.title).join(', ');
// // //   const prompt = `Write a professional conclusion for "${bookTopic}".
// // // Summarize these key topics: ${titles}
// // // Include 3-5 authoritative resources with descriptions.
// // // 300-350 words, formal tone, no code examples.`;

// // //   return cleanUpAIText(await askAI(prompt, userId, bookTopic, {
// // //     minLength: 1200,
// // //     genOptions: { maxOutputTokens: 2000, temperature: 0.4 }
// // //   }));
// // // }

// // async function generateConclusion(bookTopic, chapterInfos, userId) {
// //   const titles = chapterInfos.map(c => c.title).join(', ');
// //   const prompt = `Write a professional conclusion for a book about "${bookTopic}".
// // Summarize these key topics: ${titles}
// // Include 3-5 authoritative resources with descriptions.

// // Use natural language and focus on summarizing the core concepts.
// // 300-350 words, formal tone.

// // Output ONLY the conclusion content.`;

// //   return cleanUpAIText(await askAI(prompt, userId, bookTopic, {
// //     minLength: 1200,
// //     genOptions: { maxOutputTokens: 2000, temperature: 0.4 }
// //   }));
// // }

// // // ==================== PDF GENERATION ====================
// // function buildEnhancedHTML(content, bookTitle) {
// //   const cleaned = cleanUpAIText(content);
// //   const formattedContent = formatMath(cleaned);
  
// //   // Extract clean title for cover
// //   const titleMatch = cleaned.match(/^#\s+(.+)$/m);
// //   let displayTitle = titleMatch ? titleMatch[1] : bookTitle;
// //   displayTitle = displayTitle
// //     .replace(/^Chapter\s+\d+:\s*/i, '')
// //     .replace(/^\d+\.\s*/, '')
// //     .trim();

// //   return `<!DOCTYPE html>
// // <html lang="en">
// // <head>
// //   <meta charset="utf-8">
// //   <meta name="viewport" content="width=device-width, initial-scale=1.0">
// //   <title>${displayTitle} - Bookgen.ai</title>
// //   <link rel="preconnect" href="https://fonts.googleapis.com">
// //   <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
// //   <link href="https://fonts.googleapis.com/css2?family=Merriweather:wght@300;400;700&family=Inter:wght@400;600;700&display=swap" rel="stylesheet">
// //   <script>
// //     window.MathJax = {
// //       tex: { inlineMath: [['\\\\(', '\\\\)']], displayMath: [['$$', '$$']] },
// //       svg: { fontCache: 'none', scale: 0.95 }
// //     };
// //   </script>
// //   <script type="text/javascript" id="MathJax-script" async src="https://cdn.jsdelivr.net/npm/mathjax@3/es5/tex-mml-chtml.js"></script>
// //   <script src="https://cdn.jsdelivr.net/npm/prismjs@1.29.0/prism.min.js"></script>
// //   <script src="https://cdn.jsdelivr.net/npm/prismjs@1.29.0/components/prism-javascript.min.js"></script>
// //   <script src="https://cdn.jsdelivr.net/npm/prismjs@1.29.0/components/prism-python.min.js"></script>
// //   <script src="https://cdn.jsdelivr.net/npm/prismjs@1.29.0/components/prism-java.min.js"></script>
// //   <script src="https://cdn.jsdelivr.net/npm/prismjs@1.29.0/components/prism-cpp.min.js"></script>
// //   <script src="https://cdn.jsdelivr.net/npm/prismjs@1.29.0/components/prism-scala.min.js"></script>
// //   <link href="https://cdn.jsdelivr.net/npm/prismjs@1.29.0/themes/prism-tomorrow.min.css" rel="stylesheet">
// //   <style>
// //     @page { margin: 90px 70px 80px 70px; size: A4; }
// //     .cover-page { page: cover; }
// //     @page cover { margin: 0; @top-center { content: none; } @bottom-center { content: none; } }
// //     body { font-family: 'Merriweather', Georgia, serif; font-size: 14px; line-height: 1.8; color: #1f2937; background: white; margin: 0; padding: 0; text-align: justify; hyphens: auto; }
// //     .cover-page { display: flex; flex-direction: column; justify-content: center; align-items: center; height: 100vh; page-break-after: always; text-align: center; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; margin: -90px -70px -80px -70px; padding: 70px; }
// //     .cover-title { font-family: 'Inter', sans-serif; font-size: 48px; font-weight: 700; margin-bottom: 0.3em; line-height: 1.2; text-shadow: 2px 2px 4px rgba(0,0,0,0.1); }
// //     .cover-subtitle { font-family: 'Inter', sans-serif; font-size: 24px; font-weight: 300; margin-bottom: 2em; opacity: 0.9; }
// //     .cover-meta { position: absolute; bottom: 60px; font-size: 14px; font-weight: 300; opacity: 0.8; }
// //     .cover-disclaimer { margin-top: 30px; font-size: 12px; color: #fecaca; font-style: italic; }
// //     h1, h2, h3, h4 { font-family: 'Inter', sans-serif; font-weight: 600; color: #1f2937; margin-top: 2.5em; margin-bottom: 0.8em; position: relative; }
// //     h1 { font-size: 28px; border-bottom: 3px solid #667eea; padding-bottom: 15px; margin-top: 0; page-break-before: always; }
// //     h1::after { content: ""; display: block; width: 80px; height: 3px; background: #764ba2; margin-top: 15px; }
// //     h2 { font-size: 22px; border-bottom: 2px solid #e5e7eb; padding-bottom: 8px; color: #4b5563; }
// //     h3 { font-size: 18px; color: #6b7280; }
// //     .chapter-content > h1 + p::first-letter { float: left; font-size: 4em; line-height: 1; margin: 0.1em 0.1em 0 0; font-weight: 700; color: #667eea; font-family: 'Inter', sans-serif; }
// //     code { background: #f3f4f6; padding: 3px 8px; border: 1px solid #e5e7eb; font-family: 'Fira Code', 'Courier New', monospace; font-size: 13px; border-radius: 4px; color: #1e40af; }
// //     pre { background: #1f2937; padding: 20px; overflow-x: auto; border: 1px solid #4b5563; border-radius: 8px; line-height: 1.5; margin: 1.5em 0; white-space: pre-wrap; word-wrap: break-word; box-shadow: 0 4px 6px rgba(0, 0, 0, 0.05); }
// //     pre code { background: none; border: none; padding: 0; color: #e5e7eb; }
// //     blockquote { border-left: 4px solid #667eea; margin: 2em 0; padding: 1em 1.5em; background: linear-gradient(to right, #f3f4f6 0%, #ffffff 100%); font-style: italic; border-radius: 0 8px 8px 0; position: relative; }
// //     blockquote::before { content: """; position: absolute; top: -20px; left: 10px; font-size: 80px; color: #d1d5db; font-family: 'Inter', sans-serif; line-height: 1; }
// //     .example { background: linear-gradient(to right, #eff6ff 0%, #ffffff 100%); border-left: 4px solid #3b82f6; padding: 20px; margin: 2em 0; border-radius: 0 8px 8px 0; font-style: italic; position: relative; }
// //     .example::before { content: "💡 Example"; display: block; font-weight: 600; color: #1d4ed8; margin-bottom: 10px; font-style: normal; }
// //     table { width: 100%; border-collapse: collapse; margin: 2em 0; box-shadow: 0 1px 3px rgba(0, 0, 0, 0.1); }
// //     th { background: #374151; color: white; padding: 12px; text-align: left; font-family: 'Inter', sans-serif; font-weight: 600; }
// //     td { padding: 12px; border-bottom: 1px solid #e5e7eb; }
// //     tr:nth-child(even) { background: #f9fafb; }
// //     .MathJax_Display { margin: 2em 0 !important; padding: 1em 0; overflow-x: auto; }
// //     .disclaimer-footer { margin-top: 4em; padding-top: 2em; border-top: 2px solid #e5e7eb; font-size: 12px; color: #6b7280; font-style: italic; text-align: center; }
// //   </style>
// // </head>
// // <body>
// //   <div class="cover-page">
// //     <div class="cover-content">
// //       <h1 class="cover-title">Bookgen.AI</h1>
// //       <h2 class="cover-subtitle">A Guide book</h2>
// //       <div class="cover-disclaimer">⚠️ Caution: AI-generated content may contain errors</div>
// //     </div>
// //     <div class="cover-meta">Generated by Bookgen.ai<br>${new Date().toLocaleDateString()}</div>
// //   </div>
// //   <div class="chapter-content">${marked.parse(formattedContent)}</div>
// //   <div class="disclaimer-footer">This book was generated by AI for educational purposes. Please verify all information independently.</div>
// //   <script>document.addEventListener('DOMContentLoaded', () => { Prism.highlightAll(); });</script>
// // </body>
// // </html>`;
// // }

// // async function generatePDF(content, outputPath, bookTitle) {
// //   try {
// //     const enhancedHtml = buildEnhancedHTML(content, bookTitle);
    
// //     const form = new FormData();
// //     const instructions = {
// //       parts: [{ html: "index.html" }],
// //       output: {
// //         format: "pdf",
// //         pdf: {
// //           margin: { top: "90px", bottom: "80px", left: "70px", right: "70px" },
// //           header: {
// //             content: '<div style="font-size: 10px; text-align: center; width: 100%; color: #6b7280;">Generated by bookgen.ai</div>',
// //             spacing: "5mm"
// //           },
// //           footer: {
// //             content: '<div style="font-size: 10px; text-align: center; width: 100%; color: #6b7280;">Page {pageNumber}</div>',
// //             spacing: "5mm"
// //           },
// //           waitDelay: 3000,
// //           printBackground: true,
// //           preferCSSPageSize: true
// //         }
// //       }
// //     };
    
// //     form.append('instructions', JSON.stringify(instructions));
// //     form.append('index.html', Buffer.from(enhancedHtml), {
// //       filename: 'index.html',
// //       contentType: 'text/html'
// //     });

// //     const response = await fetch('https://api.nutrient.io/build', {
// //       method: 'POST',
// //       headers: { 'Authorization': `Bearer ${NUTRIENT_API_KEY}` },
// //       body: form
// //     });

// //     if (!response.ok) {
// //       const errorText = await response.text();
// //       throw new Error(`Nutrient API error: ${response.status} - ${errorText}`);
// //     }

// //     const pdfBuffer = await response.buffer();
// //     fs.writeFileSync(outputPath, pdfBuffer);
// //     logger.info(`✅ PDF generated: ${outputPath}`);
// //     return outputPath;
// //   } catch (error) {
// //     logger.error(`❌ PDF generation failed: ${error.message}`);
// //     throw error;
// //   }
// // }

// // // ==================== MAIN GENERATOR ====================
// // export async function generateBookMedd(rawTopic, userId) {
// //   const bookTopic = rawTopic.replace(/^(generate|create|write)( me)? (a book )?(about )?/i, '').trim();
// //   const safeUserId = `${userId}-${bookTopic.replace(/\s+/g, '_').toLowerCase().slice(0, 50)}`;
// //   logger.info(`=== Starting: "${bookTopic}" for ${safeUserId} ===`);

// //   try {
// //     userHistories.delete(safeUserId);
// //     const { raw: tocRaw, parsed: chapterInfos } = await generateTOC(bookTopic, safeUserId);
    
// //     // Format TOC for PDF
// //     const formattedTOC = chapterInfos.map((ch, i) => {
// //       const num = i + 1;
// //       return `${num}. ${ch.title}\n${ch.subtopics.map(s => `   - ${s}`).join('\n')}`;
// //     }).join('\n\n');
    
// //     const tocFile = path.join(OUTPUT_DIR, `${CHAPTER_PREFIX}-${safeUserId}-toc.txt`);
// //     saveToFile(tocFile, `# Table of Contents\n\n${formattedTOC}\n\n---\n`);
// //     const files = [tocFile];

// //     // Generate chapters
// //     logger.info('Step 2/3: Generating chapters...');
// //     for (let i = 0; i < chapterInfos.length; i++) {
// //       if (global.cancelFlags?.[safeUserId]) {
// //         delete global.cancelFlags[safeUserId];
// //         throw new Error('Generation cancelled');
// //       }

// //       const chNum = i + 1;
// //       const info = chapterInfos[i];
// //       logger.info(` ${chNum}. ${info.title}`);
      
// //       const chapter = await generateChapter(bookTopic, chNum, info, safeUserId);
// //       const txt = `\n<div class="chapter-break"></div>\n\n# Chapter ${chNum}: ${info.title}\n\n${chapter}\n\n---\n`;
      
// //       const f = path.join(OUTPUT_DIR, `${CHAPTER_PREFIX}-${safeUserId}-${chNum}.txt`);
// //       saveToFile(f, txt);
// //       files.push(f);
// //     }

// //     // Generate conclusion
// //     logger.info('Step 3/3: Generating conclusion...');
// //     const conclusion = await generateConclusion(bookTopic, chapterInfos, safeUserId);
// //     const conclFile = path.join(OUTPUT_DIR, `${CHAPTER_PREFIX}-${safeUserId}-conclusion.txt`);
// //     saveToFile(conclFile, `\n<div class="chapter-break"></div>\n\n# Conclusion\n\n${conclusion}\n`);
// //     files.push(conclFile);

// //     // Combine and generate PDF
// //     logger.info('Combining content and generating PDF...');
// //     const combined = files.map(f => fs.readFileSync(f, 'utf8')).join('\n');
// //     const safeName = bookTopic.slice(0, 30).replace(/\s+/g, '_');
// //     const pdfPath = path.join(OUTPUT_DIR, `book_${safeUserId}_${safeName}.pdf`);
    
// //     await generatePDF(combined, pdfPath, bookTopic);

// //     // Cleanup
// //     files.forEach(deleteFile);
// //     userHistories.delete(safeUserId);
    
// //     logger.info(`=== SUCCESS: ${pdfPath} ===`);
// //     return pdfPath;
// //   } catch (e) {
// //     logger.error(`❌ Failed: ${e.message}`);
// //     throw e;
// //   }
// // }

// // // ==================== QUEUE SYSTEM ====================
// // const bookQueue = async.queue(async (task, callback) => {
// //   try {
// //     const result = await generateBookMedd(task.bookTopic, task.userId);
// //     callback(null, result);
// //   } catch (error) {
// //     callback(error);
// //   }
// // }, 1);

// // export function queueBookGeneration(bookTopic, userId) {
// //   return new Promise((resolve, reject) => {
// //     bookQueue.push({ bookTopic, userId }, (error, result) => {
// //       if (error) reject(error);
// //       else resolve(result);
// //     });
// //   });
// // }











// // // AI/MB.js – FULLY FIXED: Code Blocks, Titles, Tables & HTML Artifacts
// // import { GoogleGenerativeAI } from '@google/generative-ai';
// // import { marked } from 'marked';
// // import hljs from 'highlight.js';
// // import fs from 'fs';
// // import path from 'path';
// // import { fileURLToPath } from 'url';
// // import async from 'async';
// // import winston from 'winston';
// // import fetch from 'node-fetch';
// // import FormData from 'form-data';

// // const __filename = fileURLToPath(import.meta.url);
// // const __dirname = path.dirname(__filename);

// // // ==================== CORE SETUP ====================
// // class RateLimiter {
// //   constructor(requestsPerMinute) {
// //     this.requestsPerMinute = requestsPerMinute;
// //     this.requests = [];
// //   }
// //   async wait() {
// //     const now = Date.now();
// //     this.requests = this.requests.filter(t => now - t < 60000);
// //     while (this.requests.length >= this.requestsPerMinute) {
// //       const oldest = this.requests[0];
// //       const waitTime = 60000 - (now - oldest) + 1000;
// //       await new Promise(resolve => setTimeout(resolve, waitTime));
// //     }
// //     this.requests.push(Date.now());
// //   }
// // }

// // const globalRateLimiter = new RateLimiter(15);
// // const HISTORY_DIR = path.join(__dirname, 'history');
// // const OUTPUT_DIR = path.join(__dirname, '../pdfs');
// // const CHAPTER_PREFIX = 'chapter';
// // const MODEL_NAME = 'gemini-2.5-flash-preview-09-2025';
// // const API_KEY = 'AIzaSyB1mzRKeAnsV__6yxngqgx2pSjuMTGwruo';
// // const NUTRIENT_API_KEY = 'pdf_live_162WJVSTDmuCQGjksJJXoxrbipwxrHteF8cXC9Z71gC';

// // const genAI = new GoogleGenerativeAI(API_KEY);
// // const userHistories = new Map();

// // const logger = winston.createLogger({
// //   level: 'info',
// //   format: winston.format.combine(winston.format.timestamp(), winston.format.json()),
// //   transports: [
// //     new winston.transports.File({ filename: 'bookgen.log' }),
// //     new winston.transports.Console({ format: winston.format.simple() })
// //   ]
// // });

// // fs.mkdirSync(HISTORY_DIR, { recursive: true });
// // fs.mkdirSync(OUTPUT_DIR, { recursive: true });

// // // ==================== FIXED TEXT PROCESSING ====================
// // function cleanUpAIText(text) {
// //   if (!text) return '';
// //   return text
// //     // Remove greeting lines
// //     .replace(/^(?:Hi|Hello|Hey|Sure|Here).*?(\n\n|$)/gis, '')
// //     // Strip HTML artifacts
// //     .replace(/<header>[\s\S]*?<\/header>/gi, '')
// //     .replace(/<footer>[\s\S]*?<\/footer>/gi, '')
// //     .replace(/<figure>[\s\S]*?<\/figure>/gi, '')
// //     // Remove trailing asterisks from lines
// //     .replace(/\*\s*$/gm, '')
// //     // Fix split words (e.g., "J ava" -> "Java")
// //     .replace(/\b([A-Z])\s+([a-z]{2,})\b/g, '$1$2')
// //     // Remove ALL escaping of brackets/parentheses
// //     .replace(/\\([[\]{}()])/g, '$1')
// //     // Collapse excessive newlines
// //     .replace(/\n{3,}/g, '\n\n')
// //     // Normalize dashes
// //     .replace(/[\u2013\u2014]/g, '-')
// //     .trim();
// // }

// // function formatMath(content) {
// //   const links = [];
// //   const codeBlocks = [];
  
// //   // STEP 1: Protect code blocks and inline code from processing
// //   content = content.replace(/```[\w]*\n([\s\S]*?)\n```/g, (_, code) => {
// //     codeBlocks.push(code);
// //     return `__CODE__${codeBlocks.length - 1}__`;
// //   });
  
// //   content = content.replace(/`([^`]+)`/g, (_, code) => {
// //     codeBlocks.push(code);
// //     return `__CODE__${codeBlocks.length - 1}__`;
// //   });

// //   // STEP 2: Process math (links, inline math, fractions)
// //   content = content.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, text, url) => {
// //     links.push(`<a href="${url}" target="_blank">${text}</a>`);
// //     return `__LINK__${links.length - 1}__`;
// //   });

// //   content = content
// //     .replace(/\[\s*(.*?)\s*\]/gs, '\\($1\\)')
// //     .replace(/\(\s*(.*?)\s*\)/gs, '\\($1\\)')
// //     .replace(/([a-zA-Z0-9]+)\s*\^\s*([a-zA-Z0-9]+)/g, '\\($1^{$2}\\)')
// //     .replace(/(?<!\\)(?<!\w)(\d+)\s*\/\s*(\d+)(?!\w)/g, '\\(\\frac{$1}{$2}\\)');

// //   // STEP 3: Restore links and code blocks
// //   content = content.replace(/__LINK__(\d+)__/g, (_, i) => links[i]);
  
// //   content = content.replace(/__CODE__(\d+)__/g, (_, i) => {
// //     const code = codeBlocks[i];
// //     // Restore with proper markdown fence if it's a block
// //     if (code.includes('\n')) {
// //       return `\`\`\`java\n${code}\n\`\`\``;
// //     }
// //     return `\`${code}\``;
// //   });

// //   return content;
// // }

// // // ==================== MARKED SETUP ====================
// // marked.setOptions({
// //   headerIds: false,
// //   breaks: true,
// //   gfm: true, // Enables tables, strikethrough, etc.
// //   highlight: function(code, lang) {
// //     if (lang && hljs.getLanguage(lang)) {
// //       return hljs.highlight(code, { language: lang }).value;
// //     }
// //     return code;
// //   }
// // });

// // // ==================== HELPER FUNCTIONS ====================
// // function getHistoryFile(userId) {
// //   return path.join(HISTORY_DIR, `history-${userId}.json`);
// // }

// // function loadConversationHistory(userId) {
// //   try {
// //     return JSON.parse(fs.readFileSync(getHistoryFile(userId), 'utf8'));
// //   } catch {
// //     return [];
// //   }
// // }

// // function saveConversationHistory(userId, history) {
// //   fs.writeFileSync(getHistoryFile(userId), JSON.stringify(history, null, 2));
// // }

// // function saveToFile(filename, content) {
// //   fs.writeFileSync(filename, content);
// //   logger.info(`Saved: ${filename}`);
// // }

// // function deleteFile(filePath) {
// //   try {
// //     fs.unlinkSync(filePath);
// //   } catch {
// //     logger.warn(`Delete failed: ${filePath}`);
// //   }
// // }

// // // ==================== TOC PARSER ====================
// // function parseTOC(tocContent) {
// //   const lines = tocContent.split('\n').map(l => l.trimEnd()).filter(l => l.trim());
// //   const chapters = [];
// //   let current = null;

// //   for (const line of lines) {
// //     // Match chapter lines (not subtopics)
// //     const chapMatch = line.match(/^(\d+[\.\)]|\d+\s+|[-\*•]|\d+\s*[-\):–—]?)\s*(.+)$/i);
// //     if (chapMatch && !line.startsWith('  -') && !line.match(/^[\s]*[-•*·]/)) {
// //       const title = chapMatch[2].trim().replace(/[:–—*].*$/, '').trim();
// //       // Clean up title: remove trailing asterisks and numbers
// //       title = title.replace(/\*\s*$/g, '').replace(/^\d+\.\s*/, '');
// //       if (title && title.length > 5 && !/^(introduction|chapter|basics|overview|conclusion)/i.test(title)) {
// //         if (current) chapters.push(current);
// //         current = { title, subtopics: [] };
// //       }
// //     } else if (current && line.match(/^[\s]*[-•*·]\s+(.+)$/)) {
// //       const sub = line.match(/^[\s]*[-•*·]\s+(.+)$/)[1].trim();
// //       if (sub && !/^(subtopic|section|part)/i.test(sub)) {
// //         current.subtopics.push(sub);
// //       }
// //     }
// //   }
// //   if (current) chapters.push(current);

// //   const valid = chapters.filter(c => c.subtopics.length >= 2);
// //   return valid.slice(0, 10);
// // }

// // function generateFallbackTOC(bookTopic) {
// //   const base = [
// //     "Getting Started with Variables and Data Types",
// //     "Control Flow: Loops and Conditionals",
// //     "Functions and Modular Code",
// //     "Data Structures: Lists, Arrays, and Collections",
// //     "Working with Strings and Text Processing",
// //     "File Handling and Input/Output",
// //     "Error Handling and Debugging",
// //     "Object-Oriented Programming Basics",
// //     "Modules, Packages, and Libraries",
// //     "Building Your First Project"
// //   ];
// //   const chapters = base.map((t, i) => ({
// //     title: `${t} in ${bookTopic.split(' ').pop()}`,
// //     subtopics: [
// //       "Understanding the core concept",
// //       "Practical code examples",
// //       "Common pitfalls and how to avoid them"
// //     ]
// //   }));
// //   const raw = chapters.map(c =>
// //     `${c.title}\n${c.subtopics.map(s => `   - ${s}`).join('\n')}`
// //   ).join('\n');
// //   return { raw, parsed: chapters };
// // }

// // // ==================== AI INTERACTION ====================
// // async function askAI(prompt, userId, bookTopic, options = {}) {
// //   await globalRateLimiter.wait();

// //   const genCfg = options.genOptions || { maxOutputTokens: 4000, temperature: 0.7, topP: 0.9 };
// //   const model = genAI.getGenerativeModel({ model: MODEL_NAME, generationConfig: genCfg });

// //   const maxRetries = 3;
// //   for (let attempt = 0; attempt < maxRetries; attempt++) {
// //     try {
// //       const result = await model.generateContent(prompt);
      
// //       let reply = '';
// //       if (result.response && typeof result.response.text === 'function') {
// //         reply = await result.response.text();
// //       } else if (result.candidates?.[0]?.content?.parts?.[0]?.text) {
// //         reply = result.candidates[0].content.parts[0].text;
// //       } else if (result.output && Array.isArray(result.output)) {
// //         reply = result.output.map(o => (o?.content || o?.text || '')).join('\n');
// //       } else if (result.text) {
// //         reply = result.text;
// //       }
      
// //       reply = (reply || '').toString().trim();

// //       if (!reply || reply.length < 50) {
// //         logger.warn(`Empty reply on attempt ${attempt + 1}, retrying...`);
// //         if (attempt < maxRetries - 1) await new Promise(r => setTimeout(r, 2000 * (attempt + 1)));
// //         continue;
// //       }

// //       if (options.minLength && reply.length < options.minLength) {
// //         throw new Error(`Response too short: ${reply.length} < ${options.minLength}`);
// //       }

// //       if (options.saveToHistory) {
// //         const hist = userHistories.get(userId) || [];
// //         hist.push({ role: 'user', content: prompt });
// //         hist.push({ role: 'assistant', content: reply });
// //         userHistories.set(userId, hist);
// //         saveConversationHistory(userId, hist);
// //       }
// //       return reply;
// //     } catch (e) {
// //       logger.error(`AI call error (attempt ${attempt + 1}): ${e.message}`);
// //       if (attempt === maxRetries - 1) throw e;
// //       await new Promise(r => setTimeout(r, 3000 * (attempt + 1)));
// //     }
// //   }
// // }

// // // ==================== CONTENT GENERATION ====================
// // async function generateTOC(bookTopic, userId) {
// //   const prompt = `Create a detailed table of contents for a book about "${bookTopic}".
// // Requirements:
// // - EXACTLY 10 chapters with descriptive, unique titles
// // - Each chapter MUST have 3-5 subtopics, indented with "   - "
// // - NO generic names like "Introduction" or "Chapter X"
// // - Format: "1. Title Here\n   - Subtopic 1\n   - Subtopic 2"
// // - NO explanations, NO markdown, just the TOC`;

// //   let attempts = 0;
// //   let lastRaw = '';

// //   while (attempts < 5) {
// //     const genOptions = { maxOutputTokens: 800, temperature: 0.3, topP: 0.8 };
// //     try {
// //       const rawTOC = await askAI(prompt, userId, bookTopic, { saveToHistory: true, genOptions });
// //       lastRaw = rawTOC;
// //       const cleaned = cleanUpAIText(rawTOC);
// //       const parsed = parseTOC(cleaned);

// //       if (parsed.length === 10 && parsed.every(c => c.subtopics.length >= 3)) {
// //         logger.info(`TOC succeeded on attempt ${attempts + 1}`);
// //         return { raw: cleaned, parsed };
// //       }
// //       logger.warn(`TOC invalid – attempt ${attempts + 1}`);
// //     } catch (e) {
// //       logger.error(`TOC AI error – attempt ${attempts + 1}: ${e.message}`);
// //     }
// //     attempts++;
// //   }

// //   logger.warn(`TOC failed after 5 attempts – using fallback for "${bookTopic}"`);
// //   return generateFallbackTOC(bookTopic);
// // }

// // async function generateChapter(bookTopic, chapterNumber, chapterInfo, userId) {
// //   const prompt = `Write Chapter ${chapterNumber}: "${chapterInfo.title}" for a book about "${bookTopic}".
// // CRITICAL FORMATTING RULES:
// // - Start with "## ${chapterInfo.title}" as the main heading
// // - NO "Chapter ${chapterNumber}" prefix in the title
// // - Use proper markdown code fences with language tags: \`\`\`java ... \`\`\`
// // - Use markdown tables (| header | header |) for comparisons
// // - NO trailing asterisks (*) on any lines
// // - NO HTML tags like <header> or <footer>
// // - 400+ words total
// // - Structure:
// //   1) Short intro (50-80 words)
// //   2) ## Concepts — explain key ideas (200-300 words)
// //   3) ## Example 1 — show code with explanation (include fenced code block)
// //   4) ## Example 2 — practical applied snippet
// //   5) ## Exercise — 1 short exercise and "## Solution" with answer
// //   End with "Further reading:" and 2 references.
// // - Incorporate these subsections: ${chapterInfo.subtopics.map(s => `## ${s}`).join('\n')}
// // - Output only the chapter content.`;

// //   return cleanUpAIText(await askAI(prompt, userId, bookTopic, {
// //     minLength: 1500,
// //     genOptions: { maxOutputTokens: 3000, temperature: 0.4 }
// //   }));
// // }

// // async function generateConclusion(bookTopic, chapterInfos, userId) {
// //   const titles = chapterInfos.map(c => c.title).join(', ');
// //   const prompt = `Write conclusion for "${bookTopic}".
// // Summarize: ${titles}
// // Include 3-5 resources with descriptions.
// // 250-300 words, professional tone.`;

// //   return cleanUpAIText(await askAI(prompt, userId, bookTopic, {
// //     minLength: 1000,
// //     genOptions: { maxOutputTokens: 1500, temperature: 0.4 }
// //   }));
// // }

// // // ==================== PDF GENERATION ====================
// // function buildEnhancedHTML(content, bookTitle) {
// //   const cleaned = cleanUpAIText(content);
// //   const formattedContent = formatMath(cleaned);
  
// //   // Extract clean title: remove "Chapter X:" prefix and numbers
// //   const titleMatch = cleaned.match(/^#\s+(.+)$/m);
// //   let displayTitle = titleMatch ? titleMatch[1] : bookTitle;
// //   displayTitle = displayTitle.replace(/^Chapter\s+\d+:\s*/, '').replace(/^\d+\.\s*/, '').trim();

// //   return `<!DOCTYPE html>
// // <html lang="en">
// // <head>
// //   <meta charset="utf-8">
// //   <meta name="viewport" content="width=device-width, initial-scale=1.0">
// //   <title>${displayTitle} - Bookgen.ai</title>
// //   <link rel="preconnect" href="https://fonts.googleapis.com">
// //   <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
// //   <link href="https://fonts.googleapis.com/css2?family=Merriweather:wght@300;400;700&family=Inter:wght:400;600;700&display=swap" rel="stylesheet">
// //   <script>
// //     window.MathJax = {
// //       tex: { inlineMath: [['\\\\(', '\\\\)']], displayMath: [['$$', '$$']] },
// //       svg: { fontCache: 'none', scale: 0.95 }
// //     };
// //   </script>
// //   <script type="text/javascript" id="MathJax-script" async src="https://cdn.jsdelivr.net/npm/mathjax@3/es5/tex-mml-chtml.js"></script>
// //   <script src="https://cdn.jsdelivr.net/npm/prismjs@1.29.0/prism.min.js"></script>
// //   <script src="https://cdn.jsdelivr.net/npm/prismjs@1.29.0/components/prism-javascript.min.js"></script>
// //   <script src="https://cdn.jsdelivr.net/npm/prismjs@1.29.0/components/prism-python.min.js"></script>
// //   <script src="https://cdn.jsdelivr.net/npm/prismjs@1.29.0/components/prism-java.min.js"></script>
// //   <script src="https://cdn.jsdelivr.net/npm/prismjs@1.29.0/components/prism-cpp.min.js"></script>
// //   <link href="https://cdn.jsdelivr.net/npm/prismjs@1.29.0/themes/prism-tomorrow.min.css" rel="stylesheet">
// //   <style>
// //     @page { margin: 90px 70px 80px 70px; size: A4; }
// //     .cover-page { page: cover; }
// //     @page cover { margin: 0; @top-center { content: none; } @bottom-center { content: none; } }
// //     body { font-family: 'Merriweather', Georgia, serif; font-size: 14px; line-height: 1.8; color: #1f2937; background: white; margin: 0; padding: 0; text-align: justify; hyphens: auto; }
// //     .cover-page { display: flex; flex-direction: column; justify-content: center; align-items: center; height: 100vh; page-break-after: always; text-align: center; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; margin: -90px -70px -80px -70px; padding: 70px; }
// //     .cover-title { font-family: 'Inter', sans-serif; font-size: 48px; font-weight: 700; margin-bottom: 0.3em; line-height: 1.2; text-shadow: 2px 2px 4px rgba(0,0,0,0.1); }
// //     .cover-subtitle { font-family: 'Inter', sans-serif; font-size: 24px; font-weight: 300; margin-bottom: 2em; opacity: 0.9; }
// //     .cover-meta { position: absolute; bottom: 60px; font-size: 14px; font-weight: 300; opacity: 0.8; }
// //     .cover-disclaimer { margin-top: 30px; font-size: 12px; color: #fecaca; font-style: italic; }
// //     h1, h2, h3, h4 { font-family: 'Inter', sans-serif; font-weight: 600; color: #1f2937; margin-top: 2.5em; margin-bottom: 0.8em; position: relative; }
// //     h1 { font-size: 28px; border-bottom: 3px solid #667eea; padding-bottom: 15px; margin-top: 0; page-break-before: always; }
// //     h1::after { content: ""; display: block; width: 80px; height: 3px; background: #764ba2; margin-top: 15px; }
// //     h2 { font-size: 22px; border-bottom: 2px solid #e5e7eb; padding-bottom: 8px; color: #4b5563; }
// //     h3 { font-size: 18px; color: #6b7280; }
// //     .chapter-content > h1 + p::first-letter { float: left; font-size: 4em; line-height: 1; margin: 0.1em 0.1em 0 0; font-weight: 700; color: #667eea; font-family: 'Inter', sans-serif; }
// //     code { background: #f3f4f6; padding: 3px 8px; border: 1px solid #e5e7eb; font-family: 'Fira Code', 'Courier New', monospace; font-size: 13px; border-radius: 4px; color: #1e40af; }
// //     pre { background: #1f2937; padding: 20px; overflow-x: auto; border: 1px solid #4b5563; border-radius: 8px; line-height: 1.5; margin: 1.5em 0; white-space: pre-wrap; word-wrap: break-word; box-shadow: 0 4px 6px rgba(0, 0, 0, 0.05); }
// //     pre code { background: none; border: none; padding: 0; color: #e5e7eb; }
// //     blockquote { border-left: 4px solid #667eea; margin: 2em 0; padding: 1em 1.5em; background: linear-gradient(to right, #f3f4f6 0%, #ffffff 100%); font-style: italic; border-radius: 0 8px 8px 0; position: relative; }
// //     blockquote::before { content: """; position: absolute; top: -20px; left: 10px; font-size: 80px; color: #d1d5db; font-family: 'Inter', sans-serif; line-height: 1; }
// //     .example { background: linear-gradient(to right, #eff6ff 0%, #ffffff 100%); border-left: 4px solid #3b82f6; padding: 20px; margin: 2em 0; border-radius: 0 8px 8px 0; font-style: italic; position: relative; }
// //     .example::before { content: "💡 Example"; display: block; font-weight: 600; color: #1d4ed8; margin-bottom: 10px; font-style: normal; }
// //     table { width: 100%; border-collapse: collapse; margin: 2em 0; box-shadow: 0 1px 3px rgba(0, 0, 0, 0.1); }
// //     th { background: #374151; color: white; padding: 12px; text-align: left; font-family: 'Inter', sans-serif; font-weight: 600; }
// //     td { padding: 12px; border-bottom: 1px solid #e5e7eb; }
// //     tr:nth-child(even) { background: #f9fafb; }
// //     .MathJax_Display { margin: 2em 0 !important; padding: 1em 0; overflow-x: auto; }
// //     .disclaimer-footer { margin-top: 4em; padding-top: 2em; border-top: 2px solid #e5e7eb; font-size: 12px; color: #6b7280; font-style: italic; text-align: center; }
// //   </style>
// // </head>
// // <body>
// //   <div class="cover-page">
// //     <div class="cover-content">
// //       <h1 class="cover-title">${displayTitle}</h1>
// //       <h2 class="cover-subtitle">A Beginner's Guide</h2>
// //       <div class="cover-disclaimer">⚠️ Caution: AI-generated content may contain errors</div>
// //     </div>
// //     <div class="cover-meta">Generated by Bookgen.ai<br>${new Date().toLocaleDateString()}</div>
// //   </div>
// //   <div class="chapter-content">${marked.parse(formattedContent)}</div>
// //   <div class="disclaimer-footer">This book was generated by AI for educational purposes. Please verify all information independently.</div>
// //   <script>document.addEventListener('DOMContentLoaded', () => { Prism.highlightAll(); });</script>
// // </body>
// // </html>`;
// // }

// // async function generatePDF(content, outputPath, bookTitle) {
// //   try {
// //     const enhancedHtml = buildEnhancedHTML(content, bookTitle);
    
// //     const form = new FormData();
// //     const instructions = {
// //       parts: [{ html: "index.html" }],
// //       output: {
// //         format: "pdf",
// //         pdf: {
// //           margin: { top: "90px", bottom: "80px", left: "70px", right: "70px" },
// //           header: {
// //             content: '<div style="font-size: 10px; text-align: center; width: 100%; color: #6b7280;">Generated by bookgen.ai</div>',
// //             spacing: "5mm"
// //           },
// //           footer: {
// //             content: '<div style="font-size: 10px; text-align: center; width: 100%; color: #6b7280;">Page {pageNumber}</div>',
// //             spacing: "5mm"
// //           },
// //           waitDelay: 3000,
// //           printBackground: true,
// //           preferCSSPageSize: true
// //         }
// //       }
// //     };
    
// //     form.append('instructions', JSON.stringify(instructions));
// //     form.append('index.html', Buffer.from(enhancedHtml), {
// //       filename: 'index.html',
// //       contentType: 'text/html'
// //     });

// //     const response = await fetch('https://api.nutrient.io/build', {
// //       method: 'POST',
// //       headers: { 'Authorization': `Bearer ${NUTRIENT_API_KEY}` },
// //       body: form
// //     });

// //     if (!response.ok) {
// //       const errorText = await response.text();
// //       throw new Error(`Nutrient API error: ${response.status} - ${errorText}`);
// //     }

// //     const pdfBuffer = await response.buffer();
// //     fs.writeFileSync(outputPath, pdfBuffer);
// //     logger.info(`✅ PDF generated: ${outputPath}`);
// //     return outputPath;
// //   } catch (error) {
// //     logger.error(`❌ PDF generation failed: ${error.message}`);
// //     throw error;
// //   }
// // }

// // // ==================== MAIN GENERATOR ====================
// // export async function generateBookMedd(rawTopic, userId) {
// //   const bookTopic = rawTopic.replace(/^(generate|create|write)( me)? (a book )?(about )?/i, '').trim();
// //   const safeUserId = `${userId}-${bookTopic.replace(/\s+/g, '_').toLowerCase().slice(0, 50)}`;
// //   logger.info(`=== Starting: "${bookTopic}" for ${safeUserId} ===`);

// //   try {
// //     userHistories.delete(safeUserId);
// //     const { raw: tocRaw, parsed: chapterInfos } = await generateTOC(bookTopic, safeUserId);
    
// //     const tocFile = path.join(OUTPUT_DIR, `${CHAPTER_PREFIX}-${safeUserId}-toc.txt`);
// //     saveToFile(tocFile, `# Table of Contents\n\n${tocRaw}\n\n---\n`);
// //     const files = [tocFile];

// //     // Generate chapters
// //     logger.info('Step 2/3: Generating chapters...');
// //     for (let i = 0; i < chapterInfos.length; i++) {
// //       if (global.cancelFlags?.[safeUserId]) {
// //         delete global.cancelFlags[safeUserId];
// //         throw new Error('Generation cancelled');
// //       }

// //       const chNum = i + 1;
// //       const info = chapterInfos[i];
// //       logger.info(` ${chNum}. ${info.title}`);
      
// //       const chapter = await generateChapter(bookTopic, chNum, info, safeUserId);
// //       const txt = `\n<div class="chapter-break"></div>\n\n# Chapter ${chNum}: ${info.title}\n\n${chapter}\n\n---\n`;
      
// //       const f = path.join(OUTPUT_DIR, `${CHAPTER_PREFIX}-${safeUserId}-${chNum}.txt`);
// //       saveToFile(f, txt);
// //       files.push(f);
// //     }

// //     // Generate conclusion
// //     logger.info('Step 3/3: Generating conclusion...');
// //     const conclusion = await generateConclusion(bookTopic, chapterInfos, safeUserId);
// //     const conclFile = path.join(OUTPUT_DIR, `${CHAPTER_PREFIX}-${safeUserId}-conclusion.txt`);
// //     saveToFile(conclFile, `\n<div class="chapter-break"></div>\n\n# Conclusion\n\n${conclusion}\n`);
// //     files.push(conclFile);

// //     // Combine and generate PDF
// //     logger.info('Combining content and generating PDF...');
// //     const combined = files.map(f => fs.readFileSync(f, 'utf8')).join('\n');
// //     const safeName = bookTopic.slice(0, 30).replace(/\s+/g, '_');
// //     const pdfPath = path.join(OUTPUT_DIR, `book_${safeUserId}_${safeName}.pdf`);
    
// //     await generatePDF(combined, pdfPath, bookTopic);

// //     // Cleanup
// //     files.forEach(deleteFile);
// //     userHistories.delete(safeUserId);
    
// //     logger.info(`=== SUCCESS: ${pdfPath} ===`);
// //     return pdfPath;
// //   } catch (e) {
// //     logger.error(`❌ Failed: ${e.message}`);
// //     throw e;
// //   }
// // }

// // // ==================== QUEUE SYSTEM ====================
// // const bookQueue = async.queue(async (task, callback) => {
// //   try {
// //     const result = await generateBookMedd(task.bookTopic, task.userId);
// //     callback(null, result);
// //   } catch (error) {
// //     callback(error);
// //   }
// // }, 1);

// // export function queueBookGeneration(bookTopic, userId) {
// //   return new Promise((resolve, reject) => {
// //     bookQueue.push({ bookTopic, userId }, (error, result) => {
// //       if (error) reject(error);
// //       else resolve(result);
// //     });
// //   });
// // }
















// // import { GoogleGenerativeAI } from '@google/generative-ai';
// // import { marked } from 'marked';
// // import hljs from 'highlight.js';
// // import fs from 'fs';
// // import path from 'path';
// // import { fileURLToPath } from 'url';
// // import { dirname } from 'path';
// // import async from 'async';
// // import winston from 'winston';
// // import fetch from 'node-fetch';
// // import FormData from 'form-data';

// // const __filename = fileURLToPath(import.meta.url);
// // const __dirname = dirname(__filename);

// // // Constants
// // const HISTORY_DIR = path.join(__dirname, 'history');
// // const CHAPTER_PREFIX = 'chapter';
// // const OUTPUT_DIR = path.join(__dirname, '../pdfs');
// // const COMBINED_FILE = 'combined-chapters.txt';

// // // Google AI Setup (CHANGED)
// // const genAI = new GoogleGenerativeAI('AIzaSyB1mzRKeAnsV__6yxngqgx2pSjuMTGwruo');
// // const MODEL_NAME = 'gemini-2.5-flash';

// // // Rate Limiter (NEW)
// // class RateLimiter {
// //   constructor(requestsPerMinute) {
// //     this.requestsPerMinute = requestsPerMinute;
// //     this.requests = [];
// //   }

// //   async wait() {
// //     const now = Date.now();
// //     this.requests = this.requests.filter(time => now - time < 60000);
// //     if (this.requests.length >= this.requestsPerMinute) {
// //       const oldest = this.requests[0];
// //       const waitTime = 60000 - (now - oldest) + 1000;
// //       await new Promise(resolve => setTimeout(resolve, waitTime));
// //       return this.wait();
// //     }
// //     this.requests.push(now);
// //   }
// // }

// // const globalRateLimiter = new RateLimiter(15);

// // // Logger
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
// //       "Your name is Hailu. You are a kind, smart teacher explaining to a curious person. Use simple, clear words, break down complex ideas step-by-step, and include human-like examples. Always start with a table of contents, then write chapters. Focus only on the requested topic, ignore unrelated contexts. Table of Contents:\n\n" +
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

// // // === AI === (CHANGED - Google AI instead of Together)
// // async function askAI(prompt, userId, bookTopic) {
// //   await globalRateLimiter.wait(); // Rate limit

// //   const history = userHistories.get(userId) || [];
// //   const trimmedHistory = trimHistory(history);

// //   // Convert to Google AI format
// //   const model = genAI.getGenerativeModel({
// //     model: MODEL_NAME,
// //     generationConfig: {
// //       maxOutputTokens: 4000,
// //       temperature: 0.6,
// //       topP: 0.9,
// //     },
// //   });

// //   const chat = model.startChat({
// //     history: trimmedHistory.map(msg => ({
// //       role: msg.role === 'assistant' ? 'model' : 'user',
// //       parts: [{ text: msg.content }]
// //     })),
// //   });

// //   try {
// //     const result = await chat.sendMessage(prompt);
// //     let reply = result.response.text();

// //     // Relevance check
// //     const topicWords = bookTopic.toLowerCase().split(/\s+/);
// //     const isRelevant = topicWords.some(word => reply.toLowerCase().includes(word));

// //     if (!isRelevant) {
// //       logger.warn(`🛑 Irrelevant output detected for [${userId}]: ${reply.slice(0, 80)}...`);
// //       throw new Error(`Output does not appear relevant to topic: "${bookTopic}"`);
// //     }

// //     // Save history
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
// //     .replace(/([a-zA-Z0-9]+)\s*\^\s*([a-zA-Z0-9]+)/g, (_, base, exp) => `\\(${base}^{${exp}}\\)`)
// //     .replace(/(?<!\\)(?<!\w)(\d+)\s*\/\s*(\d+)(?!\w)/g, (_, num, den) => `\\(\\frac{${num}}{${den}}\\)`);

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

// // // === PDF Generation (UNCHANGED - using Nutrient) ===
// // async function generatePDF(content, outputPath) {
// //   const cleaned = cleanUpAIText(content);
// //   const formattedContent = formatMath(cleaned);

// //   const titleMatch = cleaned.match(/^#\s+(.+)$/m);
// //   const bookTitle = titleMatch ? titleMatch[1] : 'AI Generated Book';

// //   const enhancedHtml = `
// //   <!DOCTYPE html>
// //   <html lang="en">
// //     <head>
// //       <meta charset="utf-8">
// //       <meta name="viewport" content="width=device-width, initial-scale=1.0">
// //       <title>${bookTitle} - Bookgen.ai</title>
// //       <link rel="preconnect" href="https://fonts.googleapis.com">
// //       <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
// //       <link href="https://fonts.googleapis.com/css2?family=Merriweather:wght@300;400;700&family=Inter:wght@400;600;700&display=swap" rel="stylesheet">
// //       <script>
// //       window.MathJax = {
// //         tex: {
// //           inlineMath: [['\\\\(', '\\\\)']],
// //           displayMath: [['$$', '$$']],
// //         },
// //         svg: { fontCache: 'none', scale: 0.95 }
// //       };
// //       </script>
// //       <script type="text/javascript" id="MathJax-script" async
// //         src="https://cdn.jsdelivr.net/npm/mathjax@3/es5/tex-mml-chtml.js">
// //       </script>
// //       <script src="https://cdn.jsdelivr.net/npm/prismjs@1.29.0/prism.min.js"></script>
// //       <script src="https://cdn.jsdelivr.net/npm/prismjs@1.29.0/components/prism-javascript.min.js"></script>
// //       <script src="https://cdn.jsdelivr.net/npm/prismjs@1.29.0/components/prism-python.min.js"></script>
// //       <script src="https://cdn.jsdelivr.net/npm/prismjs@1.29.0/components/prism-java.min.js"></script>
// //       <script src="https://cdn.jsdelivr.net/npm/prismjs@1.29.0/components/prism-cpp.min.js"></script>
// //       <link href="https://cdn.jsdelivr.net/npm/prismjs@1.29.0/themes/prism-tomorrow.min.css" rel="stylesheet">
// //       <style>
// //         @page { margin: 90px 70px 80px 70px; size: A4; }
// //         .cover-page { page: cover; }
// //         @page cover { margin: 0; @top-center { content: none; } @bottom-center { content: none; } }
// //         body { font-family: 'Merriweather', Georgia, serif; font-size: 14px; line-height: 1.8; color: #1f2937; background: white; margin: 0; padding: 0; text-align: justify; hyphens: auto; }
// //         .cover-page { display: flex; flex-direction: column; justify-content: center; align-items: center; height: 100vh; page-break-after: always; text-align: center; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; margin: -90px -70px -80px -70px; padding: 70px; }
// //         .cover-title { font-family: 'Inter', sans-serif; font-size: 48px; font-weight: 700; margin-bottom: 0.3em; line-height: 1.2; text-shadow: 2px 2px 4px rgba(0,0,0,0.1); }
// //         .cover-subtitle { font-family: 'Inter', sans-serif; font-size: 24px; font-weight: 300; margin-bottom: 2em; opacity: 0.9; }
// //         .cover-meta { position: absolute; bottom: 60px; font-size: 14px; font-weight: 300; opacity: 0.8; }
// //         .cover-disclaimer { margin-top: 30px; font-size: 12px; color: #fecaca; font-style: italic; }
// //         h1, h2, h3, h4 { font-family: 'Inter', sans-serif; font-weight: 600; color: #1f2937; margin-top: 2.5em; margin-bottom: 0.8em; position: relative; }
// //         h1 { font-size: 28px; border-bottom: 3px solid #667eea; padding-bottom: 15px; margin-top: 0; page-break-before: always; }
// //         h1::after { content: ""; display: block; width: 80px; height: 3px; background: #764ba2; margin-top: 15px; }
// //         h2 { font-size: 22px; border-bottom: 2px solid #e5e7eb; padding-bottom: 8px; color: #4b5563; }
// //         h3 { font-size: 18px; color: #6b7280; }
// //         .chapter-content > h1 + p::first-letter { float: left; font-size: 4em; line-height: 1; margin: 0.1em 0.1em 0 0; font-weight: 700; color: #667eea; font-family: 'Inter', sans-serif; }
// //         code { background: #f3f4f6; padding: 3px 8px; border: 1px solid #e5e7eb; font-family: 'Fira Code', 'Courier New', monospace; font-size: 13px; border-radius: 4px; color: #1e40af; }
// //         pre { background: #1f2937; padding: 20px; overflow-x: auto; border: 1px solid #4b5563; border-radius: 8px; line-height: 1.5; margin: 1.5em 0; white-space: pre-wrap; word-wrap: break-word; box-shadow: 0 4px 6px rgba(0, 0, 0, 0.05); }
// //         pre code { background: none; border: none; padding: 0; color: #e5e7eb; }
// //         blockquote { border-left: 4px solid #667eea; margin: 2em 0; padding: 1em 1.5em; background: linear-gradient(to right, #f3f4f6 0%, #ffffff 100%); font-style: italic; border-radius: 0 8px 8px 0; position: relative; }
// //         blockquote::before { content: """; position: absolute; top: -20px; left: 10px; font-size: 80px; color: #d1d5db; font-family: 'Inter', sans-serif; line-height: 1; }
// //         .example { background: linear-gradient(to right, #eff6ff 0%, #ffffff 100%); border-left: 4px solid #3b82f6; padding: 20px; margin: 2em 0; border-radius: 0 8px 8px 0; font-style: italic; position: relative; }
// //         .example::before { content: "💡 Example"; display: block; font-weight: 600; color: #1d4ed8; margin-bottom: 10px; font-style: normal; }
// //         table { width: 100%; border-collapse: collapse; margin: 2em 0; box-shadow: 0 1px 3px rgba(0, 0, 0, 0.1); }
// //         th { background: #374151; color: white; padding: 12px; text-align: left; font-family: 'Inter', sans-serif; font-weight: 600; }
// //         td { padding: 12px; border-bottom: 1px solid #e5e7eb; }
// //         tr:nth-child(even) { background: #f9fafb; }
// //         .MathJax_Display { margin: 2em 0 !important; padding: 1em 0; overflow-x: auto; }
// //         .disclaimer-footer { margin-top: 4em; padding-top: 2em; border-top: 2px solid #e5e7eb; font-size: 12px; color: #6b7280; font-style: italic; text-align: center; }
// //       </style>
// //     </head>
// //     <body>
// //       <div class="cover-page">
// //         <div class="cover-content">
// //           <h1 class="cover-title">${bookTitle}</h1>
// //           <h2 class="cover-subtitle">A Beginner's Guide</h2>
// //           <div class="cover-disclaimer">⚠️ Caution: AI-generated content may contain errors</div>
// //         </div>
// //         <div class="cover-meta">Generated by Bookgen.ai<br>${new Date().toLocaleDateString()}</div>
// //       </div>
// //       <div class="chapter-content">${marked.parse(formattedContent)}</div>
// //       <div class="disclaimer-footer">This book was generated by AI for educational purposes. Please verify all information independently.</div>
// //       <script>document.addEventListener('DOMContentLoaded', () => { Prism.highlightAll(); });</script>
// //     </body>
// //   </html>
// //   `;

// //   try {
// //     const apiKey = 'pdf_live_162WJVSTDmuCQGjksJJXoxrbipwxrHteF8cXC9Z71gC';
    
// //     const formData = new FormData();
// //     const instructions = {
// //       parts: [{ html: "index.html" }],
// //       output: {
// //         format: "pdf",
// //         pdf: {
// //           margin: {
// //             top: "90px",
// //             bottom: "80px",
// //             left: "70px",
// //             right: "70px"
// //           },
// //           header: {
// //             content: '<div style="font-size: 10px; text-align: center; width: 100%; color: #6b7280;">Generated by bookgen.ai</div>',
// //             spacing: "5mm"
// //           },
// //           footer: {
// //             content: '<div style="font-size: 10px; text-align: center; width: 100%; color: #6b7280;">Page {pageNumber}</div>',
// //             spacing: "5mm"
// //           },
// //           waitDelay: 3000,
// //           printBackground: true,
// //           preferCSSPageSize: true
// //         }
// //       }
// //     };
    
// //     formData.append('instructions', JSON.stringify(instructions));
// //     formData.append('index.html', Buffer.from(enhancedHtml), {
// //       filename: 'index.html',
// //       contentType: 'text/html'
// //     });

// //     const response = await fetch('https://api.nutrient.io/build', {
// //       method: 'POST',
// //       headers: {
// //         'Authorization': `Bearer ${apiKey}`
// //       },
// //       body: formData
// //     });

// //     if (!response.ok) {
// //       const errorText = await response.text();
// //       throw new Error(`Nutrient API error: ${response.status} - ${errorText}`);
// //     }

// //     const pdfBuffer = await response.buffer();
// //     fs.writeFileSync(outputPath, pdfBuffer);
// //     logger.info(`✅ Generated premium PDF: ${outputPath}`);
// //     return outputPath;

// //   } catch (error) {
// //     logger.error(`❌ PDF generation failed: ${error.message}`);
// //     throw error;
// //   }
// // }

// // // === Prompt Generator ===
// // function generatePrompts(bookTopic) {
// //   return [
// //     `As Hailu, you are going to follow this instruction that i will gave you. You must work with them for best out put. First write the title for the book then create a table of contents for a book about "${bookTopic}" for someone with no prior knowledge. The book must have 10 chapters, each covering a unique aspect of ${bookTopic} (e.g., for trading bots: what they are, how they work, strategies, risks, tools). Each chapter must be at least 400 words and written in a fun, simple, friendly tone, like explaining to a curious 16-year-old. Use clear, descriptive chapter titles and include more than 2–3 subtopics per chapter (e.g., "What is a trading bot?" or "How do trading bots make decisions?"). Output only the table of contents as a numbered list with chapter titles and subtopics. Ensure topics are distinct, avoid overlap, and focus strictly on ${bookTopic}. If ${bookTopic} is unclear, suggest relevant subtopics and explain why. Ignore any unrelated topics like space or previous requests. Remeber After you finish what you have been told you are goinig to stop after you finish creating the table of content you are done don't respond any more.`,

// //     `As Hailu,you are going to follow this instruction that i will gave you. You write Chapter 1 of the book about "${bookTopic}", based on the table of contents you created. Focus only on the first chapter's topic and subtopics. Use a fun, simple, friendly tone, like explaining to a curious 16-year-old. Break down complex ideas into clear steps with vivid examples (e.g., for trading bots, compare them to a robot chef following a recipe) and if it seem important use one analogy per subtopic. Include a description of a diagram or table (e.g., "a diagram showing how a trading bot works") to aid understanding. Use clear headings for each subtopic. Write at least 400 words, avoid copyrighted material, ensure accuracy, and focus only on ${bookTopic} chapter one from the table of content. If information is limited, explain in simple terms and note limitations. Do not include the table of contents, other chapters, or unrelated topics like space please only write chapter one after you are done writting chapter one stop responding.`,

// //     `As Hailu,you are going to follow this instruction that i will gave you. Now you write Chapter 2 of the book about "${bookTopic}", based on the table of contents you created. Focus only on the second chapter's topic and subtopics. Use a fun, simple, friendly tone, like explaining to a curious 16-year-old. Break down complex ideas into clear steps with vivid examples (e.g., for trading bots, compare them to a robot chef following a recipe) and if it seem important use one analogy per subtopic. Include a description of a diagram or table (e.g., "a diagram showing how a trading bot works") to aid understanding. Use clear headings for each subtopic. Write at least 400 words, avoid copyrighted material, ensure accuracy, and focus only on ${bookTopic} chapter two from the table of content. If information is limited, explain in simple terms and note limitations. Do not include the table of contents, other chapters, or unrelated topics like space please only write chapter two after you are done writting chapter two stop responding.`,

// //     `As Hailu,you are going to follow this instruction that i will gave you. You write Chapter 3 of the book about "${bookTopic}", based on the table of contents you created. Focus only on the third chapter's topic and subtopics. Use a fun, simple, friendly tone, like explaining to a curious 16-year-old. Break down complex ideas into clear steps with vivid examples (e.g., for trading bots, compare them to a robot chef following a recipe) and if it seem important use one analogy per subtopic. Include a description of a diagram or table (e.g., "a diagram showing how a trading bot works") to aid understanding. Use clear headings for each subtopic. Write at least 400 words, avoid copyrighted material, ensure accuracy, and focus only on ${bookTopic} chapter three from the table of content. If information is limited, explain in simple terms and note limitations. Do not include the table of contents, other chapters, or unrelated topics like space please only write chapter three after you are done writting chapter three stop responding.`,
    
// //     `As Hailu,you are going to follow this instruction that i will gave you. You write Chapter 4 of the book about "${bookTopic}", based on the table of contents you created. Focus only on the fourth chapter's topic and subtopics. Use a fun, simple, friendly tone, like explaining to a curious 16-year-old. Break down complex ideas into clear steps with vivid examples (e.g., for trading bots, compare them to a robot chef following a recipe) and if it seem important use one analogy per subtopic. Include a description of a diagram or table (e.g., "a diagram showing how a trading bot works") to aid understanding. Use clear headings for each subtopic. Write at least 400 words, avoid copyrighted material, ensure accuracy, and focus only on ${bookTopic} chapter four from the table of content. If information is limited, explain in simple terms and note limitations. Do not include the table of contents, other chapters, or unrelated topics like space please only write chapter four after you are done writting chapter four stop responding.`,
    
// //     `As Hailu,you are going to follow this instruction that i will gave you. You write Chapter 5 of the book about "${bookTopic}", based on the table of contents you created. Focus only on the fifith chapter's topic and subtopics. Use a fun, simple, friendly tone, like explaining to a curious 16-year-old. Break down complex ideas into clear steps with vivid examples (e.g., for trading bots, compare them to a robot chef following a recipe) and if it seem important use one analogy per subtopic. Include a description of a diagram or table (e.g., "a diagram showing how a trading bot works") to aid understanding. Use clear headings for each subtopic. Write at least 400 words, avoid copyrighted material, ensure accuracy, and focus only on ${bookTopic} chapter five from the table of content. If information is limited, explain in simple terms and note limitations. Do not include the table of contents, other chapters, or unrelated topics like space please only write chapter five after you are done writting chapter five stop responding.`,
    
// //     `As Hailu,you are going to follow this instruction that i will gave you. You write Chapter 6 of the book about "${bookTopic}", based on the table of contents you created. Focus only on the sixth chapter's topic and subtopics. Use a fun, simple, friendly tone, like explaining to a curious 16-year-old. Break down complex ideas into clear steps with vivid examples (e.g., for trading bots, compare them to a robot chef following a recipe) and if it seem important use one analogy per subtopic. Include a description of a diagram or table (e.g., "a diagram showing how a trading bot works") to aid understanding. Use clear headings for each subtopic. Write at least 400 words, avoid copyrighted material, ensure accuracy, and focus only on ${bookTopic} chapter six from the table of content. If information is limited, explain in simple terms and note limitations. Do not include the table of contents, other chapters, or unrelated topics like space please only write chapter six after you are done writting chapter six stop responding.`,    

// //     `As Hailu,you are going to follow this instruction that i will gave you. You write Chapter 7 of the book about "${bookTopic}", based on the table of contents you created. Focus only on the seventh chapter's topic and subtopics. Use a fun, simple, friendly tone, like explaining to a curious 16-year-old. Break down complex ideas into clear steps with vivid examples (e.g., for trading bots, compare them to a robot chef following a recipe) and if it seem important use one analogy per subtopic. Include a description of a diagram or table (e.g., "a diagram showing how a trading bot works") to aid understanding. Use clear headings for each subtopic. Write at least 400 words, avoid copyrighted material, ensure accuracy, and focus only on ${bookTopic} chapter seven from the table of content. If information is limited, explain in simple terms and note limitations. Do not include the table of contents, other chapters, or unrelated topics like space please only write chapter seven after you are done writting chapter seven stop responding.`,
    
// //     `As Hailu,you are going to follow this instruction that i will gave you. You write Chapter 8 of the book about "${bookTopic}", based on the table of contents you created. Focus only on the eightth chapter's topic and subtopics. Use a fun, simple, friendly tone, like explaining to a curious 16-year-old. Break down complex ideas into clear steps with vivid examples (e.g., for trading bots, compare them to a robot chef following a recipe) and if it seem important use one analogy per subtopic. Include a description of a diagram or table (e.g., "a diagram showing how a trading bot works") to aid understanding. Use clear headings for each subtopic. Write at least 400 words, avoid copyrighted material, ensure accuracy, and focus only on ${bookTopic} chapter eight from the table of content. If information is limited, explain in simple terms and note limitations. Do not include the table of contents, other chapters, or unrelated topics like space please only write chapter eight after you are done writting chapter eight stop responding.`,

// //     `As Hailu,you are going to follow this instruction that i will gave you. You write Chapter 9 of the book about "${bookTopic}", based on the table of contents you created. Focus only on the nineth chapter's topic and subtopics. Use a fun, simple, friendly tone, like explaining to a curious 16-year-old. Break down complex ideas into clear steps with vivid examples (e.g., for trading bots, compare them to a robot chef following a recipe) and if it seem important use one analogy per subtopic. Include a description of a diagram or table (e.g., "a diagram showing how a trading bot works") to aid understanding. Use clear headings for each subtopic. Write at least 400 words, avoid copyrighted material, ensure accuracy, and focus only on ${bookTopic} chapter nine from the table of content. If information is limited, explain in simple terms and note limitations. Do not include the table of contents, other chapters, or unrelated topics like space please only write chapter nine after you are done writting chapter nine stop responding.`,
    
// //     `As Hailu,you are going to follow this instruction that i will gave you. You write Chapter 10 of the book about "${bookTopic}", based on the table of contents you created. Focus only on the tenth chapter's topic and subtopics. Use a fun, simple, friendly tone, like explaining to a curious 16-year-old. Break down complex ideas into clear steps with vivid examples (e.g., for trading bots, compare them to a robot chef following a recipe) and if it seem important use one analogy per subtopic. Include a description of a diagram or table (e.g., "a diagram showing how a trading bot works") to aid understanding. Use clear headings for each subtopic. Write at least 400 words, avoid copyrighted material, ensure accuracy, and focus only on ${bookTopic} chapter ten from the table of content. If information is limited, explain in simple terms and note limitations. Do not include the table of contents, other chapters, or unrelated topics like space please only write chapter ten after you are done writting chapter ten stop responding.`,
    
// //     `As Hailu, write the conclusion and references for the book about "${bookTopic}", based on the table of contents and chapters you created. Use a fun, simple, friendly tone, like explaining to a curious 19-year-old. In the conclusion (200–300 words), summarize the key ideas from all chapters and inspire the reader to learn more about ${bookTopic}. In the references section, provide 3–5 reliable, beginner-friendly resources (e.g., for trading bots: Investopedia, Python libraries, or educational videos) with a 1–2 sentence description each. Use clear headings ("Conclusion" and "References"). Avoid copyrighted material, ensure resources are accessible and appropriate for beginners, and focus only on ${bookTopic}. If resources are limited, suggest general learning platforms and explain why. Do not include the table of contents, chapter content, or unrelated topics like space.`
// //   ];
// // }

// // // === Task Queue ===
// // const bookQueue = async.queue(async (task, callback) => {
// //   try {
// //     const { bookTopic, userId } = task;
// //     await generateBookMedd(bookTopic, userId);
// //     callback();
// //   } catch (error) {
// //     callback(error);
// //   }
// // }, 1); // Process one book at a time

// // // === Master Function ===
// // export async function generateBookMedd(bookTopic, userId) {
// //   const safeUserId = `${userId}-${bookTopic.replace(/\s+/g, '_').toLowerCase()}`;
// //   logger.info(`Starting book generation for user: ${safeUserId}, topic: ${bookTopic}`);

// //   try {
// //     global.cancelFlags = global.cancelFlags || {};

// //     userHistories.set(safeUserId, [{
// //       role: "system",
// //       content:
// //         "Your name is Hailu. You are a kind, smart teacher explaining to a curious person. Use simple, clear words, break down complex ideas step-by-step, and include human-like examples. Always start with a table of contents, then write chapters. Focus only on the requested topic, ignore unrelated contexts."
// //     }]);

// //     const prompts = generatePrompts(bookTopic);
// //     const chapterFiles = [];

// //     // Generate chapters with delays
// //     for (let i = 0; i < prompts.length; i++) {
// //       if (global.cancelFlags?.[userId]) {
// //         delete global.cancelFlags[userId];
// //         logger.warn(`❌ Book generation cancelled for user: ${userId}`);
// //         throw new Error('Generation cancelled');
// //       }

// //       const chapterNum = i + 1;
// //       logger.info(`Generating Chapter ${chapterNum} for ${bookTopic}`);
// //       const file = await generateChapter(prompts[i], chapterNum, safeUserId, bookTopic);
// //       chapterFiles.push(file);

// //       // Add delay between requests (4 seconds = 15 req/min max)
// //       if (i < prompts.length - 1) {
// //         logger.info(`Rate limit delay: 4 seconds...`);
// //         await new Promise(resolve => setTimeout(resolve, 6000));
// //       }
// //     }

// //     const combinedContent = combineChapters(chapterFiles);

// //     const safeTopic = bookTopic.slice(0, 20).replace(/\s+/g, "_");
// //     const fileName = `output_${safeUserId}_${safeTopic}.pdf`;
// //     const outputPath = path.join(OUTPUT_DIR, fileName);
// //     await generatePDF(combinedContent, outputPath);

// //     chapterFiles.forEach(deleteFile);
// //     userHistories.delete(safeUserId);

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
// // }

























// // import { Together } from "together-ai";
// // import { marked } from 'marked';
// // import hljs from 'highlight.js';
// // import fs from 'fs';
// // import path from 'path';
// // import { fileURLToPath } from 'url';
// // import { dirname } from 'path';
// // import async from 'async';
// // import winston from 'winston';
// // import fetch from 'node-fetch';
// // import FormData from 'form-data';

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

// // // Init Together AI
// // const together = new Together({
// //   apiKey: process.env.TOGETHER_API_KEY || '18a96a823e402ef5dfedc1e372bf50fc8e6357bb25a0eff0bea25a07f51a1087',
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
// //       "Your name is Hailu. You are a kind, smart teacher explaining to a curious person. Use simple, clear words, break down complex ideas step-by-step, and include human-like examples. Always start with a table of contents, then write chapters. Focus only on the requested topic, ignore unrelated contexts. Table of Contents:\n\n" +
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
// //       top_p: 0.9,
// //       temperature: 0.6,
// //       presence_penalty: 0.3,
// //       frequency_penalty: 0.3,
// //       max_tokens: 4000
// //     });

// //     let reply = response.choices[0].message.content
// //       .replace(/<think>[\s\S]*?<\/think>/gi, '')
// //       .replace(/^I'm DeepSeek-R1.*?help you\.\s*/i, '')
// //       .trim();

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
// //     .replace(/([a-zA-Z0-9]+)\s*\^\s*([a-zA-Z0-9]+)/g, (_, base, exp) => `\\(${base}^{${exp}}\\)`)
// //     .replace(/(?<!\\)(?<!\w)(\d+)\s*\/\s*(\d+)(?!\w)/g, (_, num, den) => `\\(\\frac{${num}}{${den}}\\)`);

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
// //   const formattedContent = formatMath(cleaned);

// //   // Extract title from first H1
// //   const titleMatch = cleaned.match(/^#\s+(.+)$/m);
// //   const bookTitle = titleMatch ? titleMatch[1] : 'AI Generated Book';

// //   const enhancedHtml = `
// //   <!DOCTYPE html>
// //   <html lang="en">
// //     <head>
// //       <meta charset="utf-8">
// //       <meta name="viewport" content="width=device-width, initial-scale=1.0">
// //       <title>${bookTitle} - Bookgen.ai</title>
      
// //       <!-- Premium Typography -->
// //       <link rel="preconnect" href="https://fonts.googleapis.com">
// //       <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
// //       <link href="https://fonts.googleapis.com/css2?family=Merriweather:wght@300;400;700&family=Inter:wght@400;600;700&display=swap" rel="stylesheet">
      
// //       <!-- MathJax -->
// //       <script>
// //       window.MathJax = {
// //         tex: {
// //           inlineMath: [['\\\\(', '\\\\)']],
// //           displayMath: [['$$', '$$']],
// //         },
// //         svg: { fontCache: 'none', scale: 0.95 }
// //       };
// //       </script>
// //       <script type="text/javascript" id="MathJax-script" async
// //         src="https://cdn.jsdelivr.net/npm/mathjax@3/es5/tex-mml-chtml.js">
// //       </script>
      
// //       <!-- Prism.js -->
// //       <script src="https://cdn.jsdelivr.net/npm/prismjs@1.29.0/prism.min.js"></script>
// //       <script src="https://cdn.jsdelivr.net/npm/prismjs@1.29.0/components/prism-javascript.min.js"></script>
// //       <script src="https://cdn.jsdelivr.net/npm/prismjs@1.29.0/components/prism-python.min.js"></script>
// //       <script src="https://cdn.jsdelivr.net/npm/prismjs@1.29.0/components/prism-java.min.js"></script>
// //       <script src="https://cdn.jsdelivr.net/npm/prismjs@1.29.0/components/prism-cpp.min.js"></script>
// //       <link href="https://cdn.jsdelivr.net/npm/prismjs@1.29.0/themes/prism-tomorrow.min.css" rel="stylesheet">
      
// //       <style>
// //         /* === PREMIUM PRINT STYLES === */
        
// //         @page { 
// //           margin: 90px 70px 80px 70px;
// //           size: A4;
// //         }
        
// //         /* Hide header/footer on cover page */
// //         .cover-page {
// //           page: cover;
// //         }
        
// //         @page cover {
// //           margin: 0;
// //           @top-center { content: none; }
// //           @bottom-center { content: none; }
// //         }
        
// //         /* Typography */
// //         body { 
// //           font-family: 'Merriweather', Georgia, serif; 
// //           font-size: 14px; 
// //           line-height: 1.8; 
// //           color: #1f2937; 
// //           background: white; 
// //           margin: 0; 
// //           padding: 0; 
// //           text-align: justify;
// //           hyphens: auto;
// //         }
        
// //         /* === COVER PAGE === */
// //         .cover-page {
// //           display: flex;
// //           flex-direction: column;
// //           justify-content: center;
// //           align-items: center;
// //           height: 100vh;
// //           page-break-after: always;
// //           text-align: center;
// //           background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
// //           color: white;
// //           margin: -90px -70px -80px -70px;
// //           padding: 70px;
// //         }
        
// //         .cover-title {
// //           font-family: 'Inter', sans-serif;
// //           font-size: 48px;
// //           font-weight: 700;
// //           margin-bottom: 0.3em;
// //           line-height: 1.2;
// //           text-shadow: 2px 2px 4px rgba(0,0,0,0.1);
// //         }
        
// //         .cover-subtitle {
// //           font-family: 'Inter', sans-serif;
// //           font-size: 24px;
// //           font-weight: 300;
// //           margin-bottom: 2em;
// //           opacity: 0.9;
// //         }
        
// //         .cover-meta {
// //           position: absolute;
// //           bottom: 60px;
// //           font-size: 14px;
// //           font-weight: 300;
// //           opacity: 0.8;
// //         }
        
// //         .cover-disclaimer {
// //           margin-top: 30px;
// //           font-size: 12px;
// //           color: #fecaca;
// //           font-style: italic;
// //         }
        
// //         /* === CHAPTER STYLING === */
// //         h1, h2, h3, h4 { 
// //           font-family: 'Inter', sans-serif;
// //           font-weight: 600; 
// //           color: #1f2937; 
// //           margin-top: 2.5em; 
// //           margin-bottom: 0.8em;
// //           position: relative;
// //         }
        
// //         h1 { 
// //           font-size: 28px; 
// //           border-bottom: 3px solid #667eea; 
// //           padding-bottom: 15px;
// //           margin-top: 0;
// //           page-break-before: always;
// //         }
        
// //         h1::after {
// //           content: "";
// //           display: block;
// //           width: 80px;
// //           height: 3px;
// //           background: #764ba2;
// //           margin-top: 15px;
// //         }
        
// //         h2 { 
// //           font-size: 22px; 
// //           border-bottom: 2px solid #e5e7eb; 
// //           padding-bottom: 8px;
// //           color: #4b5563;
// //         }
        
// //         h3 { 
// //           font-size: 18px; 
// //           color: #6b7280;
// //         }
        
// //         /* === FIRST PARAGRAPH ORNAMENT === */
// //         .chapter-content > h1 + p::first-letter {
// //           float: left;
// //           font-size: 4em;
// //           line-height: 1;
// //           margin: 0.1em 0.1em 0 0;
// //           font-weight: 700;
// //           color: #667eea;
// //           font-family: 'Inter', sans-serif;
// //         }
        
// //         /* === CODE BLOCKS === */
// //         code { 
// //           background: #f3f4f6; 
// //           padding: 3px 8px; 
// //           border: 1px solid #e5e7eb; 
// //           font-family: 'Fira Code', 'Courier New', monospace;
// //           font-size: 13px;
// //           border-radius: 4px;
// //           color: #1e40af;
// //         }
        
// //         pre { 
// //           background: #1f2937;
// //           padding: 20px; 
// //           overflow-x: auto; 
// //           border: 1px solid #4b5563; 
// //           border-radius: 8px;
// //           line-height: 1.5; 
// //           margin: 1.5em 0; 
// //           white-space: pre-wrap; 
// //           word-wrap: break-word;
// //           box-shadow: 0 4px 6px rgba(0, 0, 0, 0.05);
// //         }
        
// //         pre code { 
// //           background: none; 
// //           border: none; 
// //           padding: 0; 
// //           color: #e5e7eb;
// //         }
        
// //         /* === BLOCKQUOTES === */
// //         blockquote { 
// //           border-left: 4px solid #667eea; 
// //           margin: 2em 0; 
// //           padding: 1em 1.5em; 
// //           background: linear-gradient(to right, #f3f4f6 0%, #ffffff 100%);
// //           font-style: italic;
// //           border-radius: 0 8px 8px 0;
// //           position: relative;
// //         }
        
// //         blockquote::before {
// //           content: """;
// //           position: absolute;
// //           top: -20px;
// //           left: 10px;
// //           font-size: 80px;
// //           color: #d1d5db;
// //           font-family: 'Inter', sans-serif;
// //           line-height: 1;
// //         }
        
// //         /* === EXAMPLES & CALLOUTS === */
// //         .example { 
// //           background: linear-gradient(to right, #eff6ff 0%, #ffffff 100%);
// //           border-left: 4px solid #3b82f6; 
// //           padding: 20px; 
// //           margin: 2em 0; 
// //           border-radius: 0 8px 8px 0;
// //           font-style: italic;
// //           position: relative;
// //         }
        
// //         .example::before {
// //           content: "💡 Example";
// //           display: block;
// //           font-weight: 600;
// //           color: #1d4ed8;
// //           margin-bottom: 10px;
// //           font-style: normal;
// //         }
        
// //         /* === TABLES === */
// //         table {
// //           width: 100%;
// //           border-collapse: collapse;
// //           margin: 2em 0;
// //           box-shadow: 0 1px 3px rgba(0, 0, 0, 0.1);
// //         }
        
// //         th {
// //           background: #374151;
// //           color: white;
// //           padding: 12px;
// //           text-align: left;
// //           font-family: 'Inter', sans-serif;
// //           font-weight: 600;
// //         }
        
// //         td {
// //           padding: 12px;
// //           border-bottom: 1px solid #e5e7eb;
// //         }
        
// //         tr:nth-child(even) {
// //           background: #f9fafb;
// //         }
        
// //         /* === MATHJAX === */
// //         .MathJax_Display {
// //           margin: 2em 0 !important;
// //           padding: 1em 0;
// //           overflow-x: auto;
// //         }
        
// //         /* === FOOTER DISCLAIMER === */
// //         .disclaimer-footer {
// //           margin-top: 4em;
// //           padding-top: 2em;
// //           border-top: 2px solid #e5e7eb;
// //           font-size: 12px;
// //           color: #6b7280;
// //           font-style: italic;
// //           text-align: center;
// //         }
// //       </style>
// //     </head>
// //     <body>
// //       <!-- Cover Page -->
// //       <div class="cover-page">
// //         <div class="cover-content">
// //           <h1 class="cover-title">${bookTitle}</h1>
// //           <h2 class="cover-subtitle">A Beginner's Guide</h2>
// //           <div class="cover-disclaimer">
// //             ⚠️ Caution: AI-generated content may contain errors
// //           </div>
// //         </div>
// //         <div class="cover-meta">
// //           Generated by Bookgen.ai<br>
// //           ${new Date().toLocaleDateString()}
// //         </div>
// //       </div>
      
// //       <!-- Main Content -->
// //       <div class="chapter-content">
// //         ${marked.parse(formattedContent)}
// //       </div>
      
// //       <!-- Footer Disclaimer -->
// //       <div class="disclaimer-footer">
// //         This book was generated by AI for educational purposes. Please verify all information independently.
// //       </div>
      
// //       <script>
// //         document.addEventListener('DOMContentLoaded', () => {
// //           Prism.highlightAll();
// //         });
// //       </script>
// //     </body>
// //   </html>
// //   `;

// //   try {
// //     const apiKey = 'pdf_live_162WJVSTDmuCQGjksJJXoxrbipwxrHteF8cXC9Z71gC';
    
// //     const formData = new FormData();
// //     const instructions = {
// //       parts: [{ html: "index.html" }],
// //       output: {
// //         format: "pdf",
// //         pdf: {
// //           margin: {
// //             top: "90px",
// //             bottom: "80px",
// //             left: "70px",
// //             right: "70px"
// //           },
// //           // Native header/footer (appears on all pages except cover)
// //           header: {
// //             content: '<div style="font-size: 10px; text-align: center; width: 100%; color: #6b7280;">Generated by bookgen.ai</div>',
// //             spacing: "5mm"
// //           },
// //           footer: {
// //             content: '<div style="font-size: 10px; text-align: center; width: 100%; color: #6b7280;">Page {pageNumber}</div>',
// //             spacing: "5mm"
// //           },
// //           waitDelay: 3000,
// //           printBackground: true,
// //           preferCSSPageSize: true
// //         }
// //       }
// //     };
    
// //     formData.append('instructions', JSON.stringify(instructions));
// //     formData.append('index.html', Buffer.from(enhancedHtml), {
// //       filename: 'index.html',
// //       contentType: 'text/html'
// //     });

// //     const response = await fetch('https://api.nutrient.io/build', {
// //       method: 'POST',
// //       headers: {
// //         'Authorization': `Bearer ${apiKey}`
// //       },
// //       body: formData
// //     });

// //     if (!response.ok) {
// //       const errorText = await response.text();
// //       throw new Error(`Nutrient API error: ${response.status} - ${errorText}`);
// //     }

// //     const pdfBuffer = await response.buffer();
// //     fs.writeFileSync(outputPath, pdfBuffer);
// //     logger.info(`✅ Generated premium PDF: ${outputPath}`);
// //     return outputPath;

// //   } catch (error) {
// //     logger.error(`❌ PDF generation failed: ${error.message}`);
// //     throw error;
// //   }
// // }
             
// // // === Prompt Generator ===
// // function generatePrompts(bookTopic) {
// //   return [
// //     // Table of Contents
// //     `As Hailu, you are going to follow this instruction that i will gave you. You must work with them for best out put. First write the title for the book then create a table of contents for a book about "${bookTopic}" for someone with no prior knowledge. The book must have 10 chapters, each covering a unique aspect of ${bookTopic} (e.g., for trading bots: what they are, how they work, strategies, risks, tools). Each chapter must be at least 400 words and written in a fun, simple, friendly tone, like explaining to a curious 16-year-old. Use clear, descriptive chapter titles and include more than 2–3 subtopics per chapter (e.g., "What is a trading bot?" or "How do trading bots make decisions?"). Output only the table of contents as a numbered list with chapter titles and subtopics. Ensure topics are distinct, avoid overlap, and focus strictly on ${bookTopic}. If ${bookTopic} is unclear, suggest relevant subtopics and explain why. Ignore any unrelated topics like space or previous requests. Remeber After you finish what you have been told you are goinig to stop after you finish creating the table of content you are done don't respond any more.`,

// //     // Chapter prompts 1-10...
// //     `As Hailu,you are going to follow this instruction that i will gave you. You write Chapter 1 of the book about "${bookTopic}", based on the table of contents you created. Focus only on the first chapter's topic and subtopics. Use a fun, simple, friendly tone, like explaining to a curious 16-year-old. Break down complex ideas into clear steps with vivid examples (e.g., for trading bots, compare them to a robot chef following a recipe) and if it seem important use one analogy per subtopic. Include a description of a diagram or table (e.g., "a diagram showing how a trading bot works") to aid understanding. Use clear headings for each subtopic. Write at least 400 words, avoid copyrighted material, ensure accuracy, and focus only on ${bookTopic} chapter one from the table of content. If information is limited, explain in simple terms and note limitations. Do not include the table of contents, other chapters, or unrelated topics like space please only write chapter one after you are done writting chapter one stop responding.`,

// //     `As Hailu,you are going to follow this instruction that i will gave you. Now you write Chapter 2 of the book about "${bookTopic}", based on the table of contents you created. Focus only on the second chapter's topic and subtopics. Use a fun, simple, friendly tone, like explaining to a curious 16-year-old. Break down complex ideas into clear steps with vivid examples (e.g., for trading bots, compare them to a robot chef following a recipe) and if it seem important use one analogy per subtopic. Include a description of a diagram or table (e.g., "a diagram showing how a trading bot works") to aid understanding. Use clear headings for each subtopic. Write at least 400 words, avoid copyrighted material, ensure accuracy, and focus only on ${bookTopic} chapter two from the table of content. If information is limited, explain in simple terms and note limitations. Do not include the table of contents, other chapters, or unrelated topics like space please only write chapter two after you are done writting chapter two stop responding.`,

// //     `As Hailu,you are going to follow this instruction that i will gave you. You write Chapter 3 of the book about "${bookTopic}", based on the table of contents you created. Focus only on the third chapter's topic and subtopics. Use a fun, simple, friendly tone, like explaining to a curious 16-year-old. Break down complex ideas into clear steps with vivid examples (e.g., for trading bots, compare them to a robot chef following a recipe) and if it seem important use one analogy per subtopic. Include a description of a diagram or table (e.g., "a diagram showing how a trading bot works") to aid understanding. Use clear headings for each subtopic. Write at least 400 words, avoid copyrighted material, ensure accuracy, and focus only on ${bookTopic} chapter three from the table of content. If information is limited, explain in simple terms and note limitations. Do not include the table of contents, other chapters, or unrelated topics like space please only write chapter three after you are done writting chapter three stop responding.`,
    
// //     `As Hailu,you are going to follow this instruction that i will gave you. You write Chapter 4 of the book about "${bookTopic}", based on the table of contents you created. Focus only on the fourth chapter's topic and subtopics. Use a fun, simple, friendly tone, like explaining to a curious 16-year-old. Break down complex ideas into clear steps with vivid examples (e.g., for trading bots, compare them to a robot chef following a recipe) and if it seem important use one analogy per subtopic. Include a description of a diagram or table (e.g., "a diagram showing how a trading bot works") to aid understanding. Use clear headings for each subtopic. Write at least 400 words, avoid copyrighted material, ensure accuracy, and focus only on ${bookTopic} chapter four from the table of content. If information is limited, explain in simple terms and note limitations. Do not include the table of contents, other chapters, or unrelated topics like space please only write chapter four after you are done writting chapter four stop responding.`,
    
// //     `As Hailu,you are going to follow this instruction that i will gave you. You write Chapter 5 of the book about "${bookTopic}", based on the table of contents you created. Focus only on the fifith chapter's topic and subtopics. Use a fun, simple, friendly tone, like explaining to a curious 16-year-old. Break down complex ideas into clear steps with vivid examples (e.g., for trading bots, compare them to a robot chef following a recipe) and if it seem important use one analogy per subtopic. Include a description of a diagram or table (e.g., "a diagram showing how a trading bot works") to aid understanding. Use clear headings for each subtopic. Write at least 400 words, avoid copyrighted material, ensure accuracy, and focus only on ${bookTopic} chapter five from the table of content. If information is limited, explain in simple terms and note limitations. Do not include the table of contents, other chapters, or unrelated topics like space please only write chapter five after you are done writting chapter five stop responding.`,
    
// //     `As Hailu,you are going to follow this instruction that i will gave you. You write Chapter 6 of the book about "${bookTopic}", based on the table of contents you created. Focus only on the sixth chapter's topic and subtopics. Use a fun, simple, friendly tone, like explaining to a curious 16-year-old. Break down complex ideas into clear steps with vivid examples (e.g., for trading bots, compare them to a robot chef following a recipe) and if it seem important use one analogy per subtopic. Include a description of a diagram or table (e.g., "a diagram showing how a trading bot works") to aid understanding. Use clear headings for each subtopic. Write at least 400 words, avoid copyrighted material, ensure accuracy, and focus only on ${bookTopic} chapter six from the table of content. If information is limited, explain in simple terms and note limitations. Do not include the table of contents, other chapters, or unrelated topics like space please only write chapter six after you are done writting chapter six stop responding.`,    

// //     `As Hailu,you are going to follow this instruction that i will gave you. You write Chapter 7 of the book about "${bookTopic}", based on the table of contents you created. Focus only on the seventh chapter's topic and subtopics. Use a fun, simple, friendly tone, like explaining to a curious 16-year-old. Break down complex ideas into clear steps with vivid examples (e.g., for trading bots, compare them to a robot chef following a recipe) and if it seem important use one analogy per subtopic. Include a description of a diagram or table (e.g., "a diagram showing how a trading bot works") to aid understanding. Use clear headings for each subtopic. Write at least 400 words, avoid copyrighted material, ensure accuracy, and focus only on ${bookTopic} chapter seven from the table of content. If information is limited, explain in simple terms and note limitations. Do not include the table of contents, other chapters, or unrelated topics like space please only write chapter seven after you are done writting chapter seven stop responding.`,
    
// //     `As Hailu,you are going to follow this instruction that i will gave you. You write Chapter 8 of the book about "${bookTopic}", based on the table of contents you created. Focus only on the eightth chapter's topic and subtopics. Use a fun, simple, friendly tone, like explaining to a curious 16-year-old. Break down complex ideas into clear steps with vivid examples (e.g., for trading bots, compare them to a robot chef following a recipe) and if it seem important use one analogy per subtopic. Include a description of a diagram or table (e.g., "a diagram showing how a trading bot works") to aid understanding. Use clear headings for each subtopic. Write at least 400 words, avoid copyrighted material, ensure accuracy, and focus only on ${bookTopic} chapter eight from the table of content. If information is limited, explain in simple terms and note limitations. Do not include the table of contents, other chapters, or unrelated topics like space please only write chapter eight after you are done writting chapter eight stop responding.`,

// //     `As Hailu,you are going to follow this instruction that i will gave you. You write Chapter 9 of the book about "${bookTopic}", based on the table of contents you created. Focus only on the nineth chapter's topic and subtopics. Use a fun, simple, friendly tone, like explaining to a curious 16-year-old. Break down complex ideas into clear steps with vivid examples (e.g., for trading bots, compare them to a robot chef following a recipe) and if it seem important use one analogy per subtopic. Include a description of a diagram or table (e.g., "a diagram showing how a trading bot works") to aid understanding. Use clear headings for each subtopic. Write at least 400 words, avoid copyrighted material, ensure accuracy, and focus only on ${bookTopic} chapter nine from the table of content. If information is limited, explain in simple terms and note limitations. Do not include the table of contents, other chapters, or unrelated topics like space please only write chapter nine after you are done writting chapter nine stop responding.`,
    
// //     `As Hailu,you are going to follow this instruction that i will gave you. You write Chapter 10 of the book about "${bookTopic}", based on the table of contents you created. Focus only on the tenth chapter's topic and subtopics. Use a fun, simple, friendly tone, like explaining to a curious 16-year-old. Break down complex ideas into clear steps with vivid examples (e.g., for trading bots, compare them to a robot chef following a recipe) and if it seem important use one analogy per subtopic. Include a description of a diagram or table (e.g., "a diagram showing how a trading bot works") to aid understanding. Use clear headings for each subtopic. Write at least 400 words, avoid copyrighted material, ensure accuracy, and focus only on ${bookTopic} chapter ten from the table of content. If information is limited, explain in simple terms and note limitations. Do not include the table of contents, other chapters, or unrelated topics like space please only write chapter ten after you are done writting chapter ten stop responding.`,
    
// //     // Conclusion and References
// //     `As Hailu, write the conclusion and references for the book about "${bookTopic}", based on the table of contents and chapters you created. Use a fun, simple, friendly tone, like explaining to a curious 19-year-old. In the conclusion (200–300 words), summarize the key ideas from all chapters and inspire the reader to learn more about ${bookTopic}. In the references section, provide 3–5 reliable, beginner-friendly resources (e.g., for trading bots: Investopedia, Python libraries, or educational videos) with a 1–2 sentence description each. Use clear headings ("Conclusion" and "References"). Avoid copyrighted material, ensure resources are accessible and appropriate for beginners, and focus only on ${bookTopic}. If resources are limited, suggest general learning platforms and explain why. Do not include the table of contents, chapter content, or unrelated topics like space.`
// //   ];
// // }

// // // === Task Queue ===
// // const bookQueue = async.queue(async (task, callback) => {
// //   try {
// //     const { bookTopic, userId } = task;
// //     await generateBookMedd(bookTopic, userId);
// //     callback();
// //   } catch (error) {
// //     callback(error);
// //   }
// // }, 1); // Process one book at a time

// // // === Master Function ===
// // export async function generateBookMedd(bookTopic, userId) {
// //   const safeUserId = `${userId}-${bookTopic.replace(/\s+/g, '_').toLowerCase()}`;
// //   logger.info(`Starting book generation for user: ${safeUserId}, topic: ${bookTopic}`);

// //   try {
// //     global.cancelFlags = global.cancelFlags || {};

// //     userHistories.set(safeUserId, [{
// //       role: "system",
// //       content:
// //         "Your name is Hailu. You are a kind, smart teacher explaining to a curious person. Use simple, clear words, break down complex ideas step-by-step, and include human-like examples. Always start with a table of contents, then write chapters. Focus only on the requested topic, ignore unrelated contexts."
// //     }]);

// //     const prompts = generatePrompts(bookTopic);
// //     const chapterFiles = [];

// //     for (let i = 0; i < prompts.length; i++) {
// //       if (global.cancelFlags?.[userId]) {
// //         delete global.cancelFlags[userId];
// //         logger.warn(`❌ Book generation cancelled for user: ${userId}`);
// //         throw new Error('Generation cancelled');
// //       }

// //       const chapterNum = i + 1;
// //       logger.info(`Generating Chapter ${chapterNum} for ${bookTopic}`);
// //       const file = await generateChapter(prompts[i], chapterNum, safeUserId, bookTopic);
// //       chapterFiles.push(file);
// //     }

// //     const combinedContent = combineChapters(chapterFiles);

// //     const safeTopic = bookTopic.slice(0, 20).replace(/\s+/g, "_");
// //     const fileName = `output_${safeUserId}_${safeTopic}.pdf`;
// //     const outputPath = path.join(OUTPUT_DIR, fileName);
// //     await generatePDF(combinedContent, outputPath);

// //     chapterFiles.forEach(deleteFile);
// //     userHistories.delete(safeUserId);

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
// // }



















































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
// //       max_tokens: 4000            // allows long, complete chapter-style answers
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
// //     `As Hailu, you are going to follow this instruction that i will gave you. You must work with them for best out put. First write the title for the book then create a table of contents for a book about "${bookTopic}" for someone with no prior knowledge. The book must have 10 chapters, each covering a unique aspect of ${bookTopic} (e.g., for trading bots: what they are, how they work, strategies, risks, tools). Each chapter must be at least 400 words and written in a fun, simple, friendly tone, like explaining to a curious 16-year-old. Use clear, descriptive chapter titles and include more than 2–3 subtopics per chapter (e.g., "What is a trading bot?" or "How do trading bots make decisions?"). Output only the table of contents as a numbered list with chapter titles and subtopics. Ensure topics are distinct, avoid overlap, and focus strictly on ${bookTopic}. If ${bookTopic} is unclear, suggest relevant subtopics and explain why. Ignore any unrelated topics like space or previous requests. Remeber After you finish what you have been told you are goinig to stop after you finish creating the table of content you are done don't respond any more.`,

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
// // export async function generateBookMedd(bookTopic, userId) {
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
// // }
