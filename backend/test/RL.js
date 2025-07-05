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
const SECTION_PREFIX = 'section';
const COMBINED_FILE = 'combined-sections.txt';

// AI Client
const together = new Together({
  apiKey: '18a96a823e402ef5dfedc1e372bf50fc8e6357bb25a0eff0bea25a07f51a1087',
});

// Markdown setup
marked.setOptions({
  highlight: (code, lang) => {
    const validLang = hljs.getLanguage(lang) ? lang : 'plaintext';
    return hljs.highlight(code, { language: validLang }).value;
  }
});

// === Helpers ===
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
    const content = fs.readFileSync(file, 'utf8');
    combined += content + '\n\n';
  }
  fs.writeFileSync(COMBINED_FILE, combined.trim());
  return combined;
}

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
          font-size: 12.5px;
          line-height: 1.6;
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

// === Main Function ===
export async function generateResearchPaperLongg(topic, userId) {
  try {
    console.log(`📄 Generating SHORT research paper for user: ${userId} with topic: ${topic}`);

    let conversationHistory = [{
      role: "system",
      content: "You are Hailu, a professional researcher. Write a short but structured research paper. Include introduction, methodology, analysis, and conclusion."
    }];

    async function askAI(prompt) {
      const messages = [...conversationHistory, { role: 'user', content: prompt }];
      const response = await together.chat.completions.create({
        messages,
        model: "deepseek-ai/DeepSeek-R1-Distill-Llama-70B-free",
        max_tokens: 2000,
        temperature: 0.8,
      });

      let reply = response.choices[0].message.content || '';
      reply = reply.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
      conversationHistory.push({ role: 'user', content: prompt });
      conversationHistory.push({ role: 'assistant', content: reply });
      return reply;
    }

    async function generateSection(prompt, sectionNum) {
      const sectionText = await askAI(prompt);
      const filename = `research-section-${userId}-${sectionNum}.txt`;
      saveToFile(filename, sectionText);
      return filename;
    }

    const prompts = [
      { text: `# Abstract\n\nWrite a 300-word abstract for a research paper on "${topic}". Give it a proper title.`, name: 'abstract' },
      { text: `# Introduction\n\nWrite a 650-word introduction on "${topic}". Include background, objectives, and importance.`, name: 'introduction' },
      { text: `# Methodology\n\nDescribe methodology with subheadings like "## Data Collection" and "## Analysis".`, name: 'methodology' },
      { text: `# Findings\n\nPresent findings with examples and markdown formatting.`, name: 'findings' },
      { text: `# Findings\n\nPresent findings that you didn't write on the first findings with examples and markdown formatting.`, name: 'other-findings' },
      { text: `# Findings\n\nPresent findings that you didn't write on the first two findings and present them as final findings with examples and markdown formatting.`, name: 'final-findings' },
      { text: `# Discussion\n\nDiscuss the implications and limitations of the findings.`, name: 'discussion' },
      { text: `# Conclusion\n\nSummarize the findings and give recommendations.`, name: 'conclusion' },
      { text: `# References\n\nGenerate 5-10 APA style references in markdown.`, name: 'references' },
    ];

    const sectionFiles = [];
    for (let i = 0; i < prompts.length; i++) {
      console.log(`📘 Generating section ${i + 1}: ${prompts[i].name}`);
      const file = await generateSection(prompts[i].text, i + 1);
      sectionFiles.push(file);
    }

    const combinedContent = combineChapters(sectionFiles);
    const safeTopic = topic.slice(0, 20).replace(/\s+/g, "_");
    const fileName = `research_${userId}_${safeTopic}.pdf`;
    const outputDir = path.join(__dirname, '../pdfs');
    if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir);

    const outputPath = path.join(outputDir, fileName);
    await generatePDF(combinedContent, outputPath);

    sectionFiles.forEach(deleteFile);

    console.log(`✅ Research paper generated: ${outputPath}`);
    return outputPath;

  } catch (error) {
    console.error('❌ Short research paper generation failed:', error);
    throw error;
  }
}












// import { Together } from "together-ai";
// import { marked } from 'marked';
// import hljs from 'highlight.js';
// import puppeteer from 'puppeteer-core';
// import chromium from '@sparticuz/chromium';
// import fs from 'fs';
// import path from 'path';
// import { fileURLToPath } from 'url';
// import { dirname } from 'path';
// const __filename = fileURLToPath(import.meta.url);
// const __dirname = dirname(__filename);

