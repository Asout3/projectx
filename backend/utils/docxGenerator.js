import { Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType } from 'docx';
import { marked } from 'marked';
import fs from 'fs';

function parseMarkdownToDocx(markdown) {
  const tokens = marked.lexer(markdown);
  const children = [];

  for (const token of tokens) {
    switch (token.type) {
      case 'heading':
        children.push(
          new Paragraph({
            text: token.text,
            heading: token.depth === 1 ? HeadingLevel.HEADING_1 :
                    token.depth === 2 ? HeadingLevel.HEADING_2 :
                    token.depth === 3 ? HeadingLevel.HEADING_3 : HeadingLevel.HEADING_4,
            spacing: {
              before: 400,
              after: 200,
            },
          })
        );
        break;

      case 'paragraph':
        const runs = parseInlineMarkdown(token.text);
        children.push(
          new Paragraph({
            children: runs,
            spacing: {
              after: 200,
            },
            alignment: AlignmentType.JUSTIFIED,
          })
        );
        break;

      case 'code':
        children.push(
          new Paragraph({
            children: [
              new TextRun({
                text: token.text,
                font: 'Courier New',
                size: 20,
              }),
            ],
            spacing: {
              before: 200,
              after: 200,
            },
            shading: {
              fill: 'F5F5F5',
            },
          })
        );
        break;

      case 'list':
        for (const item of token.items) {
          children.push(
            new Paragraph({
              text: item.text.replace(/<[^>]*>/g, ''),
              bullet: {
                level: 0,
              },
              spacing: {
                after: 100,
              },
            })
          );
        }
        break;

      case 'blockquote':
        children.push(
          new Paragraph({
            text: token.text.replace(/<[^>]*>/g, ''),
            italics: true,
            spacing: {
              before: 200,
              after: 200,
              left: 720,
            },
            shading: {
              fill: 'E8E8E8',
            },
          })
        );
        break;

      case 'space':
        children.push(new Paragraph({ text: '' }));
        break;

      default:
        if (token.text) {
          children.push(
            new Paragraph({
              text: token.text.replace(/<[^>]*>/g, ''),
              spacing: {
                after: 200,
              },
            })
          );
        }
    }
  }

  return children;
}

function parseInlineMarkdown(text) {
  const runs = [];
  const regex = /(\*\*|__)(.*?)\1|(\*|_)(.*?)\3|(`)(.*?)\5/g;
  let lastIndex = 0;
  let match;

  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      runs.push(new TextRun(text.substring(lastIndex, match.index)));
    }

    if (match[1]) {
      runs.push(new TextRun({ text: match[2], bold: true }));
    } else if (match[3]) {
      runs.push(new TextRun({ text: match[4], italics: true }));
    } else if (match[5]) {
      runs.push(new TextRun({ text: match[6], font: 'Courier New' }));
    }

    lastIndex = regex.lastIndex;
  }

  if (lastIndex < text.length) {
    runs.push(new TextRun(text.substring(lastIndex)));
  }

  return runs.length > 0 ? runs : [new TextRun(text.replace(/<[^>]*>/g, ''))];
}

export async function generateDocx(markdown, outputPath) {
  const sections = parseMarkdownToDocx(markdown);

  const doc = new Document({
    sections: [
      {
        properties: {},
        children: sections,
      },
    ],
  });

  const buffer = await Packer.toBuffer(doc);
  fs.writeFileSync(outputPath, buffer);

  return outputPath;
}
