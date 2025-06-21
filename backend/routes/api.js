const express = require('express');
const router = express.Router();
//const { sendData } = require('../controllers/apiController');

//router.post('/data', sendData);

const { generateBookSmall, generateResearchPaper, generateBookMed, generateBookLong, generateResearchPaperLong } = require('../controllers/apiController');

//router.post('/data', sendData);

router.post('/generateBookSmall', generateBookSmall);
router.post('/generateResearchPaper', generateResearchPaper);
router.post('/generateBookMed', generateBookMed);
router.post('/generateBookLong', generateBookLong);
router.post('/generateResearchPaperLong', generateResearchPaperLong);

module.exports = router;