// // Configuration
// const HISTORY_FILE = 'history.json';
// const SECTION_PREFIX = 'section';
// const OUTPUT_PDF = 'paper_output.pdf';
// const COMBINED_FILE = 'combined-sections.txt';

// // Initialize
// let conversationHistory = loadConversationHistory();
// const together = new Together({
//   apiKey: '18a96a823e402ef5dfedc1e372bf50fc8e6357bb25a0eff0bea25a07f51a1087',
// });

// // Markdown & Code Highlighting
// marked.setOptions({
//   highlight: function (code, lang) {
//     const validLang = hljs.getLanguage(lang) ? lang : 'plaintext';
//     return hljs.highlight(code, { language: validLang }).value;
//   }
// });

// // === Utility Functions ===
// function loadConversationHistory() {
//   try {
//     const data = fs.readFileSync(HISTORY_FILE, 'utf8');
//     return JSON.parse(data);
//   } catch {
//     console.log('No history found. Starting fresh.');
//     return [];
//   }
// }

// function saveConversationHistory() {
//   const trimmed = trimHistory(conversationHistory);
//   fs.writeFileSync(HISTORY_FILE, JSON.stringify(trimmed, null, 2));
// }

// function trimHistory(messages) {
//   const sectionMessage = messages.find(
//     (msg) => msg.role === "assistant" && msg.content.toLowerCase().includes("abstract")
//   );
//   if (!sectionMessage) return [];

//   return [{
//     role: "system",
//     content:
//       "You are Hailu, an expert researcher. You specialize in writing detailed, academic research papers with at least 400 words per section. Follow the provided structure (Abstract, Introduction, Methodology, Findings, Discussion, Conclusion, References) and maintain coherence across sections. Here is the latest section context:\n\n" +
//       sectionMessage.content,
//   }];
// }

// function saveToFile(filename, content) {
//   fs.writeFileSync(filename, content);
//   console.log(`✔ Saved: ${filename}`);
// }

// function deleteFile(filePath) {
//   try {
//     fs.unlinkSync(filePath);
//     console.log(`Deleted: ${filePath}`);
//   } catch (err) {
//     console.error(`Error deleting ${filePath}:`, err);
//   }
// }

// function combineSections(files) {
//   let combined = '';
//   for (const file of files) {
//     const content = fs.readFileSync(file, 'utf8');
//     combined += content + '\n\n';
//   }
//   fs.writeFileSync(COMBINED_FILE, combined);
//   return combined;
// }

// // === AI Interaction ===
// async function askAI(prompt) {
//   const trimmedHistory = trimHistory(conversationHistory);
//   const messages = [...trimmedHistory, { role: 'user', content: prompt }];

//   const response = await together.chat.completions.create({
//     messages,
//     model: "deepseek-ai/DeepSeek-R1-Distill-Llama-70B-free",
//     max_tokens: 3000,
//     temperature: 0.8,
//   });

//   let reply = response.choices[0].message.content
//     .replace(/<think>[\s\S]*?<\/think>/gi, '')
//     .replace(/^I'm DeepSeek-R1.*?help you\.\s*/i, '')
//     .trim();

//   conversationHistory.push({ role: 'user', content: prompt });
//   conversationHistory.push({ role: 'assistant', content: reply });
//   saveConversationHistory();

//   return reply;
// }

// // === Section Generator ===
// async function generateSection(prompt, sectionNumber, sectionName) {
//   const content = await askAI(prompt);
//   const filename = `${SECTION_PREFIX}-${sectionNumber}-${sectionName}.txt`;
//   saveToFile(filename, content);
//   return filename;
// }

// // === Formatter ===
// function formatMath(content) {
//   return content
//     .replace(/(\d+)\s*\^\s*(\d+)/g, (_, base, exp) => `$${base}^${exp}$`)
//     .replace(/(\d+)\s*\/\s*(\d+)/g, (_, num, den) => `$\\frac{${num}}{${den}}$`);
// }

// function cleanUpAIText(text) {
//   // Remove horizontal separator lines (e.g., -----, =====)
//   let cleaned = text.replace(/[-_=*~]{5,}/g, '');

