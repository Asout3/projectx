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

export default router;
