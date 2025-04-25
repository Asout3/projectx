'use client';

import { useState } from 'react';
import axios from 'axios';

const api = axios.create({
  baseURL: "https://projectx-c5md.onrender.com", // e.g. https://projectx-c5md.onrender.com
  headers: {
    'Content-Type': 'application/json'
  }
});

export default function PromptSender() {
  const [prompt, setPrompt] = useState('');
  const [response, setResponse] = useState('');
  const [isGeneratingPDF, setIsGeneratingPDF] = useState(false);
  const [pdfProgress, setPdfProgress] = useState(0);

  const sendPrompt = async () => {
    if (!prompt.trim()) {
      setResponse('⚠️ Please enter a prompt first.');
      return;
    }
    try {
      const { data } = await api.post('/api/data', { prompt });
      setResponse(data.reply);
    } catch (err) {
      console.error(err);
      setResponse('❌ Failed to get AI response.');
    }
  };

  const generateAndDownloadPDF = async () => {
    if (!prompt.trim()) {
      setResponse('⚠️ Please enter a prompt first.');
      return;
    }
    setIsGeneratingPDF(true);
    setPdfProgress(0);

    try {
      const res = await api.post(
        '/api/generateBookPDF',
        { prompt },
        {
          responseType: 'blob',
          onDownloadProgress: (e) => {
            const total = e.total ?? 1_000_000; 
            setPdfProgress(Math.min(100, Math.round((e.loaded * 100) / total)));
          }
        }
      );

      const blob = new Blob([res.data], { type: 'application/pdf' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `${prompt.slice(0,20).replace(/\s+/g,'_') || 'book'}.pdf`;
      link.click();
      URL.revokeObjectURL(url);
    } catch (err: any) {
      console.error(err);
      if (err.isAxiosError && err.response?.status === 0) {
        setResponse('❌ CORS/network issue – could not connect to server.');
      } else {
        setResponse('❌ PDF generation failed.');
      }
    } finally {
      setIsGeneratingPDF(false);
    }
  };

  return (
    <div className="max-w-2xl mx-auto p-4">
      <textarea
        className="w-full p-3 border rounded-lg mb-3"
        rows={5}
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        placeholder="E.g., 'hahaha'"
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
          {isGeneratingPDF
            ? `Generating PDF (${pdfProgress}%)`
            : 'Download Full Guide (PDF)'}
        </button>
      </div>

      {response && (
        <div className="p-4 bg-gray-100 rounded-lg whitespace-pre-wrap">
          <h2 className="font-bold mb-2">AI Response</h2>
          <p>{response}</p>
        </div>
      )}
    </div>
  );
}
