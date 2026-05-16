const PLACEHOLDER_PREFIX = '__BOOKGEN_PROTECTED_BLOCK_';

function protectSegments(content, patterns) {
  const protectedSegments = [];
  let output = content;

  for (const pattern of patterns) {
    output = output.replace(pattern, (match) => {
      const token = `${PLACEHOLDER_PREFIX}${protectedSegments.length}__`;
      protectedSegments.push(match);
      return token;
    });
  }

  return {
    content: output,
    restore: (value) => value.replace(new RegExp(`${PLACEHOLDER_PREFIX}(\\d+)__`, 'g'), (_, index) => protectedSegments[Number(index)] || '')
  };
}

export function normalizeMathMarkdown(content = '') {
  if (!content) return '';

  const { content: protectedContent, restore } = protectSegments(content, [
    /```[\s\S]*?```/g,
    /`[^`\n]+`/g,
    /(^\|.+\|[\s]*\n^\|[-:\s|]+\|[\s]*\n(?:^\|.*\|[\s]*\n?)*)/gm
  ]);

  let normalized = protectedContent
    .replace(/\r\n/g, '\n')
    .replace(/\\\[([\s\S]*?)\\\]/g, (_, math) => `\n\n$$\n${math.trim()}\n$$\n\n`)
    .replace(/\\\(([\s\S]*?)\\\)/g, (_, math) => `$${math.trim()}$`)
    .replace(/\$\$\s*([\s\S]*?)\s*\$\$/g, (_, math) => `\n\n$$\n${math.trim()}\n$$\n\n`)
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return restore(normalized);
}

export function buildMarkdownTableOfContents(chapterInfos = []) {
  const chapterLines = chapterInfos.map((chapter, index) => {
    const chapterNumber = index + 1;
    const subtopics = (chapter.subtopics || [])
      .map((subtopic) => `   - ${subtopic}`)
      .join('\n');

    return `**Chapter ${chapterNumber}: ${chapter.title}**\n${subtopics}`;
  });

  return `# Table of Contents\n\n${chapterLines.join('\n\n')}\n\n---\n`;
}

export function buildPlanContext(chapterInfos = [], currentIndex = 0) {
  const overview = chapterInfos
    .map((chapter, index) => `${index + 1}. ${chapter.title}`)
    .join('\n');

  const previous = chapterInfos
    .slice(Math.max(0, currentIndex - 2), currentIndex)
    .map((chapter, offset) => `${currentIndex - Math.min(2, currentIndex) + offset + 1}. ${chapter.title}`)
    .join('\n') || 'None';

  const upcoming = chapterInfos
    .slice(currentIndex + 1, currentIndex + 3)
    .map((chapter, offset) => `${currentIndex + offset + 2}. ${chapter.title}`)
    .join('\n') || 'None';

  return { overview, previous, upcoming };
}

export function buildTOCPrompt(bookTopic, chapterCount, mode = 'professional') {
  const depth = mode === 'comprehensive'
    ? 'Build a complete beginner-to-advanced learning path with clear progression and no repeated concepts.'
    : 'Build a coherent learning path with clear progression and no repeated concepts.';

  return `Create a professional table of contents for a book about "${bookTopic}".
${depth}

REQUIREMENTS (FOLLOW EXACTLY):
- Output EXACTLY ${chapterCount} chapters.
- Use this exact chapter heading format: "Chapter X: Descriptive Title".
- Follow each chapter title with 4-6 focused subtopics, each indented exactly like: "   - Subtopic".
- Every chapter must have a unique purpose; do not duplicate chapter ideas or subtopics.
- Sequence the chapters so each chapter builds on previous chapters and prepares the next chapter.
- Include theory, worked examples, pitfalls, real-world application, and advanced/future topics where appropriate.
- Do not invent citations in the table of contents.
- Output only the table of contents. No preface, no markdown fences, no commentary.`;
}

export function buildChapterPrompt({
  bookTopic,
  chapterNumber,
  chapterInfo,
  chapterInfos,
  targetWords = 1200,
  resourceCount = 3,
  includeExercises = false
}) {
  const context = buildPlanContext(chapterInfos, chapterNumber - 1);
  const subtopicList = (chapterInfo.subtopics || []).map((subtopic) => `- ${subtopic}`).join('\n');
  const exerciseSection = includeExercises
    ? '- Include a final "### Practice Exercises" section with 4-6 progressively harder questions.\n- Include a final "### Mini-Project or Application Challenge" section with one hands-on task.'
    : '- Include a final "### Practice Check" section with 2-3 reflection questions.';

  return `Write Chapter ${chapterNumber}: "${chapterInfo.title}" for a professional educational book about "${bookTopic}".

BOOK-WIDE PLAN:
${context.overview}

CONTINUITY RULES:
- Previous nearby chapters:\n${context.previous}
- Upcoming nearby chapters:\n${context.upcoming}
- This chapter must connect to the overall plan without repeating earlier chapters or stealing topics from later chapters.
- If a fact is uncertain or date-sensitive, qualify it instead of presenting it as guaranteed.
- Do not fabricate citations, statistics, quotes, URLs, or source names.

FORMATTING RULES:
- Start with exactly one heading: "## ${chapterInfo.title}".
- Use "###" for every subsection.
- Use strict GitHub Markdown tables only when a table genuinely improves clarity.
- Use LaTeX for math: inline math as $...$ and display math as $$...$$. Preserve symbols such as \\alpha, \\beta, \\sum, \\int, \\frac{}, \\leq, \\geq, \\in, \\wedge, and \\rightarrow.
- Do not use HTML tags.
- Target at least ${targetWords} words.

VISUALS AND DIAGRAMS:
- Add a Mermaid diagram only when it genuinely clarifies a process, architecture, relationship, or workflow.
- Mermaid code must be inside \`\`\`mermaid fences.
- Quote node labels that contain punctuation or parentheses, for example: A["User (Admin)"].
- Immediately after every Mermaid block add exactly one caption line: *Figure caption: Brief description of the diagram*.

MANDATORY STRUCTURE:
1. Overview: explain why this chapter matters and how it fits the book.
2. One "###" subsection for each required subtopic:\n${subtopicList}
3. Practical Application: a realistic example, workflow, or case study.
4. Common Pitfalls and Misconceptions: explain mistakes to avoid.
5. Key Takeaways: concise bullet points.
${exerciseSection}
6. Further Reading: ${resourceCount} credible resources. Only list well-known books, standards, papers, or websites you are confident exist; otherwise give general resource types instead of fake sources.

Output only the chapter content.`;
}

export function buildConclusionPrompt(bookTopic, chapterInfos = [], targetWords = 600) {
  const titles = chapterInfos.map((chapter, index) => `${index + 1}. ${chapter.title}`).join('\n');

  return `Write a professional conclusion for the book "${bookTopic}".

CHAPTERS TO SYNTHESIZE:
${titles}

REQUIREMENTS:
- Synthesize the book's main ideas instead of repeating chapter summaries.
- Explain how the chapters connect into one coherent learning journey.
- Include practical next steps for continued learning and application.
- Include a short caution that readers should verify AI-generated content and date-sensitive facts.
- Target about ${targetWords} words.
- Use clean Markdown with no HTML.

Output only the conclusion content.`;
}
