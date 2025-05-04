// controllers/apiController.js
const fs = require('fs');
const path = require('path');
const { generateBook } = require('../AI/ai'); // or wherever your PDF-gen logic lives

exports.generateBookPDF = async (req, res) => {
  try {
    // 1) Generate the PDF and get back its filepath
    const pdfPath = await generateBook(req.body.prompt);
    if (!fs.existsSync(pdfPath)) {
      return res.status(500).json({ error: 'PDF generation failed' });
    }

    // 2) Download it—Express will set Content-Type and Content-Disposition
    res.download(pdfPath, 'book.pdf', (err) => {
      if (err) {
        console.error('Error sending PDF:', err);
        // If headers already sent, cannot change status; otherwise:
        if (!res.headersSent) res.sendStatus(500);
      }
      // 3) Cleanup the file once the response is done
      fs.unlink(pdfPath, (unlinkErr) => {
        if (unlinkErr) console.error('Error deleting PDF:', unlinkErr);
      });
    });

  } catch (error) {
    console.error('PDF generation error:', error);
    res.status(500).json({ error: 'Failed to generate PDF' });
  }
};