//   // Normalize newlines and replace long dashes
//   return cleaned
//     .replace(/\n{3,}/g, '\n\n')   // Convert 3+ newlines to 2
//     .replace(/\n\s*$/g, '')       // Trim trailing newlines
//     .replace(/[\u2013\u2014]/g, '-') // Replace em/en dashes with hyphens
//     .trim();
// }

// // === PDF Generator ===
// export async function generatePDF(content, outputPath) {
//   const cleaned = cleanUpAIText(formatMath(content));

//   const html = `
//   <html>
//     <head>
//       <meta charset="utf-8">
//       <title>Research Paper</title>
//       <meta http-equiv="Content-Security-Policy" content="default-src * 'unsafe-inline' 'unsafe-eval';">

//       <!-- KaTeX for math rendering -->
//       <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@0.16.9/dist/katex.min.css">
//       <script defer src="https://cdn.jsdelivr.net/npm/katex@0.16.9/dist/katex.min.js"></script>
//       <script defer src="https://cdn.jsdelivr.net/npm/katex@0.16.9/dist/contrib/auto-render.min.js"
//         onload="renderMathInElement(document.body, {
//           delimiters: [
//             {left: '$$', right: '$$', display: true},
//             {left: '$', right: '$', display: false}
//           ]
//         });"></script>

//       <!-- Highlight.js for code block rendering -->
//       <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.7.0/styles/default.min.css">
//       <script src="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.7.0/highlight.min.js"></script>
//       <script>document.addEventListener('DOMContentLoaded', (event) => { hljs.highlightAll(); });</script>

//       <!-- Styles -->
//       <style>
//         @page {
//           margin: 80px 60px;
//         }

//         body {
//           font-family: 'Georgia', serif;
//           font-size: 14px;
//           line-height: 1.6;
//           color: #222;
//           margin: 0;
//           padding: 0;
//           text-align: justify;
//         }

//         h1 {
//           font-size: 20pt;
//           text-align: center;
//           border-bottom: 1px solid #aaa;
//           padding-bottom: 0.3em;
//           margin-top: 60px;
//           margin-bottom: 30px;
//         }

//         h2 {
//           font-size: 16pt;
//           color: #333;
//           margin-top: 40px;
//           margin-bottom: 15px;
//         }

//         h3 {
//           font-size: 14pt;
//           color: #444;
//           margin-top: 30px;
//           margin-bottom: 10px;
//         }

//         p {
//           margin: 0 0 1em 0;
//         }

//         pre {
//           background: #f5f5f5;
//           color: #333;
//           padding: 15px;
//           overflow-x: auto;
//           border-radius: 6px;
//           font-size: 13px;
//           font-family: 'Consolas', 'Monaco', monospace;
//           border: 1px solid #ddd;
//         }

//         code {
//           background: #f4f4f4;
//           padding: 2px 6px;
//           border-radius: 4px;
//           font-family: 'Consolas', 'Monaco', monospace;
//           font-size: 13px;
//         }

//         pre code {
//           background: none;
//           padding: 0;
//           border-radius: 0;
//         }

//         ul, ol {
//           margin: 1em 0;
//           padding-left: 2em;
//         }

//         table {
//           border-collapse: collapse;
//           margin: 1em 0;
//           width: 100%;
//         }

//         table, th, td {
//           border: 1px solid #ccc;
//         }

//         th, td {
//           padding: 8px;
//           text-align: left;
//         }
//       </style>
//     </head>
//     <body>
//       ${marked.parse(cleaned)}
//     </body>
//   </html>
//   `;

//   const browser = await puppeteer.launch({
//   executablePath: await chromium.executablePath(),
//   headless: chromium.headless,
//   args: chromium.args,
//   });

//   const page = await browser.newPage();

//   await page.setContent(html, { waitUntil: 'networkidle0' });

//   await page.pdf({
//     path: outputPath,
//     format: 'A4',
//     printBackground: true,
//     displayHeaderFooter: true,
//     footerTemplate: `
//       <div style="font-size:10px; text-align:center; width:100%;">
//         Page <span class="pageNumber"></span> of <span class="totalPages"></span>
//       </div>`,
//     headerTemplate: `<div></div>`,
//     margin: {
//       top: '80px',
//       bottom: '80px',
//       left: '60px',
//       right: '60px',
//     },
//   });

