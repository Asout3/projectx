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
const SECTION_PREFIX = 'section';
const OUTPUT_PDF = 'paper_output.pdf';
const COMBINED_FILE = 'combined-sections.txt';

// Initialize
let conversationHistory = loadConversationHistory();
const together = new Together({
  apiKey: '18a96a823e402ef5dfedc1e372bf50fc8e6357bb25a0eff0bea25a07f51a1087', // TODO: Move to .env file for security
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
  const sectionMessage = messages.find(
    (msg) => msg.role === "assistant" && msg.content.toLowerCase().includes("abstract")
  );
  if (!sectionMessage) return [];

  return [{
    role: "system",
    content:
      "You are Hailu, an expert researcher. You specialize in writing detailed, academic research papers with at least 200 words per section. Follow the provided structure (Abstract, Introduction, Methodology, Findings, Discussion, Conclusion, References) and maintain coherence across sections. Here is the latest section context:\n\n" +
      sectionMessage.content,
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

function combineSections(files) {
  let combined = '';
  for (const file of files) {
    const content = fs.readFileSync(file, 'utf8');
    combined += content + '\n\n';
  }
  fs.writeFileSync(COMBINED_FILE, combined.trim());
  return combined;
}

// === AI Interaction ===
async function askAI(prompt) {
  const trimmedHistory = trimHistory(conversationHistory);
  const messages = [...trimmedHistory, { role: 'user', content: prompt }];

  const response = await together.chat.completions.create({
    messages,
    model: "deepseek-ai/DeepSeek-R1-Distill-Llama-70B-free",
    max_tokens: 4000,
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

// === Formatter ===
function formatMath(content) {
  return content
    .replace(/(\d+)\s*\^\s*(\d+)/g, (_, base, exp) => `$${base}^${exp}$`)
    .replace(/(\d+)\s*\/\s*(\d+)/g, (_, num, den) => `$\\frac{${num}}{${den}}$`);
}

function cleanUpAIText(text) {
  // Remove horizontal separator lines (e.g., -----, =====)
  let cleaned = text.replace(/[-_=*~]{5,}/g, '');

  // Normalize newlines and replace long dashes
  return cleaned
    .replace(/\n{3,}/g, '\n\n')   // Convert 3+ newlines to 2
    .replace(/\n\s*$/g, '')       // Trim trailing newlines
    .replace(/[\u2013\u2014]/g, '-') // Replace em/en dashes with hyphens
    .trim();
}

// === Section Generator ===
async function generateSection(prompt, sectionNumber, sectionName) {
  const content = await askAI(prompt);
  const filename = `${SECTION_PREFIX}-${sectionNumber}-${sectionName}.txt`;
  saveToFile(filename, content);
  return filename;
}

// === PDF Generator ===
export async function generatePDF(content, outputPath) {
  const cleaned = cleanUpAIText(formatMath(content));

  const html = `
  <html>
    <head>
      <meta charset="utf-8">
      <title>Research Paper</title>
      <meta http-equiv="Content-Security-Policy" content="default-src * 'unsafe-inline' 'unsafe-eval';">

      <!-- KaTeX for math rendering -->
      <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@0.16.9/dist/katex.min.css">
      <script defer src="https://cdn.jsdelivr.net/npm/katex@0.16.9/dist/katex.min.js"></script>
      <script defer src="https://cdn.jsdelivr.net/npm/katex@0.16.9/dist/contrib/auto-render.min.js"
        onload="renderMathInElement(document.body, {
          delimiters: [
            {left: '$$', right: '$$', display: true},
            {left: '$', right: '$', display: false}
          ]
        });"></script>

      <!-- Highlight.js for code block rendering -->
      <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.7.0/styles/default.min.css">
      <script src="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.7.0/highlight.min.js"></script>
      <script>document.addEventListener('DOMContentLoaded', (event) => { hljs.highlightAll(); });</script>

      <!-- Styles -->
      <style>
        @page {
          margin: 80px 60px;
        }

        body {
          font-family: 'Georgia', serif;
          font-size: 14px;
          line-height: 1.6;
          color: #222;
          margin: 0;
          padding: 0;
          text-align: justify;
        }

        h1 {
          font-size: 20pt;
          text-align: center;
          border-bottom: 1px solid #aaa;
          padding-bottom: 0.3em;
          margin-top: 60px;
          margin-bottom: 30px;
        }

        h2 {
          font-size: 16pt;
          color: #333;
          margin-top: 40px;
          margin-bottom: 15px;
        }

        h3 {
          font-size: 14pt;
          color: #444;
          margin-top: 30px;
          margin-bottom: 10px;
        }

        p {
          margin: 0 0 1em 0;
        }

        pre {
          background: #f5f5f5;
          color: #333;
          padding: 15px;
          overflow-x: auto;
          border-radius: 6px;
          font-size: 13px;
          font-family: 'Consolas', 'Monaco', monospace;
          border: 1px solid #ddd;
        }

        code {
          background: #f4f4f4;
          padding: 2px 6px;
          border-radius: 4px;
          font-family: 'Consolas', 'Monaco', monospace;
          font-size: 13px;
        }

        pre code {
          background: none;
          padding: 0;
          border-radius: 0;
        }

        ul, ol {
          margin: 1em 0;
          padding-left: 2em;
        }

        table {
          border-collapse: collapse;
          margin: 1em 0;
          width: 100%;
        }

        table, th, td {
          border: 1px solid #ccc;
        }

        th, td {
          padding: 8px;
          text-align: left;
        }
      </style>
    </head>
    <body>
      ${marked.parse(cleaned)}
    </body>
  </html>
  `;

 const browser = await puppeteer.launch({
  executablePath: await chromium.executablePath(),
  headless: chromium.headless,
  args: chromium.args,
});
  
  const page = await browser.newPage();

  await page.setContent(html, { waitUntil: 'networkidle0' });

  await page.pdf({
    path: outputPath,
    format: 'A4',
    printBackground: true,
    displayHeaderFooter: true,
    footerTemplate: `
      <div style="font-size:10px; text-align:center; width:100%;">
        Page <span class="pageNumber"></span> of <span class="totalPages"></span>
      </div>`,
    headerTemplate: `<div></div>`,
    margin: {
      top: '80px',
      bottom: '80px',
      left: '60px',
      right: '60px',
    },
  });

  await browser.close();
}

// === Main Generator ===

export async function generateResearchPaper(topic, userId, pageLength = 50) {
  try {
    console.log(`📄 Generating research paper for user: ${userId} with topic: "${topic}"`);

    conversationHistory = [{
      role: "system",
      content:
        "You are Hailu, an expert researcher. You specialize in writing detailed, academic research papers with at least 200 words per section. Generate a research paper on the given topic with the following structure: Abstract, Introduction, Methodology, Findings, Discussion, Conclusion, References. Use an academic tone, avoid speculation, and include plausible examples relevant to the topic. For References, generate 5-10 hypothetical APA sources."
    }];

    const totalWords = pageLength * 750;
    const findingsWords = Math.floor(totalWords * 0.5);
    const findingsParts = Math.ceil(findingsWords / 1500);
    const findingsWordsPerPart = Math.floor(findingsWords / findingsParts);

    const prompts = [
      {
        text: `# Abstract\n\nWrite a 200-word abstract for a research paper on "${topic}". First, give the paper a proper title. Summarize the purpose, methods, key findings, and conclusion.`,
        name: 'abstract'
      },
      {
        text: `# Introduction\n\nWrite a 600-word introduction for a research paper on "${topic}". Include background, problem statement, objectives, and significance.`,
        name: 'introduction'
      },
      {
        text: `# Methodology\n\nWrite a 1000-word methodology section. Use subheadings like "## Data Collection", "## Analysis Techniques", etc.`,
        name: 'methodology'
      },
      {
        text: `# Findings\n\nWrite the findings section. Present key findings with markdown formatting and plausible examples.`,
        name: 'findings'
      },
      {
        text: `# Discussion\n\nWrite a 1000-word discussion analyzing findings, implications, and limitations.`,
        name: 'discussion'
      },
      {
        text: `# Conclusion\n\nWrite a 650-word conclusion summarizing key points and suggesting future research.`,
        name: 'conclusion'
      },
      {
        text: `# References\n\nGenerate 5-10 hypothetical APA references. Format them in markdown bullet points.`,
        name: 'references'
      }
    ];

    const sectionFiles = [];

    for (const [index, prompt] of prompts.entries()) {
      const sectionNum = index + 1;
      console.log(`\n🧠 Generating Section ${sectionNum}: ${prompt.name}`);

      const context = conversationHistory
        .filter(msg => msg.role === 'assistant')
        .slice(-2)
        .map(msg => msg.content)
        .join('\n');

      const fullPrompt = sectionNum === 1 ? prompt.text : `${prompt.text}\n\nEarlier context:\n${context}`;

      const sectionPath = await generateSection(fullPrompt, sectionNum, prompt.name);
      sectionFiles.push(sectionPath);
    }

    const combinedContent = combineSections(sectionFiles);

    const safeTopic = topic.slice(0, 20).replace(/\s+/g, "_");
    const fileName = `research_${userId}_${safeTopic}.pdf`;
    const outputDir = path.join(__dirname, '../pdfs');
    if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir);
    const outputPath = path.join(outputDir, fileName);

    await generatePDF(combinedContent, outputPath);

    sectionFiles.forEach(deleteFile);

    console.log(`\n✅ Research paper complete. Output: ${outputPath}`);
    return outputPath;

  } catch (error) {
    console.error('❌ Research paper generation failed:', error);
    throw error;
  }
}
