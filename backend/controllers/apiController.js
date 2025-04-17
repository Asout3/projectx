const askAI = require('../AI/ai'); // Import the function
// apis that can be use for testing we can only use one post request 

exports.sendData = async (req, res) => {
  
  const UserPrompt = req.body.prompt;

  try {
    const reply = await askAI(UserPrompt); 
    console.log("ai : this time bitch", reply);
    res.json({ reply });

  } catch (err) {
    res.status(500).json({ error: 'Failed to get AI response' });
  }

};
  