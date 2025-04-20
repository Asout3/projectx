// File: controllers/apiController.js
const fs = require('fs');
const path = require('path');
const { askAI, generateBook } = require('../AI/ai');

exports.sendData = async (req, res) => {
  try {
    const reply = await askAI(req.body.prompt);
    res.json({ reply });
  } catch (err) {
    res.status(500).json({ error: 'Failed to get AI response' });
  }
};

exports.generateBookPDF = async (req, res) => {
  try {
    const pdfPath = await generateBook(req.body.prompt); // Pass user prompt
    
    if (!fs.existsSync(pdfPath)) {
      return res.status(500).json({ error: 'PDF generation failed' });
    }
    
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename=workout_guide.pdf');
    
    const fileStream = fs.createReadStream(pdfPath);
    fileStream.pipe(res);
    
    fileStream.on('end', () => {
      fs.unlinkSync(pdfPath); // Cleanup
    });
    res.status(200).json({ message: "Success" });
  } catch (err) {
    console.error('PDF error:', err);
    res.status(500).json({ error: 'Failed to generate PDF' });
  }
};