//   await browser.close();
// }

// // === Main Function ===

// export async function generateResearchPaperLongg(topic, userId, pageLength = 50) {
//   try {
//     console.log(`📄 Generating research paper for user: ${userId} with topic: "${topic}"`);

//     conversationHistory = [{
//       role: "system",
//       content:
//         "You are Hailu, an expert researcher. You specialize in writing detailed, academic research papers with at least 300 words per section. Generate a research paper on the given topic with the following structure: Abstract, Introduction, Methodology, Findings, Discussion, Conclusion, References. Use an academic tone, avoid speculation, and include plausible examples relevant to the topic. For References, generate 5-10 hypothetical APA sources."
//     }];

//     const totalWords = pageLength * 750;
//     const findingsWords = Math.floor(totalWords * 0.5);
//     const findingsParts = Math.ceil(findingsWords / 1500);
//     const findingsWordsPerPart = Math.floor(findingsWords / findingsParts);

//     const prompts = [
//       {
//         text: `# Abstract\n\nWrite a 300-word abstract for a research paper on "${topic}" but first Start with give the reserch paper a topic. Summarize the purpose, methods, key findings, and conclusion in markdown.`,
//         name: 'abstract'
//       },
//       {
//         text: `# Introduction\n\nWrite a 650-word introduction for a research paper on "${topic}". Include background, problem statement, objectives, and significance.`,
//         name: 'introduction'
//       },
//       {
//         text: `# Methodology\n\nWrite a 1500-word methodology section for a research paper on "${topic}". Use subheadings like "## Data Collection", "## Analysis Techniques", etc.`,
//         name: 'methodology'
//       },
//       {
//         text: `# Findings\n\nWrite the findings section for a research paper on "${topic}". Present key findings with examples. Use markdown.`,
//         name: `findings-part`
//       },
//       {
//         text: `# Findings\n\nWrite the other findings section for a research paper on "${topic}" which you didn't find on the first findings. Present key findings with examples and give it topic of other findings. Use proper markdown. AND REMEMBER TO AVOIDE ANY KIND OF REPITION.`,
//         name: `findings-part-1`
//       },
//       {
//         text: `# Findings\n\nWrite the other findings section for a research paper on "${topic}" which you didn't find on the first and the second findings. Present key findings with examples and give it topic of other findings. Use proper markdown. AND REMEBER TO AVOIDE ANY KIND OF REPITION. And present them as Last findings.`,
//         name: `findings-part-2`
//       },
//       {
//         text: `# Discussion\n\nWrite a 1500-word discussion section for a research paper on "${topic}", analyzing findings, implications, and limitations.`,
//         name: 'discussion'
//       },
//       {
//         text: `# Conclusion\n\nWrite a 650-word conclusion for a research paper on "${topic}", summarizing key points and suggesting future research.`,
//         name: 'conclusion'
//       },
//       {
//         text: `# References\n\nGenerate a list of 5-10 hypothetical APA references for a research paper on "${topic}". Format them in markdown using bullet points.`,
//         name: 'references'
//       }
//     ];

//     const sectionFiles = [];

//     for (const [index, prompt] of prompts.entries()) {
//       const sectionNum = index + 1;
//       console.log(`\n🧠 Generating Section ${sectionNum}: ${prompt.name}`);

//       const context = conversationHistory
//         .filter(msg => msg.role === 'assistant')
//         .slice(-2)
//         .map(msg => msg.content)
//         .join('\n');

//       const fullPrompt = sectionNum === 1 ? prompt.text : `${prompt.text}\n\nEarlier context:\n${context}`;

//       const sectionPath = await generateSection(fullPrompt, sectionNum, prompt.name);
//       sectionFiles.push(sectionPath);
//     }

//     const combinedContent = combineSections(sectionFiles);

//     const safeTopic = topic.slice(0, 20).replace(/\s+/g, "_");
//     const fileName = `research_${userId}_${safeTopic}.pdf`;
//     const outputDir = path.join(__dirname, '../pdfs');
//     if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir);
//     const outputPath = path.join(outputDir, fileName);

