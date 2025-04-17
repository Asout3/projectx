'use client';

import { useState } from 'react';
import axios from 'axios';
import Greet from '../../components/greet';

export default function PromptSender() {
  const [prompt, setPrompt] = useState('');
  const [response, setResponse] = useState('');

  const sendPrompt = async () => {
    try {
      const res = await axios.post('https://animated-parakeet-v6qgvrg4r59x2w4j5-5000.app.github.dev/api/data', {
        prompt: prompt,
      });
      setResponse(res.data.reply);
      console.log(res.data.reply);
    } catch (error) {
      console.error('Error sending prompt:', error);
      setResponse('Error sending prompt.');
    }
  };

  return (
    <div>
      <Greet />
      <textarea
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        placeholder="Type your prompt..."
      />
      <button onClick={sendPrompt}>Send</button>
      <p>Response: {response}</p>
    </div>
  );
}
