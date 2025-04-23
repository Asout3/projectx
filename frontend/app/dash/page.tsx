'use client';

import { useState } from 'react';
import axios from 'axios';

export default function PromptSender() {
  const [prompt, setPrompt] = useState('');
  const [response, setResponse] = useState('');
  const [isGeneratingPDF, setIsGeneratingPDF] = useState(false);
  const [pdfProgress, setPdfProgress] = useState(0);

  const sendPrompt = async () => {
    try {
      const res = await axios.post('http://localhost:5000/api/data', { prompt });
      setResponse(res.data.reply);
    } catch (error) {
      setResponse('Error: Failed to get AI response.');
    }
  };

  const generateAndDownloadPDF = async () => {
    
    if (!prompt.trim()) {
      setResponse('Please enter a prompt first!');
      return;
    }

    setIsGeneratingPDF(true);
    setPdfProgress(0);

    try {
      const res = await axios.post(
        'http://localhost:5000/api/generateBookPDF',
        { prompt },
        {
          responseType: 'blob',
          onDownloadProgress: (e) => {
            const progress = Math.round((e.loaded * 100) / (e.total || 1000000));
            setPdfProgress(progress);
          },
        }
      );

      const url = window.URL.createObjectURL(new Blob([res.data]));
      const link = document.createElement('a');
      link.href = url;
      link.download = 'workout_guide.pdf';
      link.click();
      window.URL.revokeObjectURL(url);
    } catch (error) {
      if (axios.isAxiosError(error) && error.response && error.response.status === 0) {
        setResponse('Error: CORS issue - Failed to connect to server');
      } else {
        setResponse('Error: PDF generation failed.');
      }
      setResponse('Error: PDF generation failed.');
    } finally {
      setIsGeneratingPDF(false);
    }
  };

  return (
    <div className="max-w-2xl mx-auto p-4">
      <h1 className="text-2xl font-bold mb-4"></h1>
      
      <textarea
        className="w-full p-3 border rounded-lg mb-3"
        rows={5}
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        placeholder="E.g., '5-day workout plan with 3000-calorie meals'"
      />

      <div className="flex gap-2 mb-4">
        <button
          onClick={sendPrompt}
          className="bg-blue-500 hover:bg-blue-600 text-white px-4 py-2 rounded"
        >
          Get AI Advice
        </button>
        
        <button
          onClick={generateAndDownloadPDF}
          disabled={isGeneratingPDF}
          className="bg-green-500 hover:bg-green-600 text-white px-4 py-2 rounded disabled:opacity-50"
        >
          {isGeneratingPDF ? `Generating PDF (${pdfProgress}%)` : 'Download Full Guide (PDF)'} this is the btn lets see 
        </button>
      </div>

      {response && (
        <div className="p-4 bg-gray-100 rounded-lg whitespace-pre-wrap">
          <h2 className="font-bold mb-2">AI Response: bitch</h2>
          <p>{response}</p>
        </div>
      )}
    </div>
  );
}
