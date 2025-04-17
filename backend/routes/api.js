const express = require('express');
const router = express.Router();
const { sendData } = require('../controllers/apiController');

router.post('/data', sendData);



module.exports = router;
