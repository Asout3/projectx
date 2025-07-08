import express from 'express';
import {
  generateBookSmall,
  generateResearchPaper,
  generateBookMed,
  generateBookLong,
  generateResearchPaperLong
} from '../controllers/apiController.js'; // Note the .js extension

const router = express.Router();

// Define routes
router.post('/generateBookSmall', generateBookSmall);
router.post('/generateResearchPaper', generateResearchPaper);
router.post('/generateBookMed', generateBookMed);
router.post('/generateBookLong', generateBookLong);
router.post('/generateResearchPaperLong', generateResearchPaperLong);
router.post('/cancelGeneration', (req, res) => {
  const { userId } = req.body;
  global.cancelFlags = global.cancelFlags || {};
  global.cancelFlags[userId] = true;
  console.log(`🛑 Cancel requested for user: ${userId}`);
  res.status(200).json({ success: true });
});


export default router;
