const express = require('express');
const router = express.Router();
//const { sendData } = require('../controllers/apiController');

//router.post('/data', sendData);

const { generateBookPDF } = require('../controllers/apiController');

//router.post('/data', sendData);
router.post('/generateBookPDF', generateBookPDF);

module.exports = router;
