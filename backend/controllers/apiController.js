import fs from 'fs';
import path from 'path';
import { generateBookS } from '../AI/SB.js';
import { generateBookMedd } from '../AI/MB.js';
import { generateBookL } from '../AI/LB.js';
import { generateResearchPaperS } from '../test/RS.js';
import { generateResearchPaperLong } from '../test/RL.js';

export async function generateBookSmall(req, res) {
  try {
    const { prompt, userId } = req.body;
    console.log("📨 Small Book Request from", userId, ":", prompt);

    const pdfPath = await generateBookS(prompt, userId);

    if (!fs.existsSync(pdfPath)) {
      return res.status(500).json({ error: 'PDF generation failed' });
    }

    res.download(pdfPath, 'book.pdf', (err) => {
      if (err) {
        console.error('Error sending PDF:', err);
        if (!res.headersSent) res.sendStatus(500);
      }
      fs.unlink(pdfPath, (unlinkErr) => {
        if (unlinkErr) console.error('Error deleting PDF:', unlinkErr);
      });
    });

  } catch (error) {
    console.error('PDF generation error:', error);
    res.status(500).json({ error: 'Failed to generate PDF' });
  }
}

export async function generateBookMed(req, res) {
  try {
    const { prompt, userId } = req.body;
    console.log("📨 Medium Book Request from", userId, ":", prompt);

    const pdfPath = await generateBookMedd(prompt, userId);

    if (!fs.existsSync(pdfPath)) {
      return res.status(500).json({ error: 'PDF generation failed' });
    }

    res.download(pdfPath, 'book.pdf', (err) => {
      if (err) {
        console.error('Error sending PDF:', err);
        if (!res.headersSent) res.sendStatus(500);
      }
      fs.unlink(pdfPath, (unlinkErr) => {
        if (unlinkErr) console.error('Error deleting PDF:', unlinkErr);
      });
    });

  } catch (error) {
    console.error('PDF generation error:', error);
    res.status(500).json({ error: 'Failed to generate PDF' });
  }
}

export async function generateBookLong(req, res) {
  try {
    const { prompt, userId } = req.body;
    console.log("📨 Long Book Request from", userId, ":", prompt);

    const pdfPath = await generateBookL(prompt, userId);

    if (!fs.existsSync(pdfPath)) {
      return res.status(500).json({ error: 'PDF generation failed' });
    }

    res.download(pdfPath, 'book.pdf', (err) => {
      if (err) {
        console.error('Error sending PDF:', err);
        if (!res.headersSent) res.sendStatus(500);
      }
      fs.unlink(pdfPath, (unlinkErr) => {
        if (unlinkErr) console.error('Error deleting PDF:', unlinkErr);
      });
    });

  } catch (error) {
    console.error('PDF generation error:', error);
    res.status(500).json({ error: 'Failed to generate PDF' });
  }
}

export async function generateResearchPaper(req, res) {
  try {
    const { prompt, userId } = req.body;
    console.log("📨 Research Paper Request from", userId, ":", prompt);

    const pdfPath = await generateResearchPaperS(prompt, userId);

    if (!fs.existsSync(pdfPath)) {
      return res.status(500).json({ error: 'PDF generation failed' });
    }

    res.download(pdfPath, 'research-paper.pdf', (err) => {
      if (err) {
        console.error('Error sending PDF:', err);
        if (!res.headersSent) res.sendStatus(500);
      }
      fs.unlink(pdfPath, (unlinkErr) => {
        if (unlinkErr) console.error('Error deleting PDF:', unlinkErr);
      });
    });

  } catch (error) {
    console.error('Research paper generation error:', error);
    res.status(500).json({ error: 'Failed to generate research paper' });
  }
}

export async function generateResearchPaperLong(req, res) {
  try {
    const { prompt, userId } = req.body;
    console.log("📨 Long Research Paper Request from", userId, ":", prompt);

    const pdfPath = await generateResearchPaperLong(prompt, userId);

    if (!fs.existsSync(pdfPath)) {
      return res.status(500).json({ error: 'PDF generation failed' });
    }

    res.download(pdfPath, 'research-paper.pdf', (err) => {
      if (err) {
        console.error('Error sending PDF:', err);
        if (!res.headersSent) res.sendStatus(500);
      }
      fs.unlink(pdfPath, (unlinkErr) => {
        if (unlinkErr) console.error('Error deleting PDF:', unlinkErr);
      });
    });

  } catch (error) {
    console.error('Research paper generation error:', error);
    res.status(500).json({ error: 'Failed to generate research paper' });
  }
}
