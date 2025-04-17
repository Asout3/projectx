const axios = require('axios'); // for fetching data
const fs = require('fs');

const OPENROUTER_API_KEY = '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'; // api key from open router
const HISTORY_FILE = 'history.json';  // File to store chat history

// Load conversation history from file (or create empty)
async function askAI(UserPrompt) {
let conversationHistory = [];
try {
    const data = fs.readFileSync(HISTORY_FILE, 'utf8');
    conversationHistory = JSON.parse(data);
} catch (err) {
    console.log('No history found. Starting fresh.');
}

async function callOpenRouterAPI(prompt) {
    const url = 'https://openrouter.ai/api/v1/chat/completions';
    const headers = {
        'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
        'HTTP-Referer': 'https://your-site-url.com',
        'X-Title': 'Your Site Name',
        'Content-Type': 'application/json',
    };

    // Add user message to history
    conversationHistory.push({ role: 'user', content: prompt });

    const data = {
        model: 'deepseek/deepseek-r1-distill-llama-70b:free',
        messages: conversationHistory,
    };

    try {
        const response = await axios.post(url, data, { headers });

        // Log the full response for debugging
        console.log('API Response:', response.data);

        // Check if the response contains the expected structure
        if (
            !response.data ||
            !response.data.choices ||
            response.data.choices.length === 0 ||
            !response.data.choices[0].message
        ) {
            throw new Error('Invalid API response structure');
        }

        const reply = response.data.choices[0].message.content;

        // Add AI reply to history
        conversationHistory.push({ role: 'assistant', content: reply });

        // Save updated history to file
        fs.writeFileSync(HISTORY_FILE, JSON.stringify(conversationHistory));

        console.log('AI:', reply);
        return reply;
    } catch (error) {
        // Log the error and the response (if available)
        console.error('API Error:', error.response?.data || error.message);
        throw new Error('Failed to fetch data from OpenRouter API');
    }
}

async function testBackend() {
    const what = UserPrompt;
   

    try {
        // Step 1: Call the OpenRouter API
        console.log('Calling OpenRouter API...');
        const generatedText = await callOpenRouterAPI(what);
        //console.log('Generated Text:', generatedText);

        console.log('Backend test completed successfully!');
        console.log("here is the main: ", generatedText);
    } catch (error) {
        console.error('Backend test failed:', error);
    }
}

// Run the test
testBackend();

}

askAI('What is the capital of France?'); // Example prompt to test the function

module.exports = askAI;