//     await generatePDF(combinedContent, outputPath);

//     sectionFiles.forEach(deleteFile);

//     console.log(`\n✅ Research paper complete. Output: ${outputPath}`);
//     return outputPath;

//   } catch (error) {
//     console.error('❌ Research paper generation failed:', error);
//     throw error;
//   }
// }




// export async function generateResearchPaperLong(topic, pageLength = 50) {
//   try {
//     conversationHistory = [{
//       role: "system",
//       content:
//         "You are Hailu, an expert researcher. You specialize in writing detailed, academic research papers with at least 300 words per section. Generate a research paper on the given topic with the following structure: Abstract, Introduction, Methodology, Findings (split into parts for long papers), Discussion, Conclusion, References. Use an academic tone, avoid speculation, and include plausible examples relevant to the topic. For References, generate 5-10 hypothetical APA sources. And don't forget to be creative with the paper"
//     }];

//     const totalWords = pageLength * 650;
//     const findingsWords = Math.floor(totalWords * 0.5);
//     const findingsParts = Math.ceil(findingsWords / 1500);
//     const findingsWordsPerPart = Math.floor(findingsWords / findingsParts);

//     const prompts = [
//       {
//         text: `# Abstract\n\nWrite a 300-word abstract for a research paper on "${topic}" but first Start with give the reserch paper a topic. Summarize the purpose, methods, key findings, and conclusion in markdown.`,
//         name: 'abstract'
//       },
//       {
//         text: `# Introduction\n\nWrite a 650-word introduction for a research paper on "${topic}". Include background, problem statement, objectives, and significance.`,
//         name: 'introduction'
//       },
//       {
//         text: `# Methodology\n\nWrite a 1500-word methodology section for a research paper on "${topic}". Use subheadings like "## Data Collection", "## Analysis Techniques", etc.`,
//         name: 'methodology'
//       },
//       {
//         text: `# Findings\n\nWrite the findings section for a research paper on "${topic}". Present key findings with examples. Use markdown.`,
//         name: `findings-part`
//       },
//       {
//         text: `# Findings\n\nWrite the other findings section for a research paper on "${topic}" which you didn't find on the first findings. Present key findings with examples and give it topic of other findings. Use proper markdown. AND REMEMBER TO AVOIDE ANY KIND OF REPITION.`,
//         name: `findings-part-1`
//       },
//       {
//         text: `# Findings\n\nWrite the other findings section for a research paper on "${topic}" which you didn't find on the first and the second findings. Present key findings with examples and give it topic of other findings. Use proper markdown. AND REMEBER TO AVOIDE ANY KIND OF REPITION. And present them as Last findings.`,
//         name: `findings-part-2`
//       },
//       {
//         text: `# Discussion\n\nWrite a 1500-word discussion section for a research paper on "${topic}", analyzing findings, implications, and limitations.`,
//         name: 'discussion'
//       },
//       {
//         text: `# Conclusion\n\nWrite a 650-word conclusion for a research paper on "${topic}", summarizing key points and suggesting future research.`,
//         name: 'conclusion'
//       },
//       {
//         text: `# References\n\nGenerate a list of 5-10 hypothetical APA references for a research paper on "${topic}". Format them in markdown using bullet points.`,
//         name: 'references'
//       }
//     ];

//     const sectionFiles = [];
//     for (const [index, prompt] of prompts.entries()) {
//       const sectionNum = index + 1;
//       console.log(`\nGenerating Section ${sectionNum}: ${prompt.name}`);
//       const fullPrompt = sectionNum > 1 
//         ? `${prompt.text}\n\nPrevious sections for context:\n${conversationHistory.filter(msg => msg.role === 'assistant').slice(-2).map(msg => msg.content).join('\n')}`
//         : prompt.text;
//       sectionFiles.push(await generateSection(fullPrompt, sectionNum, prompt.name));
//     }

//     const combinedContent = combineSections(sectionFiles);
//     await generatePDF(combinedContent, OUTPUT_PDF);

//     sectionFiles.forEach(deleteFile);

//     console.log(`\nResearch paper generation complete. Output: ${OUTPUT_PDF}`);
//     return OUTPUT_PDF;
//   } catch (error) {
//     console.error('Research paper generation failed:', error);
//     throw error;
//   }
// }
