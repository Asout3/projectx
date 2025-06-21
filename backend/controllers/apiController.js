const fs = require('fs');
const path = require('path');
const { generateBookS } = require('../AI/SB');
const { generateBookMed } = require('../AI/MB');
const { generateBookL } = require('../AI/LB');
const { generateResearchPaper } = require('../test/RS');
const { generateResearchPaperLong } = require('../test/RL');

exports.generateBookSmall = async (req, res) => {
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
};

exports.generateBookMed = async (req, res) => {
  try {
    const { prompt, userId } = req.body;
    console.log("📨 Medium Book Request from", userId, ":", prompt);

    const pdfPath = await generateBookMed(prompt, userId);

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
};

exports.generateBookLong = async (req, res) => {
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
};

exports.generateResearchPaper = async (req, res) => {
  try {
    const { prompt, userId } = req.body;
    console.log("📨 Research Paper Request from", userId, ":", prompt);

    const pdfPath = await generateResearchPaper(prompt, userId);

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
};

exports.generateResearchPaperLong = async (req, res) => {
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
};
