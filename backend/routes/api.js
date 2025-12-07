import express from 'express';
import {
  generateBookSmall,
  generateBookMed,
  generateBookLong,
  generateResearchPaper,
  generateResearchPaperLong,
  getUserDocuments,
  deleteUserDocument,
  generateShareLink,
  getSharedDocument
} from '../controllers/documentController.js';

const router = express.Router();

router.post('/generateBookSmall', generateBookSmall);
router.post('/generateBookMed', generateBookMed);
router.post('/generateBookLong', generateBookLong);
router.post('/generateResearchPaper', generateResearchPaper);
router.post('/generateResearchPaperLong', generateResearchPaperLong);

router.get('/documents/:userId', getUserDocuments);
router.delete('/documents/:documentId', deleteUserDocument);
router.post('/documents/:documentId/share', generateShareLink);
router.get('/share/:token', getSharedDocument);

router.post('/cancelGeneration', (req, res) => {
  const { userId } = req.body;
  global.cancelFlags = global.cancelFlags || {};
  global.cancelFlags[userId] = true;
  console.log(`Cancel requested for user: ${userId}`);
  res.status(200).json({ success: true });
});

export default router;
